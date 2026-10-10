import * as fs from 'fs';
import * as path from 'path';

describe('Extension Security', () => {
    let source: string;

    beforeAll(() => {
        const sourcePath = path.resolve(__dirname, '../src/extension.ts');
        source = fs.readFileSync(sourcePath, 'utf8');
    });

    it('provider rows must not be rendered through innerHTML', () => {
        expect(source.includes('tbody.innerHTML')).toBe(false);
    });

    it('webview command URIs must remain disabled', () => {
        expect(source.includes('enableCommandUris')).toBe(false);
    });

    it('provider names must be written as text', () => {
        expect(source.includes("label.textContent = text")).toBe(true);
    });

    it('webview must have a restrictive nonce-based CSP', () => {
        expect(source.includes("default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';")).toBe(true);
    });

    it('webview must announce readiness', () => {
        expect(source.includes("vscode.postMessage({ command: 'ready' })")).toBe(true);
    });

    it('settings request must be explicitly handled', () => {
        expect(source.includes("message.command === 'openSettings'")).toBe(true);
    });

    it('only one configuration listener should be registered', () => {
        const matches = source.match(/onDidChangeConfiguration\(/g) || [];
        expect(matches.length).toBe(1);
    });
});
