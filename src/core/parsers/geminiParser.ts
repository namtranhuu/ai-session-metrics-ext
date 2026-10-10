import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ProviderUsage } from '../claudeParser';

type SessionUsage = {
    projectKey: string;
    uncached: number;
    cached: number;
    out: number;
    lastUpdated: number;
    liveUncached: number;
    liveCached: number;
};

type FileState = {
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    pending: string;
    usage: SessionUsage;
};

export class GeminiParser {
    private sessions = new Map<string, FileState>();
    private brainDir: string;
    private projectNames = new Map<string, string>();
    private intervalId: NodeJS.Timeout | null = null;
    private scanning = false;
    private stopped = false;

    public onUpdate: (() => void) | null = null;

    constructor(brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain')) {
        this.brainDir = brainDir;
    }

    public start() {
        this.stopped = false;
        void this.parseAllFiles();
        this.intervalId = setInterval(() => void this.parseAllFiles(), 5000);
    }

    private async parseAllFiles() {
        if (this.scanning || this.stopped) return;
        this.scanning = true;
        try {
            let uuids: string[];
            try {
                uuids = await fs.promises.readdir(this.brainDir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    console.error('[AI Session Metrics] Gemini directory error:', error);
                }
                this.replaceSessions(new Map());
                this.projectNames.clear();
                return;
            }

            const activePaths = new Set<string>();
            for (const uuid of uuids) {
                const uuidDir = path.join(this.brainDir, uuid);
                const transcriptPath = path.join(uuidDir, '.system_generated', 'logs', 'transcript.jsonl');
                activePaths.add(transcriptPath);
                try {
                    const stat = await fs.promises.stat(transcriptPath);
                    if (!stat.isFile()) continue;
                    const previous = this.sessions.get(transcriptPath);
                    const isSameFile = previous && previous.dev === stat.dev && previous.ino === stat.ino;
                    if (previous && isSameFile && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;

                    let projectKey = this.projectNames.get(transcriptPath);
                    if (!projectKey || projectKey.startsWith('unknown:')) {
                        projectKey = await this.readProjectKey(uuidDir);
                        this.projectNames.set(transcriptPath, projectKey);
                    }

                    const isAppend = previous && isSameFile && stat.size >= previous.size;
                    const state = isAppend ? previous : {
                        size: 0,
                        mtimeMs: 0,
                        dev: stat.dev,
                        ino: stat.ino,
                        pending: '',
                        usage: {
                            projectKey,
                            uncached: 0,
                            cached: 0,
                            out: 0,
                            lastUpdated: 0,
                            liveUncached: 0,
                            liveCached: 0
                        }
                    };
                    if (isAppend) {
                        state.usage.projectKey = projectKey;
                    }
                    const bytesToRead = stat.size - state.size;
                    if (bytesToRead > 0) {
                        const file = await fs.promises.open(transcriptPath, 'r');
                        try {
                            const buffer = Buffer.alloc(bytesToRead);
                            const { bytesRead } = await file.read(buffer, 0, bytesToRead, state.size);
                            const content = state.pending + buffer.toString('utf8', 0, bytesRead);
                            const lines = content.split('\n');
                            state.pending = lines.pop() ?? '';
                            for (const line of lines) this.addLineUsage(state.usage, line, stat.mtimeMs);
                        } finally {
                            await file.close();
                        }
                    }
                    state.size = stat.size;
                    state.mtimeMs = stat.mtimeMs;
                    state.usage.lastUpdated = stat.mtimeMs;
                    state.dev = stat.dev;
                    state.ino = stat.ino;
                    this.sessions.set(transcriptPath, state);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        console.error(`[AI Session Metrics] Gemini transcript error:`, error);
                    }
                    this.sessions.delete(transcriptPath);
                }
            }
            for (const filePath of this.sessions.keys()) {
                if (!activePaths.has(filePath)) this.sessions.delete(filePath);
            }
            for (const filePath of this.projectNames.keys()) {
                if (!activePaths.has(filePath)) this.projectNames.delete(filePath);
            }
            this.notifyIfChanged();
        } catch (error) {
            console.error('[AI Session Metrics] Gemini parse error:', error);
        } finally {
            this.scanning = false;
        }
    }

