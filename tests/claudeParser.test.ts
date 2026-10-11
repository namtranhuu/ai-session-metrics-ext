import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeParser } from '../src/core/claudeParser';
import { GeminiParser } from '../src/core/parsers/geminiParser';
import { CodexParser } from '../src/core/parsers/codexParser';

// Mock gemini and codex to avoid scanning user dirs
jest.mock('../src/core/parsers/geminiParser', () => {
    return {
        GeminiParser: jest.fn().mockImplementation(() => {
            return {
                start: jest.fn(),
                stop: jest.fn(),
                getUsage: jest.fn().mockReturnValue([]),
                onUpdate: null
            };
        })
    };
});
jest.mock('../src/core/parsers/codexParser', () => {
    return {
        CodexParser: jest.fn().mockImplementation(() => {
            return {
                start: jest.fn(),
                stop: jest.fn(),
                getUsage: jest.fn().mockReturnValue([]),
                onUpdate: null
            };
        })
    };
});

async function writeClaudeProject(baseDir: string, project: string, records: any[]) {
    const projectDir = path.join(baseDir, project);
    await fs.promises.mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, 'log-1.jsonl');
    const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.promises.writeFile(logPath, content, 'utf8');
    return logPath;
}

describe('ClaudeParser', () => {
    let root: string;
    let parser: ClaudeParser;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metrics-claude-'));
        parser = new ClaudeParser(root);
    });

    afterEach(async () => {
        parser.stop();
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it('should parse claude logs and aggregate metrics', async () => {
        const time = Date.now();
        await writeClaudeProject(root, 'proj1', [
            { timestamp: new Date(time).toISOString(), type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 2 } } }
        ]);

        let updates = 0;
        let lastMetrics: any;
        parser.onMetricsUpdated = (m) => {
            updates++;
            lastMetrics = m;
        };

        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(updates).toBeGreaterThan(0);
        expect(lastMetrics.providerBreakdown.length).toBe(1);
        expect(lastMetrics.providerBreakdown[0].inputTokens).toBe(10);
        expect(lastMetrics.providerBreakdown[0].outputTokens).toBe(2);
    });

    it('should deduplicate multiple chunks for the same message id', async () => {
        const time = Date.now();
        await writeClaudeProject(root, 'proj_dedup', [
            { timestamp: new Date(time).toISOString(), type: 'assistant', message: { id: 'msg_dedup_1', usage: { input_tokens: 15, output_tokens: 5 } } },
            { timestamp: new Date(time).toISOString(), type: 'assistant', message: { id: 'msg_dedup_1', usage: { input_tokens: 15, output_tokens: 5 } } },
            { timestamp: new Date(time).toISOString(), type: 'assistant', message: { id: 'msg_dedup_1', usage: { input_tokens: 15, output_tokens: 5 } } }
        ]);

        let updates = 0;
        let lastMetrics: any;
        parser.onMetricsUpdated = (m) => {
            updates++;
            lastMetrics = m;
        };

        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(updates).toBeGreaterThan(0);
        expect(lastMetrics.providerBreakdown.length).toBe(1);
        expect(lastMetrics.providerBreakdown[0].inputTokens).toBe(15);
        expect(lastMetrics.providerBreakdown[0].outputTokens).toBe(5);
    });
    it('should parse claude cost-state logs', async () => {
        const time = Date.now();
        await writeClaudeProject(root, 'proj2', [
            { type: 'cost-state', modelUsage: { 'modelA': { inputTokens: 50, outputTokens: 20, costUSD: 0.1 } } }
        ]);

        let updates = 0;
        parser.onMetricsUpdated = () => updates++;
        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(updates).toBeGreaterThan(0);
        const usage = parser['getClaudeUsage']();
        expect(usage.length).toBe(1);
        expect(usage[0].inputTokens).toBe(50);
        expect(usage[0].outputTokens).toBe(20);
    });
});
