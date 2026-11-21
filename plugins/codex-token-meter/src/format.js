export function fmtNum(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return n.toLocaleString('en-US');
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const BARS = '▁▂▃▄▅▆▇█';
export function sparkline(history, width = 12) {
  if (!history || history.length < 2) return '';
  const deltas = [];
  for (let i = 1; i < history.length; i++) deltas.push(history[i][1] - history[i - 1][1]);
  const pts = deltas.slice(-width);
  const max = Math.max(...pts, 1);
  return pts.map((d) => BARS[Math.min(BARS.length - 1, Math.floor((d / max) * (BARS.length - 1)))]).join('');
}
