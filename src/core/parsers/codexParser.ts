import * as vscode from 'vscode';

import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs';
import initSqlJs from 'sql.js';
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
            
            const SQL = await initSqlJs({ 
                locateFile: () => {
                    const distPath = path.join(__dirname, 'sql-wasm.wasm');
                    if (fs.existsSync(distPath)) return distPath;
                    // Fallback for Jest tests running from src/
                    return path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
                } 
            });
            
            let stateDb: any;
            try {
                const stateBuf = await fs.promises.readFile(this.stateDbPath);
                stateDb = new SQL.Database(stateBuf);
            } catch (err) {
                // Ignore missing file
            }

            const newProjects = new Map<string, CodexProjectUsage>();
            const threadIds: string[] = [];

            if (stateDb) {
                const queryState = `SELECT id, cwd, updated_at_ms, tokens_used FROM threads WHERE updated_at_ms > ${activeThreshold};`;
                try {
                    const stateResult = stateDb.exec(queryState);
                    if (stateResult.length > 0) {
                        for (const row of stateResult[0].values) {
                            const threadId = row[0] as string;
                            const cwd = row[1] as string;
                            const lastUpdatedDb = (row[2] as number) || Date.now();
                            const totalTokens = (row[3] as number) || 0;
                            
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
                    }
                } finally {
                    stateDb.close();
                }
                
                if (threadIds.length > 0) {
                    let historyDb: any;
                    try {
                        const historyBuf = await fs.promises.readFile(this.dbPath);
                        historyDb = new SQL.Database(historyBuf);
                    } catch {
                        // Ignore
                    }

                    if (historyDb) {
                        try {
                            const idList = threadIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
                            const queryHistory = `SELECT thread_id, SUM(LENGTH(item_json)) FROM thread_items WHERE thread_id IN (${idList}) GROUP BY thread_id;`;
                            const historyResult = historyDb.exec(queryHistory);
                            
                            if (historyResult.length > 0) {
                                for (const row of historyResult[0].values) {
                                    const threadId = row[0] as string;
                                    const size = (row[1] as number) || 0;
                                    const p = newProjects.get(threadId);
                                    if (p) p.liveContextTokens = Math.floor(size / 4);
                                }
                            }
                        } catch {
                            // Ignore history DB errors
                        } finally {
                            historyDb.close();
                        }
                    }

                    for (const threadId of threadIds) {
                        try {
                            const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
                            const allFiles = await fs.promises.readdir(sessionsDir);
                            const suffix = `-${threadId}.jsonl`;
                            const matchedFiles = allFiles.filter(f => f.endsWith(suffix));
                            
                            if (matchedFiles.length > 0) {
                                const filePath = path.join(sessionsDir, matchedFiles[0]);
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const lines = fileContent.split('\n');
                                
                                const usageLines = lines.filter(line => line.includes('"type":"token_usage_record"'));
                                
                                if (usageLines.length > 0) {
                                    const data = JSON.parse(usageLines[usageLines.length - 1]);
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

