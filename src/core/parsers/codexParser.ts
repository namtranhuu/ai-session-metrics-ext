import * as vscode from 'vscode';

import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { ProviderUsage } from '../claudeParser';

interface CodexProjectUsage {
    cwd: string;
    threadId: string;
    inputTokens: number;
    outputTokens: number;
    lastUpdatedMs: number;
    liveContextTokens: number;
}

export class CodexParser {
    private projects = new Map<string, CodexProjectUsage>();
    private dbPath: string;
    private stateDbPath: string;
    private intervalId: NodeJS.Timeout | null = null;
    private querying = false;
    private stopped = false;
    private queryGeneration = 0;
    private queryRequested = false;

    public onUpdate: (() => void) | null = null;

    constructor() {
        this.dbPath = path.join(os.homedir(), '.codex', 'thread_history_1.sqlite');
        this.stateDbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    }

    public start() {
        this.stopped = false;
        this.queryGeneration++;
        this.queryRequested = false;
        void this.pollDatabase();
        this.intervalId = setInterval(() => void this.pollDatabase(), 5000);
    }

    private async pollDatabase() {
        if (this.stopped) return;
        if (this.querying) {
            this.queryRequested = true;
            return;
        }
        this.querying = true;
        this.queryRequested = false;
        const generation = this.queryGeneration;
        try {
            const activeThreshold = Date.now() - 10 * 60 * 1000;
            const queryState = `SELECT id, cwd, updated_at_ms, tokens_used FROM threads WHERE updated_at_ms > ${activeThreshold};`;
            const stateResult = await new Promise<string>((resolve, reject) => {
                execFile('sqlite3', [this.stateDbPath, queryState], (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout.trim());
                });
            });
            
            const newProjects = new Map<string, CodexProjectUsage>();
            if (stateResult) {
                const lines = stateResult.split('\n');
                const threadIds: string[] = [];
                
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const parts = line.split('|');
                    const threadId = parts[0];
                    const cwd = parts[1];
                    const lastUpdatedDb = parseInt(parts[2], 10) || Date.now();
                    const totalTokens = parseInt(parts[3], 10) || 0;
                    
                    if (cwd && threadId) {
                        newProjects.set(threadId, {
                            cwd,
                            threadId,
                            inputTokens: Math.floor(totalTokens * 0.8),
                            outputTokens: Math.floor(totalTokens * 0.2),
                            lastUpdatedMs: lastUpdatedDb,
                            liveContextTokens: 0
                        });
                        threadIds.push(threadId);
                    }
                }
                
                if (threadIds.length > 0) {
                    try {
                        const idList = threadIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
                        const queryHistory = `SELECT thread_id, SUM(LENGTH(item_json)) FROM thread_items WHERE thread_id IN (${idList}) GROUP BY thread_id;`;
                        const historyResult = await new Promise<string>((resolve, reject) => {
                            execFile('sqlite3', [this.dbPath, queryHistory], (error, stdout) => {
                                if (error) reject(error);
                                else resolve(stdout.trim());
                            });
                        });
                        
                        for (const line of historyResult.split('\n')) {
                            if (!line.trim()) continue;
                            const parts = line.split('|');
                            const threadId = parts[0];
                            const size = parseInt(parts[1], 10) || 0;
                            const p = newProjects.get(threadId);
                            if (p) p.liveContextTokens = Math.floor(size / 4);
                        }
                    } catch {
                        // Ignore history DB errors
                    }

                    for (const threadId of threadIds) {
                        try {
                            const stdout = await new Promise<string>((resolve, reject) => {
                                execFile('find', [path.join(os.homedir(), '.codex', 'sessions'), '-type', 'f', '-name', `*-${threadId}.jsonl`], (error, out) => {
                                    if (error) reject(error);
                                    else resolve(out.trim());
                                });
                            });
                            const files = stdout.split('\n').filter(Boolean);
                            if (files.length > 0) {
                                const grepOut = await new Promise<string>((resolve, reject) => {
                                    execFile('grep', ['"type":"token_usage_record"', files[0]], (error, out) => {
                                        if (error) reject(error);
                                        else resolve(out.trim());
                                    });
                                });
                                const lines = grepOut.split('\n').filter(Boolean);
                                if (lines.length > 0) {
                                    const data = JSON.parse(lines[lines.length - 1]);
                                    const usage = data.payload?.thread_token_usage || data.payload?.usage;
                                    if (usage) {
                                        const p = newProjects.get(threadId);
                                        if (p) {
                                            const exactIn = (usage.input_tokens || 0) + (usage.cached_input_tokens || 0);
                                            const exactOut = usage.output_tokens || 0;
                                            p.inputTokens = exactIn;
                                            p.outputTokens = exactOut;
                                            p.liveContextTokens = exactIn; 
                                        }
                                    }
                                }
                            }
                        } catch {
                            // Ignore missing jsonl or grep failures
                        }
                    }
                }
            }

            if (!this.stopped && generation === this.queryGeneration) {
                let changed = false;
                if (this.projects.size !== newProjects.size) changed = true;
                else {
                    for (const [cwd, newUsage] of newProjects) {
                        const oldUsage = this.projects.get(cwd);
                        if (!oldUsage || 
                            oldUsage.inputTokens !== newUsage.inputTokens || 
                            oldUsage.outputTokens !== newUsage.outputTokens || 
                            oldUsage.lastUpdatedMs !== newUsage.lastUpdatedMs || 
                            oldUsage.liveContextTokens !== newUsage.liveContextTokens) {
                            changed = true;
                            break;
                        }
                    }
                }
                
                if (changed) {
                    this.projects = newProjects;
                    this.onUpdate?.();
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error('[AI Session Metrics] Codex database error:', error);
            }
        } finally {
            this.querying = false;
            if (this.queryRequested && !this.stopped) void this.pollDatabase();
        }
    }

    public getUsage(): ProviderUsage[] {
        const config = vscode.workspace.getConfiguration('aiSessionMetrics');
        const inputRate = config.get<number>('codex.inputCostPer1M', 2.5);
        const outputRate = config.get<number>('codex.outputCostPer1M', 10.0);
        
        const result: ProviderUsage[] = [];
        for (const [threadId, usage] of this.projects) {
            const costUSD = (usage.inputTokens / 1000000) * inputRate + (usage.outputTokens / 1000000) * outputRate;
            const baseName = path.basename(usage.cwd);
            
            // Differentiate active sessions with short hash of threadId
            const shortHash = crypto.createHash('md5').update(threadId).digest('hex').slice(0, 4);
            const displayName = `${baseName} - ${shortHash}`;

            result.push({
                providerName: `Codex (${displayName})`,
                inputTokens: usage.inputTokens,
                uncachedInputTokens: usage.inputTokens,
                cachedInputTokens: 0,
                outputTokens: usage.outputTokens,
                costUSD: costUSD,
                lastUpdatedMs: usage.lastUpdatedMs,
                liveUncachedTokens: usage.liveContextTokens,
                liveCachedTokens: 0
            });
        }
        return result;
    }

    public stop() {
        this.stopped = true;
        this.queryGeneration++;
        this.queryRequested = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}
