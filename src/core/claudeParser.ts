import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { GeminiParser } from './parsers/geminiParser';
import { CodexParser } from './parsers/codexParser';

export interface ProviderUsage {
    providerName: string;
    inputTokens: number;
    uncachedInputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUSD: number | null;
    lastUpdatedMs: number;
    liveUncachedTokens: number;
    liveCachedTokens: number;
}

type ClaudeFileState = {
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    pending: string;
    usage: {
        input: number;
        cached: number;
        output: number;
        cost: number;
        hasCost: boolean;
        hasCostSnapshot: boolean;
        assistantAfterCost: { input: number; cached: number; output: number };
        liveUncached: number;
        liveCached: number;
        hasLive: boolean;
        lastMessageMs: number;
    };
};

type ClaudeProjectFile = {
    path: string;
    project: string;
    state: ClaudeFileState;
};

export interface AISessionMetrics {
    totalCostUSD: number;
    hasUnpricedProviders?: boolean;
    inputTokens: number;
    uncachedInputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalLiveContext: number;
    providerBreakdown: ProviderUsage[];
}

export class ClaudeParser {
    private currentMetrics: AISessionMetrics = { totalCostUSD: 0, inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalLiveContext: 0, providerBreakdown: [] };
    private geminiParser = new GeminiParser();
    private codexParser = new CodexParser();
    private claudeFiles = new Map<string, ClaudeProjectFile>();
    private pollInterval: NodeJS.Timeout | null = null;
    private scanningClaude = false;
    private stopped = false;
    private claudeRescanRequested = false;
    public onMetricsUpdated: ((metrics: AISessionMetrics) => void) | null = null;

    constructor(private readonly claudeBaseDir = path.join(os.homedir(), '.claude', 'projects')) {
        this.geminiParser.onUpdate = () => this.aggregateMetrics();
        this.codexParser.onUpdate = () => this.aggregateMetrics();
    }

    public start() {
        this.stopped = false;
        this.geminiParser.start();
        this.codexParser.start();
        void this.parseAllClaudeFiles();
        this.pollInterval = setInterval(() => void this.parseAllClaudeFiles(), 5000);
    }

    private async parseAllClaudeFiles() {
        if (this.stopped) return;
        if (this.scanningClaude) {
            this.claudeRescanRequested = true;
            return;
        }
        this.scanningClaude = true;
        this.claudeRescanRequested = false;
        let changed = false;
        try {
            const baseDir = this.claudeBaseDir;
            let projects: string[];
            try {
                projects = await fs.promises.readdir(baseDir);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[AI Session Metrics] Claude directory error:', error);
                changed = this.claudeFiles.size > 0;
                this.claudeFiles.clear();
                return;
            }
            const activePaths = new Set<string>();
            for (const project of projects) {
                const projectDir = path.join(baseDir, project);
                let projectStat: fs.Stats;
                try {
                    projectStat = await fs.promises.stat(projectDir);
                    if (!projectStat.isDirectory()) continue;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[AI Session Metrics] Claude project error:', error);
                    continue;
                }
                let files: string[];
                try {
                    files = (await fs.promises.readdir(projectDir)).filter(file => file.endsWith('.jsonl'));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[AI Session Metrics] Claude file listing error:', error);
                    continue;
                }
                for (const file of files) {
                    const fullPath = path.join(projectDir, file);
                    activePaths.add(fullPath);
                    try {
                        const stat = await fs.promises.stat(fullPath);
                        if (!stat.isFile()) continue;
                        const previous = this.claudeFiles.get(fullPath);
                        const sameFile = previous && previous.state.dev === stat.dev && previous.state.ino === stat.ino;
                        if (previous && sameFile && previous.state.size === stat.size && previous.state.mtimeMs === stat.mtimeMs) continue;
                        changed = true;
                        const append = previous && sameFile && stat.size >= previous.state.size;
                        const state: ClaudeFileState = previous && sameFile && stat.size === previous.state.size && stat.mtimeMs !== previous.state.mtimeMs
                            ? { ...previous.state, usage: { ...previous.state.usage, cost: 0, hasCost: false, hasCostSnapshot: false, assistantAfterCost: { input: 0, cached: 0, output: 0 } } }
                            : append ? previous.state : {
                            size: 0,
                            mtimeMs: 0,
                            dev: stat.dev,
                            ino: stat.ino,
                            pending: '',
                            usage: { input: 0, cached: 0, output: 0, cost: 0, hasCost: false, hasCostSnapshot: false, assistantAfterCost: { input: 0, cached: 0, output: 0 }, liveUncached: 0, liveCached: 0, hasLive: false, lastMessageMs: 0 }
                        };
                        const length = stat.size - state.size;
                        if (length > 0) {
                            const handle = await fs.promises.open(fullPath, 'r');
                            try {
                                const buffer = Buffer.alloc(length);
                                const { bytesRead } = await handle.read(buffer, 0, length, state.size);
                                const content = state.pending + buffer.toString('utf8', 0, bytesRead);
                                const lines = content.split('\n');
                                state.pending = lines.pop() ?? '';
                                for (const line of lines) this.parseClaudeLine(state.usage, line);
                            } finally {
                                await handle.close();
                            }
                        }
                        state.size = stat.size;
                        state.mtimeMs = stat.mtimeMs;
                        state.dev = stat.dev;
                        state.ino = stat.ino;
                        this.claudeFiles.set(fullPath, { path: fullPath, project, state });
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[AI Session Metrics] Claude transcript error:', error);
                        if (this.claudeFiles.delete(fullPath)) changed = true;
                    }
                }
            }
            for (const filePath of this.claudeFiles.keys()) {
                if (!activePaths.has(filePath)) {
                    this.claudeFiles.delete(filePath);
                    changed = true;
                }
            }
        } catch (error) {
            console.error('[AI Session Metrics] Claude parse error:', error);
        } finally {
            this.scanningClaude = false;
            if (changed && !this.stopped) this.aggregateMetrics();
            if (this.claudeRescanRequested && !this.stopped) void this.parseAllClaudeFiles();
        }
    }

