import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { HOME, readJsonl, readFirstLine, readJsonlReverse, recentFiles, cwdMatches } from './util.mjs';
import { M } from './i18n.mjs';

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const ROOT = path.join(CODEX_HOME, 'sessions');

// 只认人直接用的会话：cli = codex TUI，vscode = Codex 桌面端。
// exec（被脚本/其他 agent 调起）和 subagent（source 是对象）都排除。
const INTERACTIVE = new Set(['cli', 'vscode']);

// Desktop threads may stay active for months. The date directory is their creation
// date, so discover all rollouts and apply the recency window to file mtime instead.
function listRollouts(includeArchived = false) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file);
    }
  };
  walk(ROOT, 0);
  if (includeArchived) walk(path.join(CODEX_HOME, 'archived_sessions'), 0);
  return out;
}

function clientOf(meta) {
  if (meta.source === 'cli') return 'cli';
  return /codex[ _]desktop|codex_work_desktop/i.test(meta.originator || '') ? 'desktop' : 'vscode';
}

function latestCwd(file, fallback) {
  try {
    for (const rec of readJsonlReverse(file)) {
      if (rec?.type === 'turn_context' && typeof rec.payload?.cwd === 'string' && rec.payload.cwd) return rec.payload.cwd;
    }
  } catch { /* session removed while discovering */ }
  return fallback;
}

function readMeta(file) {
  try {
    const o = JSON.parse(readFirstLine(file));
    return o.type === 'session_meta' ? o.payload : null;
  } catch { return null; }
}

export function findCodexSessions({ target, targetIsRepo, days = 14, any = false, client = 'all' }) {
  const res = [];
  for (const { file, mtime } of recentFiles(listRollouts(), days)) {
    const meta = readMeta(file);
    if (!meta || typeof meta.source !== 'string' || !INTERACTIVE.has(meta.source)) continue;
    const sourceClient = clientOf(meta);
    if (client !== 'all' && client !== sourceClient) continue;
    const cwd = latestCwd(file, meta.cwd);
    if (typeof cwd !== 'string' || !cwd) continue;
    if (!any && !cwdMatches(cwd, target, targetIsRepo) && !cwdMatches(meta.cwd, target, targetIsRepo)) continue;
    res.push({ tool: 'codex', id: meta.id || meta.session_id, file, mtime, cwd, origin: meta.originator, client: sourceClient });
  }
  const titles = codexTitles(res.map(session => session.id));
  for (const session of res) session.title = titles.get(session.id) || null;
  return res;
}

const titleValue = value => typeof value === 'string' && value.trim() ? value.trim() : null;
let stateTitleCache = null;

function stateFingerprint(database) {
  return JSON.stringify([database, process.env.PATH, ...[database, `${database}-wal`].map(file => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  })]);
}

