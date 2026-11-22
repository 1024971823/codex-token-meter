import { fmtNum, fmtAgo, fmtCost, sparkline } from './format.js';

const ESC = '\x1b[';
const c = {
  reset: ESC + '0m', bold: ESC + '1m', dim: ESC + '2m', inv: ESC + '7m',
  red: ESC + '31m', green: ESC + '32m', yellow: ESC + '33m', blue: ESC + '34m', magenta: ESC + '35m', cyan: ESC + '36m', gray: ESC + '90m',
};
const FLASH_MS = 1500;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const width = (s) => [...strip(s)].reduce((w, ch) => w + (WIDE.test(ch) ? 2 : 1), 0);
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + s;
// Clips a line containing ANSI codes to n display columns (wide chars count 2).
const clip = (s, n) => {
  let out = '';
  let w = 0;
  for (const m of s.matchAll(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu)) {
    const tok = m[0];
    if (tok.length > 1 && tok[0] === '\x1b') { out += tok; continue; }
    const cw = WIDE.test(tok) ? 2 : 1;
    if (w + cw > n) return out + '\x1b[0m';
    out += tok;
    w += cw;
  }
  return out;
};
const trunc = (s, n) => {
  if (width(s) <= n) return s;
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + '…';
};

const STATUS = {
  running: `${c.green}● 运行中${c.reset}`,
  done: `${c.gray}✓ 完成${c.reset}`,
  aborted: `${c.yellow}■ 中断${c.reset}`,
  error: `${c.red}✗ 错误${c.reset}`,
  idle: `${c.gray}○ 空闲${c.reset}`,
};

