import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ClaudeParser, AISessionMetrics } from './core/claudeParser';

let statusBarItem: vscode.StatusBarItem;
let claudeParser: ClaudeParser | null = null;
let currentMetrics: AISessionMetrics = { totalCostUSD: 0, inputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalLiveContext: 0, providerBreakdown: [] };
let detailsPanel: vscode.WebviewPanel | undefined;
let detailsMessageDisposable: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Session Metrics extension is now active');

    const commandId = 'ai-session-metrics.showDetails';
    context.subscriptions.push(vscode.commands.registerCommand(commandId, () => showDetailsPanel()));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = commandId;
    context.subscriptions.push(statusBarItem);
    updateStatusBarItem(currentMetrics);
    statusBarItem.show();

    claudeParser = new ClaudeParser();
    claudeParser.onMetricsUpdated = (metrics) => {
        currentMetrics = metrics;
        updateStatusBarItem(metrics);
        postMetrics();
    };

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aiSessionMetrics')) claudeParser?.forceUpdate();
    }));

    claudeParser.start();
}

function postMetrics() {
    if (detailsPanel) void detailsPanel.webview.postMessage({ command: 'metrics', metrics: currentMetrics });
}

function showDetailsPanel() {
    if (detailsPanel) {
        detailsPanel.reveal(vscode.ViewColumn.One);
        postMetrics();
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'aiSessionMetricsDetails',
        'AI Session Usage Details',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    detailsPanel = panel;
    const nonce = randomBytes(16).toString('base64');

    detailsMessageDisposable = panel.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.command === 'ready') {
            postMetrics();
        } else if (message.command === 'openSettings') {
            void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:namth587.ai-session-metrics');
        }
    });

    panel.onDidDispose(() => {
        detailsMessageDisposable?.dispose();
        detailsMessageDisposable = undefined;
        detailsPanel = undefined;
    });
    panel.webview.html = getWebviewContent(nonce);
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000000000) return (tokens / 1000000000).toFixed(1) + 'B';
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'K';
    return tokens.toString();
}

function formatCost(costUSD: number | null): string {
    return costUSD === null ? 'Unavailable' : `$${costUSD.toFixed(4)}`;
}