function stateTitles(database) {
  const fingerprint = stateFingerprint(database);
  if (stateTitleCache?.fingerprint === fingerprint) return stateTitleCache.titles;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-codex-state-'));
  try {
    const snapshot = path.join(temporary, path.basename(database));
    fs.copyFileSync(database, snapshot);
    try { fs.copyFileSync(`${database}-wal`, `${snapshot}-wal`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stateFingerprint(database) !== fingerprint) return new Map();
    // Opening even a read-only WAL database can create/update its SHM sidecar.
    // Query only the private DB/WAL copy; never copy or open the provider's SHM.
    const query = columns => JSON.parse(execFileSync('sqlite3', ['-readonly', '-init', os.devNull, '-json', snapshot,
      `SELECT ${columns} FROM threads;`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 4 * 1024 * 1024 }) || '[]');
    let rows;
    try { rows = query('id, name, title'); }
    catch (error) {
      if (error.status !== 1) throw error;
      rows = query('id, title'); // Older state databases have no name column.
    }
    const titles = new Map();
    for (const rec of rows) {
      const title = titleValue(rec?.name) || titleValue(rec?.title);
      if (typeof rec?.id === 'string' && title) titles.set(rec.id, title);
    }
    stateTitleCache = { fingerprint, titles };
    return titles;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

// The append-only index records generated titles and renames; the last valid
// entry wins. Desktop threads without an index entry can retain a name/title in
// the optional state DB. Metadata failure must never hide a local rollout.
function codexTitles(ids, index = path.join(CODEX_HOME, 'session_index.jsonl')) {
  const wanted = new Set(ids.filter(id => typeof id === 'string' && id));
  const titles = new Map();
  if (!wanted.size) return titles;
  try {
    for (const rec of readJsonl(index)) {
      const title = titleValue(rec?.thread_name);
      if (wanted.has(rec?.id) && title) titles.set(rec.id, title);
    }
  } catch { /* missing or unreadable index */ }
  const missing = [...wanted].filter(id => !titles.has(id));
  if (!missing.length) return titles;
  try {
    const dir = path.dirname(index);
    const databases = fs.readdirSync(dir).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!databases.length) return titles;
    const database = path.join(dir, databases[0]);
    const stored = stateTitles(database);
    for (const id of missing) if (stored.has(id)) titles.set(id, stored.get(id));
  } catch { /* SQLite is optional, including its executable and evolving schema. */ }
  return titles;
}

export function codexThreadName(id, index = path.join(CODEX_HOME, 'session_index.jsonl')) {
  return codexTitles([id], index).get(id) || null;
}

export function codexFileById(id) {
  try { if (fs.statSync(id).isFile()) return id; } catch { /* session ID */ }
  // Explicit IDs are not limited by the automatic discovery window.
  return listRollouts(true).find(file => {
    if (!path.basename(file).includes(id)) return false;
    const meta = readMeta(file);
    return (meta?.id || meta?.session_id) === id;
  }) || null;
}

// 系统注入到 user 角色里的内容：<environment_context>、<recommended_plugins>、AGENTS.md 等
function isInjected(text) {
  const t = text.trimStart();
  if (t.startsWith('# AGENTS.md instructions')) return true;
  const m = t.match(/^<([a-z_]+)>/);
  return !!m && t.trimEnd().endsWith(`</${m[1]}>`);
}

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map(p => p.text ?? (p.type === 'input_image' ? M.image : '')).filter(Boolean).join('\n');
}

function patchFiles(patch) {
  return [...String(patch).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map(m => `${m[1]} ${m[2]}`);
}

function briefCall(name, raw) {
  let args = raw;
  if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { /* custom tool 的 input 是纯文本 */ } }
  if (name === 'apply_patch') {
    const files = patchFiles(typeof args === 'string' ? args : args?.input ?? '');
    return `apply_patch: ${files.join(', ') || M.unknownFiles}`;
  }
  if (args && typeof args === 'object') {
    const cmd = args.cmd ?? (Array.isArray(args.command) ? args.command.join(' ') : args.command);
    if (cmd) return `$ ${cmd}${args.workdir ? `   (in ${args.workdir})` : ''}`;
  }
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return `${name}: ${s.replace(/\s+/g, ' ').slice(0, 300)}`;
}

function outputText(out) {
  if (Array.isArray(out)) return out.map(p => p.text ?? JSON.stringify(p)).join('\n');
  let s = typeof out === 'string' ? out : out?.content ?? out?.output ?? JSON.stringify(out);
  if (typeof s !== 'string') s = JSON.stringify(s);
  // exec_command 的输出带一段元信息头，只留退出码和正文
  const exit = s.match(/Process exited with code (\d+)/);
  const i = s.indexOf('\nOutput:\n');
  if (i !== -1) s = s.slice(i + 9);
  return exit && exit[1] !== '0' ? `[exit ${exit[1]}]\n${s}` : s;
}

export function parseCodex(file, { records } = {}) {
  const session = { tool: 'codex', file, id: null, cwd: null, model: null, permission: null, title: null, summary: null, turns: [] };
  let turn = null;
  const calls = new Map();
  const newTurn = user => { turn = { user, ts: null, assistant: [], reasoning: [], tools: [], interjections: [], agentMessages: [] }; session.turns.push(turn); };

  for (const rec of records ?? readJsonl(file)) {
    const p = rec.payload || {};
    if (rec.type === 'session_meta') {
      session.id = p.id || p.session_id; session.cwd = p.cwd; session.origin = p.originator; session.client = clientOf(p);
      session.metadata = p;
      continue;
    }
    if (rec.type === 'turn_context') {
      session.cwd = p.cwd || session.cwd;
      session.model = p.model || session.model;
      session.permission = `sandbox=${p.sandbox_policy?.type ?? '?'} approval=${p.approval_policy ?? '?'}`;
      continue;
    }
    if (rec.type === 'compacted') {
      // 上下文被压缩：压缩前的轮次已由摘要代替
      session.summary = p.message || session.summary;
      session.turns = []; turn = null; calls.clear();
      continue;
    }
    if (rec.type !== 'response_item') continue;

    if (p.type === 'agent_message') {
      const text = textOf(p.content);
      if (text) {
        if (!turn) newTurn(null);
        turn.agentMessages.push(text);
      }
    } else if (p.type === 'message') {
      const text = textOf(p.content);
      if (p.role === 'user') {
        if (!text || isInjected(text)) continue;
        newTurn(text); turn.ts = rec.timestamp;
      } else if (p.role === 'assistant' && text) {
        if (!turn) newTurn(null);
        turn.assistant.push(text);
      }
    } else if (p.type === 'reasoning') {
      // 官方模型只有加密密文 + 简短 summary 标题；第三方 provider 会有明文 content
      const raw = textOf(p.content);
      const sum = (p.summary || []).map(s => s.text).filter(Boolean).join(' / ');
      if (turn && (raw || sum)) turn.reasoning.push(raw || sum);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      if (!turn) newTurn(null);
      const brief = briefCall(p.name, p.arguments ?? p.input ?? p.action);
      const t = {
        name: p.name || p.type, namespace: p.namespace, callId: p.call_id,
        arguments: p.arguments ?? p.input ?? p.action, ts: rec.timestamp,
        brief, output: null, shell: brief.startsWith('$ '), cwd: session.cwd,
      };
      turn.tools.push(t);
      if (p.call_id) calls.set(p.call_id, t);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = calls.get(p.call_id);
      if (t) {
        t.output = outputText(p.output);
        t.rawOutput = p.output;
        // 还在后台跑的命令（Process running with session ID）没有退出码，记 null
        const code = (typeof p.output === 'string' ? p.output : JSON.stringify(p.output)).match(/Process exited with code (\d+)/);
        t.exit = code ? +code[1] : null;
      }
    }
  }
  session.title = codexThreadName(session.id);
  return session;
}
