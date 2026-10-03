import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/**
 * Status-bar companion for the local proxy.
 *
 * The proxy is the only component that observes every LLM round-trip, so it
 * exposes its token accounting over `GET /api/token-stats`. This extension
 * simply polls that endpoint -- which the proxy may serve on a dynamic port --
 * and renders the result in the status bar. Nothing here touches the chat UI:
 * that panel is rendered by the workbench layer and is not reachable from the
 * extension API.
 */

interface TurnTokenStats {
  model: string;
  displayName: string;
  provider: string;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  cachedContentTokenCount: number;
  totalTokenCount: number;
  contextTokenCount: number;
  authoritative: boolean;
  /** Context window resolved by the proxy (0 when unknown). */
  contextWindow: number;
  contextWindowSource: string;
  updatedAt: string;
}

/** Human-readable labels for `contextWindowSource`, mirrored from the proxy. */
const WINDOW_SOURCE_LABELS: Record<string, string> = {
  explicit: 'custom_models.json 显式配置',
  catalog: '本地模型目录',
  official: '官方模型列表 (maxTokens)',
  heuristic: '内置名称启发式',
  default: '默认值（模型未识别）',
};

interface ModelTokenTotals {
  model: string;
  displayName: string;
  provider: string;
  turns: number;
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  lastSeenAt: string;
}

interface TokenStatsSnapshot {
  startedAt: string;
  updatedAt: string;
  turns: number;
  current: TurnTokenStats | null;
  totals: {
    turns: number;
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  perModel: ModelTokenTotals[];
}

const ACTIVE_PORT_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'active_port');
const DEFAULT_PORT = 50999;
/** Used only when neither the setting nor the proxy supplies a window. */
const FALLBACK_CONTEXT_WINDOW = 200000;
const CONFIG_SECTION = 'antigravityTokenMeter';

let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let timer: NodeJS.Timeout | undefined;
let lastRenderKey = '';

/** Resolves the proxy port: explicit setting > active_port marker > default. */
function resolvePort(): number {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('proxyPort', 0);
  if (configured && configured > 0) return configured;
  try {
    const raw = fs.readFileSync(ACTIVE_PORT_FILE, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // Marker file absent -- the proxy has not started yet in this session.
  }
  return DEFAULT_PORT;
}

function requestJson(port: number, route: string, method: 'GET' | 'POST'): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: route, method, timeout: 1500 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(2)}M`;
}

function buildTooltip(
  snapshot: TokenStatsSnapshot,
  port: number,
  contextWindow: number,
  windowLabel: string,
): vscode.MarkdownString {
  const turn = snapshot.current;
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  if (turn) {
    const pct = contextWindow > 0 ? (turn.contextTokenCount / contextWindow) * 100 : 0;
    md.appendMarkdown(`**本轮用量** — ${turn.displayName}\n\n`);
    md.appendMarkdown(`- 输入 prompt：${turn.promptTokenCount.toLocaleString()}\n`);
    md.appendMarkdown(`- 输出 completion：${turn.candidatesTokenCount.toLocaleString()}\n`);
    if (turn.thoughtsTokenCount > 0) md.appendMarkdown(`- 思考 reasoning：${turn.thoughtsTokenCount.toLocaleString()}\n`);
    if (turn.cachedContentTokenCount > 0)
      md.appendMarkdown(`- 缓存命中：${turn.cachedContentTokenCount.toLocaleString()}\n`);
    md.appendMarkdown(`- 合计：${turn.totalTokenCount.toLocaleString()}\n`);
    md.appendMarkdown(
      `- 上下文占用：${turn.contextTokenCount.toLocaleString()} / ${contextWindow.toLocaleString()}（${pct.toFixed(1)}%）\n`,
    );
    md.appendMarkdown(`- 窗口来源：${windowLabel}\n`);
    md.appendMarkdown(
      `- 用量来源：${turn.authoritative ? '上游 usage（精确）' : '请求体估算（上游未返回 usage）'}\n\n`,
    );
  }

  md.appendMarkdown(`**本次会话累计**\n\n`);
  md.appendMarkdown(`- 轮次：${snapshot.totals.turns}\n`);
  md.appendMarkdown(
    `- 输入：${snapshot.totals.promptTokenCount.toLocaleString()} · 输出：${snapshot.totals.candidatesTokenCount.toLocaleString()} · 合计：${snapshot.totals.totalTokenCount.toLocaleString()}\n\n`,
  );

  const others = snapshot.perModel.slice(0, 5);
  if (others.length > 0) {
    md.appendMarkdown(`**按模型**\n\n`);
    for (const m of others) {
      md.appendMarkdown(`- ${m.displayName}：${m.turns} 轮 · ${m.totalTokenCount.toLocaleString()} tokens\n`);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`---\n\n代理：\`127.0.0.1:${port}\` · 更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString()}`);
  return md;
}