    private parseClaudeLine(usage: ClaudeFileState['usage'], line: string) {
        if (!line.trim()) return;
        try {
            const data = JSON.parse(line);
            if (typeof data.timestamp === 'string') {
                const ms = new Date(data.timestamp).getTime();
                if (Number.isFinite(ms)) usage.lastMessageMs = Math.max(usage.lastMessageMs, ms);
            }
            if (data.type === 'assistant' && data.message?.usage) {
                const record = data.message.usage;
                const input = Number(record.input_tokens) || 0;
                const cached = (Number(record.cache_read_input_tokens) || 0) + (Number(record.cache_creation_input_tokens) || 0);
                const output = Number(record.output_tokens) || 0;
                usage.liveUncached = input;
                usage.liveCached = cached;
                usage.hasLive = true;
                if (usage.hasCostSnapshot) {
                    usage.hasCost = false;
                    usage.assistantAfterCost.input += input;
                    usage.assistantAfterCost.cached += cached;
                    usage.assistantAfterCost.output += output;
                } else {
                    usage.input += input;
                    usage.cached += cached;
                    usage.output += output;
                }
            } else if (data.type === 'cost-state' && data.modelUsage && typeof data.modelUsage === 'object') {
                const snapshot = { input: 0, cached: 0, output: 0, cost: 0 };
                const modelUsages = Object.values(data.modelUsage) as Array<Record<string, unknown>>;
                let hasCompleteCost = modelUsages.length > 0;
                for (const model of modelUsages) {
                    snapshot.input += Number(model.inputTokens) || 0;
                    snapshot.cached += (Number(model.cacheReadInputTokens) || 0) + (Number(model.cacheCreationInputTokens) || 0);
                    snapshot.output += Number(model.outputTokens) || 0;
                    if (typeof model.costUSD === 'number' && Number.isFinite(model.costUSD)) snapshot.cost += model.costUSD;
                    else hasCompleteCost = false;
                }
                usage.input = snapshot.input;
                usage.cached = snapshot.cached;
                usage.output = snapshot.output;
                usage.hasLive = true;
                usage.cost = snapshot.cost;
                usage.hasCost = hasCompleteCost;
                usage.hasCostSnapshot = true;
                usage.assistantAfterCost = { input: 0, cached: 0, output: 0 };
            }
        } catch {
            // Ignore malformed and incomplete JSONL records.
        }
    }

