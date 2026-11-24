// Detects which agent tools are installed or running on this computer:
// CLI binaries on PATH and desktop/IDE app processes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const TOOLS = {
  codex: {
    name: 'Codex',
    bins: ['codex'],
    apps: [{ label: 'Codex Desktop', re: /^Codex( Helper.*)?$/ }, { label: 'Codex CLI', re: /^codex(\.exe)?$/ }],
  },
  claude: {
    name: 'Claude Code',
    bins: ['claude'],
    apps: [{ label: 'Claude Desktop', re: /^Claude(\.exe)?$/ }, { label: 'Claude Code', re: /^claude(\.exe)?$/ }],
  },
  antigravity: {
    name: 'Antigravity',
    bins: ['antigravity', 'agy'],
    apps: [{ label: 'Antigravity', re: /^Antigravity(\.exe)?$|^antigravity$/i }],
  },
  devin: {
    name: 'Devin',
    bins: ['devin'],
    apps: [{ label: 'Devin Desktop', re: /^Devin(\.exe)?$/ }, { label: 'Devin CLI', re: /^devin(\.exe)?$/ }],
  },
};

/** Absolute paths of `names` found on PATH (or in ~/.local/bin). */
export function findBinaries(names, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')].filter(Boolean);
  const found = [];
  for (const name of names) {
    for (const dir of dirs) {
      const hit = exts.map((e) => path.join(dir, name + e)).find((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (hit) {
        found.push(hit);
        break;
      }
    }
  }
  return found;
}

let cache = { at: 0, names: [] };

/** Running process names (basename), cached for a few seconds. */
export function runningProcesses({ maxAgeMs = 8000 } = {}) {
  if (Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.names);
  return new Promise((resolve) => {
    const done = (names) => {
      cache = { at: Date.now(), names };
      resolve(names);
    };
    if (process.platform === 'win32') {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        done(err ? [] : out.split(/\r?\n/).map((l) => l.split('","')[0]?.replace(/^"/, '')).filter(Boolean));
      });
    } else {
      execFile('ps', ['-axo', 'comm='], { timeout: 5000 }, (err, out) => {
        done(err ? [] : out.split('\n').map((l) => path.basename(l.trim())).filter(Boolean));
      });
    }
  });
}

/** { bins, apps: [{label, running}] } for one tool. */
export async function detectTool(id, { processes } = {}) {
  const tool = TOOLS[id];
  if (!tool) return { bins: [], apps: [] };
  const names = processes || (await runningProcesses());
  return {
    bins: findBinaries(tool.bins),
    apps: tool.apps.filter((a) => names.some((n) => a.re.test(n))).map((a) => a.label),
  };
}