function getWebviewContent(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>AI Session Metrics</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        h1 { color: var(--vscode-editor-foreground); }
        .summary-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .metric-row { display: flex; justify-content: space-between; margin-bottom: 10px; }
        .metric-label { font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid var(--vscode-widget-border); padding: 10px; text-align: left; }
        th { background-color: var(--vscode-editorWidget-background); }
        button { color: var(--vscode-textLink-foreground); background: transparent; border: 0; cursor: pointer; font: inherit; }
    </style>
</head>
<body>
    <div style="display: flex; justify-content: space-between; align-items: center;">
        <h1>AI Session Metrics</h1>
        <button id="settingsButton" type="button">⚙️ Extension Settings</button>
    </div>
    <div class="summary-card">
        <div class="metric-row"><span class="metric-label">Total Cost:</span><span id="totalCost">Unavailable</span></div>
        <div class="metric-row"><span class="metric-label">Total Input Tokens:</span><span id="totalInputTokens">0</span></div>
        <div class="metric-row"><span class="metric-label">Total Output Tokens:</span><span id="totalOutputTokens">0</span></div>
        <div class="metric-row"><span class="metric-label">Total Live Context:</span><span id="totalLiveContext">0</span></div>
    </div>
    <h2>Provider Breakdown</h2>
    <table>
        <thead><tr><th>Provider Name</th><th>Cost</th><th>Input Tokens</th><th>Live Context</th><th>Output Tokens</th></tr></thead>
        <tbody id="providerTableBody"><tr><td colspan="5">Loading data...</td></tr></tbody>
    </table>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const byId = id => document.getElementById(id);
        function formatTokens(tokens) { 
            if (tokens >= 1000000000) return (tokens / 1000000000).toFixed(1) + 'B';
            if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
            if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'K';
            return String(tokens); 
        }
        function appendCell(row, text, strong = false) {
            const cell = document.createElement('td');
            if (strong) {
                const label = document.createElement('strong');
                label.textContent = text;
                cell.appendChild(label);
            } else {
                cell.textContent = text;
            }
            row.appendChild(cell);
        }
        byId('settingsButton').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
        window.addEventListener('message', event => {
            if (!event.data || event.data.command !== 'metrics' || !event.data.metrics) return;
            const metrics = event.data.metrics;
            const prefix = metrics.hasUnpricedProviders ? '~$' : '$';
            const suffix = metrics.hasUnpricedProviders ? ' (incomplete)' : '';
            byId('totalCost').textContent = prefix + metrics.totalCostUSD.toFixed(4) + suffix;
            byId('totalInputTokens').textContent = formatTokens(metrics.inputTokens);
            byId('totalOutputTokens').textContent = formatTokens(metrics.outputTokens);
            byId('totalLiveContext').textContent = metrics.totalLiveContext > 0 ? formatTokens(metrics.totalLiveContext) : '-';
            const providers = [...metrics.providerBreakdown].sort((a, b) => a.providerName.localeCompare(b.providerName));
            const tbody = byId('providerTableBody');
            tbody.replaceChildren();
            if (providers.length === 0) {
                const row = document.createElement('tr');
                const cell = document.createElement('td');
                cell.colSpan = 5;
                cell.textContent = 'No providers used yet in this session.';
                row.appendChild(cell);
                tbody.appendChild(row);
                return;
            }
            for (const provider of providers) {
                const row = document.createElement('tr');
                appendCell(row, provider.providerName, true);
                appendCell(row, provider.costUSD === null ? '—' : '$' + provider.costUSD.toFixed(4));
                appendCell(row, formatTokens(provider.inputTokens));
                const live = (provider.liveUncachedTokens || 0) + (provider.liveCachedTokens || 0);
                appendCell(row, live > 0 ? formatTokens(live) : '-');
                appendCell(row, formatTokens(provider.outputTokens));
                tbody.appendChild(row);
            }
        });
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
}

function updateStatusBarItem(metrics: AISessionMetrics): void {
    const prefix = metrics.hasUnpricedProviders ? '~$' : '$';
    const costStr = `${prefix}${metrics.totalCostUSD.toFixed(2)}`;
    const liveStr = metrics.totalLiveContext > 0 ? formatTokens(metrics.totalLiveContext) : '-';
    statusBarItem.text = `$(hubot) ${costStr} | ${liveStr}`;

    const tooltip = new vscode.MarkdownString();
    const suffix = metrics.hasUnpricedProviders ? ' (incomplete)' : '';
    tooltip.appendText(`Total Cost: ${prefix}${metrics.totalCostUSD.toFixed(4)}${suffix}\n\n`);
    tooltip.appendText(`Tokens (In/Out): ${formatTokens(metrics.inputTokens)} / ${formatTokens(metrics.outputTokens)}\n\n`);
    tooltip.appendText(`Live Context: ${metrics.totalLiveContext > 0 ? formatTokens(metrics.totalLiveContext) : '-'}\n\nProvider Breakdown:`);
    if (metrics.providerBreakdown.length > 0) {
        for (const provider of metrics.providerBreakdown) {
            const live = (provider.liveUncachedTokens || 0) + (provider.liveCachedTokens || 0);
            tooltip.appendText(`\n\n- ${provider.providerName}: Cost ${formatCost(provider.costUSD)}; Tokens ${formatTokens(provider.inputTokens)} in | ${live > 0 ? formatTokens(live) : '-'} live | ${formatTokens(provider.outputTokens)} out`);
        }
    } else {
        tooltip.appendText('\n\nNo providers used yet.');
    }
    statusBarItem.tooltip = tooltip;
}

export function deactivate() {
    claudeParser?.stop();
    detailsMessageDisposable?.dispose();
    detailsMessageDisposable = undefined;
    detailsPanel?.dispose();
    detailsPanel = undefined;
}