    private async readProjectKey(uuidDir: string): Promise<string> {
        const transcriptFullPath = path.join(uuidDir, '.system_generated', 'logs', 'transcript_full.jsonl');
        try {
            const file = await fs.promises.open(transcriptFullPath, 'r');
            try {
                const buffer = Buffer.alloc(4096);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                const match = buffer.toString('utf8', 0, bytesRead).match(/(?:Active Document: |Other open documents:\\n- )(.*?)(?=\\n|\r?\n| \()/);
                if (match?.[1]) {
                    const documentPath = match[1].replace(/\\/g, '/');
                    let current = path.posix.dirname(documentPath);
                    let rootPath = current;
                    while (current !== '/' && current !== '.') {
                        try {
                            const stat = await fs.promises.stat(path.join(current, '.git'));
                            if (stat.isDirectory() || stat.isFile()) { // .git can be a file in submodules/worktrees
                                rootPath = current;
                                break;
                            }
                        } catch { /* ignore */ }
                        const next = path.posix.dirname(current);
                        if (next === current) break;
                        current = next;
                    }
                    return rootPath && rootPath !== '.' ? `path:${rootPath}` : 'Unknown';
                }
            } finally {
                await file.close();
            }
        } catch {
            // The full transcript is optional; retain the UUID-based fallback.
        }
        return `unknown:${path.basename(uuidDir).slice(0, 8)}`;
    }

    private addLineUsage(usage: SessionUsage, line: string, mtimeMs: number) {
        if (!line.trim()) return;
        try {
            const data = JSON.parse(line);
            if (typeof data.created_at === 'string') {
                const ms = new Date(data.created_at).getTime();
                if (Number.isFinite(ms)) usage.lastUpdated = Math.max(usage.lastUpdated, ms);
            }
            if (data.type !== 'PLANNER_RESPONSE') return;
            const input = Number(data.input_tokens) || 0;
            const cached = Number(data.cache_read_tokens) || 0;
            const output = Number(data.output_tokens) || 0;
            usage.uncached += input;
            usage.cached += cached;
            usage.out += output;
            usage.liveUncached = input;
            usage.liveCached = cached;
            if (!usage.lastUpdated) usage.lastUpdated = mtimeMs;
        } catch {
            // Ignore incomplete or malformed JSONL records.
        }
    }



    private snapshot(): string {
        return JSON.stringify([...this.sessions.entries()].map(([filePath, state]) => [
            filePath,
            state.size,
            state.mtimeMs,
            state.usage
        ]));
    }

    private lastSnapshot = '';

    private replaceSessions(next: Map<string, FileState>) {
        const changed = this.sessions.size !== next.size;
        this.sessions = next;
        if (changed) this.notifyIfChanged();
    }

    private notifyIfChanged() {
        const snapshot = this.snapshot();
        if (snapshot !== this.lastSnapshot) {
            this.lastSnapshot = snapshot;
            this.onUpdate?.();
        }
    }

    public getUsage(): ProviderUsage[] {
        const config = vscode.workspace.getConfiguration('aiSessionMetrics');
        const inputRate = config.get<number>('gemini.inputCostPer1M', 0.075);
        const outputRate = config.get<number>('gemini.outputCostPer1M', 0.3);
        
        const results: ProviderUsage[] = [];
        const activeThreshold = Date.now() - 10 * 60 * 1000;
        
        for (const [filePath, state] of this.sessions) {
            if (state.usage.lastUpdated < activeThreshold) continue;
            
            const projectKey = state.usage.projectKey;
            let displayName = projectKey.startsWith('path:') ? path.posix.basename(projectKey.slice(5)) : `Unknown (${projectKey.slice(8)})`;
            
            // Differentiate multiple active sessions for the same project using a short hash of the path
            const shortHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 4);
            displayName = `${displayName} - ${shortHash}`;

            const totalInput = state.usage.uncached + state.usage.cached;
            const costUSD = (totalInput / 1000000) * inputRate + (state.usage.out / 1000000) * outputRate;
            
            results.push({
                providerName: `Gemini (${displayName})`,
                inputTokens: totalInput,
                uncachedInputTokens: state.usage.uncached,
                cachedInputTokens: state.usage.cached,
                outputTokens: state.usage.out,
                costUSD: costUSD,
                lastUpdatedMs: state.usage.lastUpdated,
                liveUncachedTokens: state.usage.liveUncached,
                liveCachedTokens: state.usage.liveCached
            });
        }
        return results;
    }

    public stop() {
        this.stopped = true;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}
