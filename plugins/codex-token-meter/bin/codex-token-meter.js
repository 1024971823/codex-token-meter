#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RolloutStore, defaultCodexHome } from '../src/store.js';
import { runTui } from '../src/tui.js';
import { startWeb } from '../src/web.js';
import { fmtNum } from '../src/format.js';

const HELP = `codex-token-meter — 实时查看 Codex 主代理/子代理的 token 用量、输入输出和模型

用法:
  codex-token-meter [tui]          终端实时面板 (默认)
  codex-token-meter web            启动网页仪表盘 http://127.0.0.1:4399
  codex-token-meter both           同时启动网页仪表盘和终端面板
  codex-token-meter json           输出一次 JSON 快照 (给脚本 / Codex skill 用)
  codex-token-meter summary        输出一次文本摘要
  codex-token-meter ensure-web     若仪表盘未运行则在后台启动 (插件 hook 使用)

选项:
  --codex-home <dir>   Codex 数据目录 (默认 $CODEX_HOME 或 ~/.codex)
  --port <n>           网页端口 (默认 4399, 或 $CODEX_TOKEN_METER_PORT)
  --host <addr>        网页监听地址 (默认 127.0.0.1)
  --since <hours>      载入最近多少小时的会话 (默认 24)
  --open               启动网页后自动打开浏览器
  --all                终端面板显示所有会话而不仅是活跃会话
`;

function parseArgs(argv) {
  const opts = { cmd: 'tui', port: Number(process.env.CODEX_TOKEN_METER_PORT) || 4399, host: '127.0.0.1', since: 24, codexHome: defaultCodexHome() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--since') opts.since = Number(next());
    else if (a === '--codex-home') opts.codexHome = next();
    else if (a === '--open') opts.open = true;
    else if (a === '--all') opts.all = true;
    else if (!a.startsWith('-')) opts.cmd = a;
  }
  return opts;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

/** Resolves to the running meter's health payload ({ codexHome, ... }) or null. */
function runningMeter(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const h = JSON.parse(body);
          resolve(h.app === 'codex-token-meter' ? h : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const sameHome = (h, opts) => !h.codexHome || path.resolve(h.codexHome) === path.resolve(opts.codexHome);

async function web(store, opts, { quiet = false } = {}) {
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}`;
  try {
    await startWeb(store, opts);
  } catch (e) {
    const running = e.code === 'EADDRINUSE' ? await runningMeter(opts.host, opts.port) : null;
    if (running && !sameHome(running, opts)) {
      console.error(`端口 ${opts.port} 已被监控 ${running.codexHome} 的仪表盘占用，请用 --port 换一个端口`);
      process.exit(1);
    }
    if (running) {
      if (!quiet) console.error(`仪表盘已在运行: ${url}`);
      if (opts.open) openBrowser(url);
      return null;
    }
    throw e;
  }
  if (!quiet) console.error(`Codex Token Meter 网页仪表盘: ${url}`);
  if (opts.open) openBrowser(url);
  return url;
}

function printSummary(snap) {
  const T = snap.totals;
  const line = (u) => `总计 ${fmtNum(u.total)} (输入 ${fmtNum(u.input)}, 缓存 ${fmtNum(u.cached)}, 输出 ${fmtNum(u.output)}, 推理 ${fmtNum(u.reasoning)})`;
  console.log(`全部: ${line(T.all)}`);
  console.log(`子代理: ${line(T.subagents)}`);
  for (const [m, u] of Object.entries(T.byModel)) console.log(`  模型 ${m}: ${line(u)}`);
  for (const s of snap.sessions.slice(0, 5)) {
    console.log(`\n会话 ${s.id} (${s.cwd || '-'})`);
    const walk = (n, indent) => {
      console.log(`${indent}${n.depth === 0 && !n.nickname ? 'main' : n.name} [${n.role || '-'}] ${n.model || '-'} ${n.status}: ${line(n.usage)}, ${n.requests} 次请求`);
      n.children.forEach((c) => walk(c, indent + '  '));
    };
    walk(s, '  ');
  }
}

const opts = parseArgs(process.argv.slice(2));
const store = new RolloutStore({ codexHome: opts.codexHome, sinceHours: opts.since });

switch (opts.cmd) {
  case 'help':
    console.log(HELP);
    break;
  case 'json':
    console.log(JSON.stringify(store.loadOnce().snapshot(), null, 2));
    break;
  case 'summary':
    printSummary(store.loadOnce().snapshot());
    break;
  case 'web':
    store.start();
    if (!(await web(store, opts))) {
      store.stop();
      process.exit(0);
    }
    break;
  case 'both':
    store.start();
    await web(store, opts, { quiet: true });
    runTui(store, { showAll: opts.all });
    break;
  case 'ensure-web': {
    if (!(await runningMeter(opts.host, opts.port))) {
      const self = fileURLToPath(import.meta.url);
      const args = [self, 'web', '--port', String(opts.port), '--host', opts.host, '--codex-home', opts.codexHome, '--since', String(opts.since)];
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    break;
  }
  case 'tui':
    store.start();
    runTui(store, { showAll: opts.all });
    break;
  default:
    console.error(`未知命令: ${opts.cmd}\n`);
    console.log(HELP);
    process.exit(1);
}
