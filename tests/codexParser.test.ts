import { CodexParser } from '../src/core/parsers/codexParser';
import * as fs from 'fs';
import initSqlJs from 'sql.js';

jest.mock('fs', () => ({
    existsSync: jest.fn(() => true),
    promises: {
        readFile: jest.fn(),
        readdir: jest.fn()
    }
}));

jest.mock('sql.js', () => {
    return jest.fn();
});

describe('CodexParser', () => {
    let parser: CodexParser;
    let mockExecState: jest.Mock;
    let mockExecHistory: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        mockExecState = jest.fn();
        mockExecHistory = jest.fn();

        (initSqlJs as unknown as jest.Mock).mockResolvedValue({
            Database: jest.fn().mockImplementation((buf) => {
                // If it's state buf (1) or history buf (2)
                return {
                    exec: buf === 'state-db' ? mockExecState : mockExecHistory,
                    close: jest.fn()
                };
            })
        });

        (fs.promises.readFile as jest.Mock).mockImplementation(async (path: string) => {
            if (path.includes('state')) return 'state-db';
            if (path.includes('history')) return 'history-db';
            if (path.includes('.jsonl')) {
                const usage = { payload: { usage: { input_tokens: 50, output_tokens: 10 } } };
                return JSON.stringify({ type: "other" }) + '\n' + JSON.stringify({ type: "token_usage_record", ...usage }) + '\n';
            }
            return '';
        });

        (fs.promises.readdir as jest.Mock).mockResolvedValue(['session-thread123.jsonl']);

        parser = new CodexParser();
    });

    afterEach(() => {
        parser.stop();
    });

    it('should query sqlite and parse codex usage', async () => {
        let updates = 0;
        parser.onUpdate = () => updates++;

        mockExecState.mockReturnValue([
            { values: [['thread123', '/home/user/my-codex-project', Date.now(), 100]] }
        ]);
        mockExecHistory.mockReturnValue([
            { values: [['thread123', 500]] }
        ]);

        parser.start();
        
        await new Promise(resolve => setTimeout(resolve, 200));

        const usage = parser.getUsage();
        expect(usage.length).toBe(1);
        expect(usage[0].inputTokens).toBe(50);
        expect(usage[0].outputTokens).toBe(10);
        expect(usage[0].providerName).toContain('my-codex-project');
        expect(updates).toBeGreaterThan(0);
    });

    it('should detect usage changes', async () => {
        let call = 0;
        mockExecState.mockImplementation(() => {
            const val = call === 0 ? 100 : 200;
            call++;
            return [{ values: [['thread1', '/home/proj', Date.now(), val]] }];
        });
        mockExecHistory.mockReturnValue([]);
        (fs.promises.readdir as jest.Mock).mockResolvedValue([]);

        let updates = 0;
        parser.onUpdate = () => updates++;
        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        
        await (parser as any).pollDatabase();
        expect(updates).toBeGreaterThan(1);
    });

    it('should handle sqlite errors', async () => {
        mockExecState.mockImplementation(() => {
            throw new Error('Mock SQLite Error');
        });
        
        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(parser.getUsage()?.length || 0).toBe(0);
    });
});

