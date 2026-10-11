import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { M } from './i18n.mjs';

export const HOME = process.env.HOME;
export const HOP_DIR = path.resolve(process.env.HOP_DIR || path.join(HOME, '.hop'));

export function* readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* 半行（会话仍在写入）直接跳过 */ }
  }
}

// Scan backwards without assuming that recent metadata is in a fixed-size tail.
// Keep fragments as bytes until a whole line is available, including UTF-8 that
// straddles a chunk boundary. Snapshot the size so a live append cannot loop.
export function* readJsonlReverse(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let fragments = [];
    while (pos > 0) {
      const size = Math.min(pos, 64 * 1024);
      pos -= size;
      const buffer = Buffer.allocUnsafe(size);
      const bytes = fs.readSync(fd, buffer, 0, size, pos);
      const chunk = buffer.subarray(0, bytes);
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        const pieces = [chunk.subarray(i + 1, end), ...fragments.reverse()];
        const line = Buffer.concat(pieces).toString('utf8');
        fragments = [];
        end = i;
        if (line) { try { yield JSON.parse(line); } catch { /* partial append or malformed record */ } }
      }
      if (end) fragments.push(chunk.subarray(0, end));
    }
    if (fragments.length) {
      try { yield JSON.parse(Buffer.concat(fragments.reverse()).toString('utf8')); } catch { /* malformed first line */ }
    }
  } finally { fs.closeSync(fd); }
}

// 只读文件开头第一行，rollout 首行的 session_meta 可能几十 KB
export function readFirstLine(file, max = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.toString('utf8');
    const i = s.indexOf('\n');
    return i === -1 ? s : s.slice(0, i);
  } finally { fs.closeSync(fd); }
}

export function readHead(file, bytes = 128 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function readTail(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function realpath(p) {
  if (!p) return p;
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, ...opts }).trimEnd();
  } catch { return null; }
}

// Snapshot commands must not run workspace automation. Disabling optional
// locks alone still permits fsmonitor and clean/process filters during status
// and diff. Read filter names as NUL-delimited data; never evaluate their values.
export function gitReader(cwd) {
  const opts = { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const flags = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
  let keys = '', failed = false;
  try {
    keys = execFileSync('git', [...flags, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (error) { failed = error.status !== 1; } // exit 1 means no matching filters
  let sequence = 0;
  const filterFlags = [];
  for (const key of new Set(keys.split('\0').filter(Boolean))) {
    // --config-env separates the value from the key and splits at the LAST
    // equals sign. A legal filter subsection such as foo=bar defeats -c key=.
    const variable = `HOP_GIT_FILTER_OVERRIDE_${sequence++}`;
    opts.env[variable] = /\.required$/i.test(key) ? 'false' : '';
    filterFlags.push(`--config-env=${key}=${variable}`);
  }
  const read = (...args) => {
    const workingTree = ['status', 'diff'].includes(args[0]);
    if (failed && workingTree) return null;
    const result = sh('git', [...flags, ...(workingTree ? filterFlags : []), ...args], opts);
    if (result === null && workingTree) read.warnings.push(`Git ${args[0]} was unavailable; do not infer a clean workspace.`);
    return result;
  };
  read.warnings = failed ? ['Working-tree inspection skipped because Git filter configuration could not be read safely.'] : [];
  return read;
}

export function gitTop(dir) {
  return sh('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
}

// 会话 cwd 是否属于目标目录：完全相同，或目标是 git 根且会话开在其子目录
export function cwdMatches(sessionCwd, target, targetIsRepo) {
  if (typeof sessionCwd !== 'string' || !sessionCwd) return false;
  const a = realpath(sessionCwd);
  if (a === target) return true;
  return targetIsRepo && a.startsWith(target + '/');
}

export function clip(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length <= n ? s : s.slice(0, n) + M.truncated(s.length);
}

export function recentFiles(files, days) {
  const since = Date.now() - days * 864e5;
  return files
    .map(f => { try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(x => x && x.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
}