export function runTui(store, { limit = 8, showAll = false } = {}) {
  const out = process.stdout;
  const prev = new Map(); // id -> { total, changedAt }
  let all = showAll;
  let lastFrame = '';

  const cols = [
    ['Agent', 26, 'l'], ['角色', 10, 'l'], ['模型', 18, 'l'], ['状态', 9, 'l'], ['输入', 9, 'r'], ['缓存', 9, 'r'],
    ['输出', 8, 'r'], ['推理', 8, 'r'], ['总计', 9, 'r'], ['费用', 8, 'r'], ['本次', 8, 'r'], ['请求', 5, 'r'], ['上下文', 7, 'r'], ['趋势', 12, 'l'], ['更新', 5, 'r'],
  ];
  const cell = (v, [, w, align]) => (align === 'r' ? padL(v, w) : padR(trunc(v, w), w));

  function row(n, prefix, now) {
    const p = prev.get(n.id);
    if (!p || p.total !== n.usage.total) prev.set(n.id, { total: n.usage.total, changedAt: p ? now : 0 });
    const flash = now - (prev.get(n.id).changedAt || 0) < FLASH_MS;
    const hi = (s) => (flash ? `${c.bold}${c.green}${s}${c.reset}` : s);
    const ctx = n.contextWindow ? `${Math.round((n.contextUsed / n.contextWindow) * 100)}%` : '-';
    const label = prefix + (n.depth === 0 && !n.nickname ? `${c.bold}main${c.reset} ${c.gray}${n.id.slice(-8)}${c.reset}` : `${c.cyan}${n.name}${c.reset}`);
    const vals = [
      label, n.role || '-', n.model || '-', STATUS[n.status] || n.status, fmtNum(n.usage.input), fmtNum(n.usage.cached),
      fmtNum(n.usage.output), fmtNum(n.usage.reasoning), hi(fmtNum(n.usage.total)),
      n.cost === null ? '—' : hi(n.costPriced ? fmtCost(n.cost) : '~' + fmtCost(n.cost)), hi(n.last.total ? '+' + fmtNum(n.last.total) : '-'),
      String(n.requests), ctx, `${c.magenta}${sparkline(n.history, 12)}${c.reset}`, fmtAgo(n.updatedAt, now),
    ];
    return vals.map((v, i) => cell(v, cols[i])).join(' ');
  }

  function render() {
    const now = Date.now();
    const snap = store.snapshot({ limit: 50 });
    let sessions = snap.sessions;
    if (!all) {
      const active = sessions.filter((s) => now - s.lastActive < 30 * 60 * 1000);
      sessions = (active.length ? active : sessions.slice(0, 1)).slice(0, limit);
    } else sessions = sessions.slice(0, limit);

    const lines = [];
    const T = snap.totals;
    const totalCost = T.cost === null ? '—' : T.costPriced ? fmtCost(T.cost) : '~' + fmtCost(T.cost);
    const subCost = T.subagents.cost === null ? '—' : T.subagents.priced ? fmtCost(T.subagents.cost) : '~' + fmtCost(T.subagents.cost);
    lines.push(`${c.bold}Codex Token Meter${c.reset}  ${c.gray}${snap.codexHome}${c.reset}`);
    lines.push(
      `全部: ${c.bold}${fmtNum(T.all.total)}${c.reset}  (输入 ${fmtNum(T.all.input)} / 缓存 ${fmtNum(T.all.cached)} / 输出 ${fmtNum(T.all.output)} / 推理 ${fmtNum(T.all.reasoning)})   ` +
        `费用约 ${c.bold}${totalCost}${c.reset}   ` +
        `子代理: ${c.bold}${c.cyan}${fmtNum(T.subagents.total)}${c.reset}  (输入 ${fmtNum(T.subagents.input)} / 输出 ${fmtNum(T.subagents.output)} / 费用约 ${subCost})`,
    );
    const models = Object.entries(T.byModel).sort((a, b) => b[1].total - a[1].total);
    if (models.length) lines.push('按模型: ' + models.map(([m, u]) => `${c.yellow}${m}${c.reset} ${fmtNum(u.total)} ${u.cost === null ? '—' : u.priced ? fmtCost(u.cost) : '~' + fmtCost(u.cost)}`).join('  '));
    if (snap.pricing) lines.push(`${c.gray}费用为估算 (OpenAI 定价 ${snap.pricing.date}，${snap.pricing.source})，不是账单。${c.reset}`);
    lines.push('');
    lines.push(c.dim + cols.map((col) => cell(col[0], col)).join(' ') + c.reset);
    if (!sessions.length) lines.push(`${c.gray}  还没有会话。在另一个终端运行 codex，这里会实时显示。${c.reset}`);
    for (const s of sessions) {
      lines.push(row(s, '', now));
      const walk = (kids, indent) =>
        kids.forEach((k, i) => {
          const last = i === kids.length - 1;
          lines.push(row(k, indent + (last ? '└─ ' : '├─ '), now));
          walk(k.children, indent + (last ? '   ' : '│  '));
        });
      walk(s.children, ' ');
      if (s.children.length) {
        const sub = s.subtreeUsage.total - s.usage.total;
        const subCost = s.subtreeCost === null ? '—' : s.subtreeCostPriced ? fmtCost(s.subtreeCost) : '~' + fmtCost(s.subtreeCost);
        lines.push(`${c.gray}  ${s.children.length} 个子代理共 ${fmtNum(sub)} tokens · 会话合计 ${fmtNum(s.subtreeUsage.total)} · 费用约 ${subCost}${c.reset}`);
      }
      lines.push('');
    }
    const footer = `${c.gray}[q] 退出  [a] ${all ? '只看活跃会话' : '显示全部会话'}   ${new Date(now).toLocaleTimeString()}${c.reset}`;
    const maxBody = Math.max(1, (out.rows || 1000) - 1);
    if (lines.length > maxBody) {
      const hidden = lines.length - (maxBody - 1);
      lines.length = maxBody - 1;
      lines.push(`${c.gray}  … 还有 ${hidden} 行未显示（放大终端窗口）${c.reset}`);
    }
    lines.push(footer);
    const maxCols = out.columns || 1000;
    const frame = lines.map((l) => clip(l, maxCols) + ESC + 'K').join('\n') + ESC + 'J';
    if (frame !== lastFrame) {
      out.write(ESC + 'H' + frame);
      lastFrame = frame;
    }
  }

  out.write(ESC + '?1049h' + ESC + '?25l' + ESC + '?7l');
  const cleanup = () => {
    out.write(ESC + '?7h' + ESC + '?25h' + ESC + '?1049l');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === '\x03') cleanup();
      if (k === 'a') { all = !all; render(); }
    });
  }
  out.on('resize', () => { lastFrame = ''; out.write(ESC + '2J'); render(); });
  store.on('change', render);
  setInterval(render, 1000);
  render();
}