function render(snapshot: TokenStatsSnapshot | null, port: number): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  // 0 = 自动：使用代理推断出的窗口大小
  const configuredWindow = config.get<number>('contextWindow', 0) || 0;
  const warnThreshold = config.get<number>('warnThreshold', 80);

  if (!snapshot || !snapshot.current) {
    const text = '$(circle-slash) Token: --';
    if (text !== lastRenderKey) {
      lastRenderKey = text;
      statusItem.text = text;
      statusItem.tooltip = `未收到代理统计数据。\n\n请确认本地代理已部署并运行：http://127.0.0.1:${port}/health`;
      statusItem.color = undefined;
      statusItem.backgroundColor = undefined;
    }
    return;
  }

  const turn = snapshot.current;
  const contextWindow =
    configuredWindow > 0 ? configuredWindow : turn.contextWindow > 0 ? turn.contextWindow : FALLBACK_CONTEXT_WINDOW;
  const windowLabel =
    configuredWindow > 0
      ? `手动设置（${contextWindow.toLocaleString()}）`
      : `${WINDOW_SOURCE_LABELS[turn.contextWindowSource] || '未知来源'}（${contextWindow.toLocaleString()}）`;
  const pct = contextWindow > 0 ? Math.min(100, (turn.contextTokenCount / contextWindow) * 100) : 0;
  const prefix = turn.authoritative ? '' : '~';
  const text = `$(pulse) ${prefix}${formatTokens(turn.contextTokenCount)}/${formatTokens(contextWindow)} · ${pct.toFixed(0)}%`;
  const key = `${text}|${turn.model}|${snapshot.updatedAt}`;

  if (key === lastRenderKey) return;
  lastRenderKey = key;

  statusItem.text = text;
  statusItem.tooltip = buildTooltip(snapshot, port, contextWindow, windowLabel);

  if (pct >= warnThreshold) {
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.color = undefined;
  } else {
    statusItem.backgroundColor = undefined;
    statusItem.color = undefined;
  }
}

async function refresh(): Promise<void> {
  const port = resolvePort();
  const snapshot = (await requestJson(port, '/api/token-stats', 'GET')) as TokenStatsSnapshot | null;
  render(snapshot, port);
}

function startPolling(): void {
  if (timer) clearInterval(timer);
  const interval = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('refreshIntervalMs', 1500);
  const safeInterval = Math.min(Math.max(interval || 1500, 500), 60000);
  timer = setInterval(() => {
    void refresh();
  }, safeInterval);
}

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  statusItem.text = '$(circle-slash) Token: --';
  statusItem.command = 'antigravityTokenMeter.showDetails';
  statusItem.show();
  context.subscriptions.push(statusItem);

  output = vscode.window.createOutputChannel('Antigravity Token Meter');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityTokenMeter.showDetails', async () => {
      const port = resolvePort();
      const snapshot = await requestJson(port, '/api/token-stats', 'GET');
      output.clear();
      output.appendLine(`代理端口: ${port}`);
      output.appendLine(JSON.stringify(snapshot, null, 2));
      output.show(true);
    }),
    vscode.commands.registerCommand('antigravityTokenMeter.openDashboard', () => {
      void vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${resolvePort()}/`));
    }),
    vscode.commands.registerCommand('antigravityTokenMeter.reset', async () => {
      const port = resolvePort();
      await requestJson(port, '/api/token-stats/reset', 'POST');
      void vscode.window.showInformationMessage('Antigravity Token Meter: 统计已重置');
      await refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        lastRenderKey = '';
        startPolling();
        void refresh();
      }
    }),
  );

  startPolling();
  void refresh();
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
