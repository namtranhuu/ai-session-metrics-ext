import { CodexParser } from '../src/core/parsers/codexParser';

jest.mock('child_process', () => ({
    execFile: jest.fn((cmd, args, callback) => {
        if (cmd === 'sqlite3') {
            if (args[1].includes('SELECT id, cwd')) {
                // mock stateDb
                const active = Date.now();
                callback(null, `thread123|/home/user/my-codex-project|${active}|100\n`);
                return;
            } else if (args[1].includes('SUM(LENGTH')) {
                // mock historyDb
                callback(null, `thread123|500\n`);
                return;
            }
        } else if (cmd === 'find') {
            callback(null, `/fake/path/session-thread123.jsonl\n`);
            return;
        } else if (cmd === 'grep') {
            const usage = { payload: { usage: { input_tokens: 50, output_tokens: 10 } } };
            callback(null, JSON.stringify(usage) + '\n');
            return;
        }
        callback(null, '');
    })
}));

describe('CodexParser', () => {
    let parser: CodexParser;

    beforeEach(() => {
        jest.clearAllMocks();
        parser = new CodexParser();
    });

    afterEach(() => {
        parser.stop();
    });

    it('should query sqlite and parse codex usage', async () => {
        let updates = 0;
        parser.onUpdate = () => updates++;

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
        const mockExec = require('child_process').execFile;
        mockExec.mockImplementation((cmd: string, args: any[], callback: any) => {
            if (cmd === 'sqlite3' && args[1].includes('SELECT id, cwd')) {
                callback(null, `thread1|/home/proj|${Date.now()}|${call === 0 ? 100 : 200}\n`);
                call++;
                return;
            }
            callback(null, '');
        });

        let updates = 0;
        parser.onUpdate = () => updates++;
        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        
        await (parser as any).pollDatabase();
        expect(updates).toBeGreaterThan(1);
    });

    it('should handle sqlite errors', async () => {
        const mockExec = require('child_process').execFile;
        mockExec.mockImplementation((cmd: string, args: any[], callback: any) => {
            callback(new Error('Mock SQLite Error'), null);
        });
        
        parser.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(parser.getUsage()?.length || 0).toBe(0);
    });
});
