import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiParser } from '../src/core/parsers/geminiParser';

async function writeTranscript(root: string, uuid: string, project: string, inputs: number) {
    const logs = path.join(root, uuid, '.system_generated', 'logs');
    await fs.promises.mkdir(logs, { recursive: true });
    await fs.promises.writeFile(path.join(logs, 'transcript_full.jsonl'), `Active Document: ${project}/file.ts\n`);
    await fs.promises.writeFile(path.join(logs, 'transcript.jsonl'), JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: inputs, cache_read_tokens: 2, output_tokens: 3 }) + '\n');
}

describe('GeminiParser', () => {
    let root: string;
    let brainDir: string;
    let parser: GeminiParser;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'metrics-gemini-'));
        brainDir = path.join(root, 'brain');
        await fs.promises.mkdir(brainDir);
    });

    afterEach(async () => {
        if (parser) parser.stop();
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it('should parse and update gemini session metrics', async () => {
        await writeTranscript(brainDir, 'session-one', '/work/project-a', 10);
        await writeTranscript(brainDir, 'session-two', '/work/project-a', 20);

        parser = new GeminiParser(brainDir);
        let updates = 0;
        parser.onUpdate = () => updates++;
        parser.start();

        await new Promise(resolve => setTimeout(resolve, 100));

        const usage = parser.getUsage();
        expect(usage.length).toBe(2);

        const totalInput = usage[0].inputTokens + usage[1].inputTokens;
        expect(totalInput).toBe(34);
        expect(typeof usage[0].costUSD).toBe('number');
        expect(usage[0].providerName.startsWith('Gemini (project-a - ')).toBe(true);

        await writeTranscript(brainDir, 'session-three', '/other/project-a', 1);
        await new Promise(resolve => setTimeout(resolve, 5200));

        expect(parser.getUsage().length).toBe(3);

        const beforeAppend = updates;
        const transcript = path.join(brainDir, 'session-two', '.system_generated', 'logs', 'transcript.jsonl');
        await fs.promises.appendFile(transcript, '{bad json}\n' + JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 5, output_tokens: 1 }) + '\n');

        await new Promise(resolve => setTimeout(resolve, 5200));

        const finalUsage = parser.getUsage();
        const updatedSession = finalUsage.find((u: any) => u.inputTokens === 22 + 5);
        expect(updatedSession).toBeDefined();
        expect(updates).toBeGreaterThan(beforeAppend);
    }, 15000); // increase timeout due to setTimeout 5200 delays
    it('should handle missing directory', async () => {
        const p = new GeminiParser('/does/not/exist/dir');
        let updates = 0;
        p.onUpdate = () => updates++;
        p.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        p.stop();
        // updates should be 0 or handled gracefully
        expect(p.getUsage().length).toBe(0);
    });
});
