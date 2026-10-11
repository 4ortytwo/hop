import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HOP_DIR } from './util.mjs';
import { M } from './i18n.mjs';

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Both apps prefill a draft; neither deep link submits the prompt. Keep the URL
// small by linking to the local handoff instead of embedding the transcript.
export function desktopUrl({ to, cwd, handoff, task }) {
  if (!path.isAbsolute(cwd)) throw new Error(M.dirMissing(cwd));
  const url = new URL(to === 'codex' ? 'codex://threads/new' : 'claude://code/new');
  url.searchParams.set(to === 'codex' ? 'prompt' : 'q', `${M.prompt(handoff, task)}\n\n${M.desktopPrompt(cwd)}`);
  url.searchParams.set(to === 'codex' ? 'path' : 'folder', cwd);
  return url.href;
}

export function openDesktop(url) {
  if (process.platform !== 'darwin') throw new Error(M.desktopPlatform);
  const r = spawnSync('/usr/bin/open', [url], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) throw new Error(M.desktopOpenFail(r.error?.message || r.stderr?.trim() || String(r.status)));
}

// task/from 用来给新会话命名：claude 直接 --name；codex 没有命名参数，靠 prompt 开头的任务名让它自动起名时沿用
export function buildScript({ to, cwd, handoff, task, from, extra = [] }) {
  const prompt = M.prompt(handoff, task);
  const name = task && to === 'claude' ? ['--name', M.sessionName(task, from)] : [];
  const bin = to === 'codex' ? (process.env.HOP_CODEX_BIN || 'codex') : (process.env.HOP_CLAUDE_BIN || 'claude');
  // prompt 放在 flag 前面，避免被 --add-dir 这类可变参数吞掉
  const argv = to === 'codex'
    ? [bin, '-C', cwd, prompt, ...extra]
    : [bin, prompt, ...name, ...extra];
  return `#!/bin/bash\n# ${M.scriptComment}\ncd ${q(cwd)} || { echo ${q(M.dirMissing(cwd))}; exit 1; }\nexec ${argv.map(q).join(' ')}\n`;
}

export function writeScript(content, destination) {
  const dir = path.join(HOP_DIR, 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = destination || path.join(dir, `launch-${Date.now()}-${randomUUID().slice(0, 8)}.sh`);
  if (path.dirname(file) !== dir) throw new Error('Launch script must be inside the Hop run directory.');
  fs.writeFileSync(file, content, { mode: 0o700, flag: 'wx' });
  return file;
}

function osa(lines) {
  const r = spawnSync('osascript', lines.flatMap(l => ['-e', l]), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(M.osaFail((r.stderr || '').trim()));
}

export function openTab(script) {
  const cmd = `bash ${q(script)}`.replace(/"/g, '\\"');
  const term = process.env.HOP_TERMINAL || (fs.existsSync('/Applications/iTerm.app') ? 'iterm' : 'terminal');
  if (term === 'iterm') {
    osa([
      'tell application "iTerm2"',
      'activate',
      'if (count of windows) = 0 then',
      'create window with default profile',
      'else',
      'tell current window to create tab with default profile',
      'end if',
      `tell current session of current window to write text "${cmd}"`,
      'end tell',
    ]);
  } else if (term === 'terminal') {
    osa(['tell application "Terminal"', 'activate', `do script "${cmd}"`, 'end tell']);
  } else {
    throw new Error(M.badTerminal(term));
  }
  return term;
}

export function runHere(script) {
  const r = spawnSync('bash', [script], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