    private getClaudeUsage(): ProviderUsage[] {
        const config = vscode.workspace.getConfiguration('aiSessionMetrics');
        const claudeInputRate = config.get<number>('claude.inputCostPer1M', 3.00);
        const claudeOutputRate = config.get<number>('claude.outputCostPer1M', 15.00);
        
        const result: ProviderUsage[] = [];
        const activeThreshold = Date.now() - 10 * 60 * 1000;
        
        for (const file of this.claudeFiles.values()) {
            const u = file.state.usage;
            const updated = u.lastMessageMs || file.state.mtimeMs;
            if (updated < activeThreshold) continue;
            
            const project = file.project;
            const decoded = project.startsWith('-') ? project.substring(1).replace(/-/g, '/') : project;
            let projectName = path.basename(decoded);
            if (!projectName || projectName === '.') projectName = decoded;
            
            const shortHash = crypto.createHash('md5').update(file.path).digest('hex').slice(0, 4);
            projectName = `${projectName} - ${shortHash}`;
            
            const fileInput = u.input + u.assistantAfterCost.input;
            const fileCached = u.cached + u.assistantAfterCost.cached;
            const fileOutput = u.output + u.assistantAfterCost.output;
            
            let fileCost = u.cost;
            const knownCost = u.hasCost && u.hasCostSnapshot;
            if (!knownCost) {
                const extraInput = u.hasCostSnapshot ? u.assistantAfterCost.input + u.assistantAfterCost.cached : u.input + u.cached;
                const extraOutput = u.hasCostSnapshot ? u.assistantAfterCost.output : u.output;
                fileCost += (extraInput / 1000000) * claudeInputRate + (extraOutput / 1000000) * claudeOutputRate;
            }
            
            result.push({
                providerName: `Claude (${projectName})`,
                inputTokens: fileInput + fileCached,
                uncachedInputTokens: fileInput,
                cachedInputTokens: fileCached,
                outputTokens: fileOutput,
                costUSD: fileCost,
                lastUpdatedMs: updated,
                liveUncachedTokens: u.liveUncached,
                liveCachedTokens: u.liveCached
            });
        }
        return result;
    }

    private aggregateMetrics() {
        const config = vscode.workspace.getConfiguration('aiSessionMetrics');
        const allBreakdown: ProviderUsage[] = [];
        if (config.get<boolean>('claude.enabled', true)) allBreakdown.push(...this.getClaudeUsage());
        if (config.get<boolean>('gemini.enabled', true)) allBreakdown.push(...this.geminiParser.getUsage());
        if (config.get<boolean>('codex.enabled', true)) {
            const codexUsage = this.codexParser.getUsage();
            if (codexUsage) {
                if (Array.isArray(codexUsage)) {
                    allBreakdown.push(...codexUsage);
                } else {
                    allBreakdown.push(codexUsage as any);
                }
            }
        }

        const finalBreakdown = allBreakdown.filter(usage => Date.now() - usage.lastUpdatedMs < 10 * 60 * 1000);
        const hasUnpricedProviders = finalBreakdown.some(usage => usage.costUSD === null);
        const totalCostUSD = finalBreakdown.reduce((sum, usage) => sum + (usage.costUSD ?? 0), 0);

        this.currentMetrics = {
            totalCostUSD,
            hasUnpricedProviders,
            inputTokens: finalBreakdown.reduce((sum, usage) => sum + usage.inputTokens, 0),
            uncachedInputTokens: finalBreakdown.reduce((sum, usage) => sum + usage.uncachedInputTokens, 0),
            cachedInputTokens: finalBreakdown.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
            outputTokens: finalBreakdown.reduce((sum, usage) => sum + usage.outputTokens, 0),
            totalLiveContext: finalBreakdown.reduce((sum, usage) => sum + (usage.liveUncachedTokens || 0) + (usage.liveCachedTokens || 0), 0),
            providerBreakdown: finalBreakdown
        };
        this.onMetricsUpdated?.(this.currentMetrics);
    }

    public forceUpdate() {
        this.aggregateMetrics();
    }

    public stop() {
        this.stopped = true;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.geminiParser.stop();
        this.codexParser.stop();
    }
}
