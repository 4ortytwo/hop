import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJsonl, readJsonlReverse, readHead, recentFiles, cwdMatches } from './util.mjs';
import { M } from './i18n.mjs';

const ROOT = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(HOME, '.claude/projects');
const DESKTOP_ROOT = path.join(process.env.HOP_CLAUDE_DESKTOP_DIR || (process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Claude') : path.join(HOME, 'Library/Application Support/Claude')), 'claude-code-sessions');

const textValue = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const pathValue = value => typeof value === 'string' && value.length ? value : null;
const clientFor = entrypoint => entrypoint === 'claude-desktop' ? 'desktop' : !entrypoint || entrypoint === 'cli' ? 'cli' : null;

function directoryEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Desktop metadata links the app's local ID to the ordinary CLI transcript. Never
// create candidates from metadata alone: the actual conversation must be local.
function desktopSessions() {
  const sessions = new Map();
  for (const account of directoryEntries(DESKTOP_ROOT)) {
    if (!account.isDirectory()) continue;
    for (const org of directoryEntries(path.join(DESKTOP_ROOT, account.name))) {
      if (!org.isDirectory()) continue;
      const dir = path.join(DESKTOP_ROOT, account.name, org.name);
      for (const entry of directoryEntries(dir)) {
        if (!entry.isFile() || !entry.name.startsWith('local_') || !entry.name.endsWith('.json')) continue;
        try {
          const file = path.join(dir, entry.name);
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (typeof data?.sessionId !== 'string' || typeof data?.cliSessionId !== 'string' ||
              !/^local_[A-Za-z0-9-]{1,64}$/.test(data.sessionId) || !/^[\w-]+$/.test(data.cliSessionId)) continue;
          const metadata = {
            desktopId: data.sessionId, id: data.cliSessionId,
            cwd: pathValue(data.cwd), originCwd: pathValue(data.originCwd),
            title: textValue(data.title), permission: textValue(data.permissionMode),
            isArchived: data.isArchived === true,
            mtime: fs.statSync(file).mtimeMs,
          };
          const existing = sessions.get(metadata.id);
          if (!existing || metadata.mtime > existing.mtime) sessions.set(metadata.id, metadata);
        } catch { /* Missing, incomplete, or stale app metadata is optional. */ }
      }
    }
  }
  return sessions;
}

function listTranscripts() {
  const out = [];
  for (const d of directoryEntries(ROOT)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    for (const entry of directoryEntries(dir)) if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(dir, entry.name));
  }
  return out;
}

function transcriptInfo(file) {
  let cwd = null, start = null, entrypoint = null, hasMsg = false;
  for (const line of readHead(file).split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain) continue;
    start ||= pathValue(o.cwd) || (o.type === 'relocated' ? pathValue(o.relocatedCwd) : null);
  }
  // Tool output and app metadata can bury the latest cwd beyond a fixed tail.
  // A rename may precede the last message, so also find the latest custom title.
  // With no custom title, scan to the beginning to establish the AI-title fallback.
  let latestTitle = null, latestCustom = null;
  for (const o of readJsonlReverse(file)) {
    if (!o || o.isSidechain) continue;
    cwd ||= pathValue(o.cwd) || (o.type === 'relocated' ? pathValue(o.relocatedCwd) : null);
    entrypoint ||= textValue(o.entrypoint);
    if (o.type === 'user' || o.type === 'assistant') hasMsg = true;
    if (o.type === 'ai-title') latestTitle ||= textValue(o.aiTitle);
    if (o.type === 'custom-title') latestCustom ||= textValue(o.customTitle);
    if (cwd && entrypoint && hasMsg && latestCustom) break;
  }
  return { cwd, start, entrypoint, hasMsg, title: latestCustom || latestTitle };
}

function startingCwd(file) {
  // Only needed when a large first record hid the origin from the head sample
  // and matching the latest cwd or app origin did not establish repository scope.
  for (const rec of readJsonl(file)) {
    if (!rec || rec.isSidechain) continue;
    const cwd = pathValue(rec.cwd) || (rec.type === 'relocated' ? pathValue(rec.relocatedCwd) : null);
    if (cwd) return cwd;
  }
  return null;
}

export function findClaudeSessions({ target, targetIsRepo, days = 14, any = false, client = 'all' }) {
  const res = [];
  const metadata = desktopSessions();
  const seen = new Set();
  for (const { file, mtime } of recentFiles(listTranscripts(), days)) {
    let info; try { info = transcriptInfo(file); } catch { continue; }
    const { start, entrypoint, hasMsg } = info;
    const sourceClient = clientFor(entrypoint);
    // sdk-cli = claude -p / SDK 调起的非交互会话，排除
    if (!hasMsg || !sourceClient) continue;
    const id = path.basename(file, '.jsonl');
    if (seen.has(id)) continue;
    seen.add(id);
    if (client !== 'all' && sourceClient !== client) continue;
    const desktop = sourceClient === 'desktop' ? metadata.get(id) : null;
    const cwd = info.cwd || desktop?.cwd || desktop?.originCwd;
    if (!cwd) continue;
    // cwd 会跟着 agent 的 cd 漂移，启动目录和最新目录任一匹配都算
    if (!any && !cwdMatches(cwd, target, targetIsRepo)) {
      if (!desktop?.originCwd || !cwdMatches(desktop.originCwd, target, targetIsRepo)) {
        let origin = start;
        if (!origin) { try { origin = startingCwd(file); } catch { continue; } }
        if (!origin || !cwdMatches(origin, target, targetIsRepo)) continue;
      }
    }
    res.push({ tool: 'claude', id, file, mtime, cwd, client: sourceClient,
      title: info.title || desktop?.title || null, ...(desktop && !desktop.isArchived ? { desktopId: desktop.desktopId } : {}) });
  }
  return res;
}

export function claudeFileById(id) {
  try { if (id.endsWith('.jsonl') && fs.statSync(id).isFile()) return id; } catch { /* It may be a session ID. */ }
  const desktop = [...desktopSessions().values()].find(metadata => metadata.desktopId === id);
  const transcriptId = desktop?.id || id;
  return recentFiles(listTranscripts(), Infinity).find(({ file }) => path.basename(file, '.jsonl') === transcriptId)?.file || null;
}

const NOISE = ['<task-notification', '<local-command-', 'Another Claude session', '[Request interrupted', 'Base directory for this skill', 'Caveat: '];

function cleanUserText(s) {
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!s || NOISE.some(p => s.startsWith(p))) return null;
  // 斜杠命令还原成用户实际敲的样子
  const name = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (name) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  return s;
}

function briefTool(name, input = {}) {
  switch (name) {
    case 'Bash': return `$ ${input.command}`;
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return `${name} ${input.file_path || input.notebook_path}`;
    case 'Grep': case 'Glob': return `${name} ${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'Agent': case 'Task': return `${name}: ${input.description || ''}`;
    case 'Skill': return `Skill /${input.skill} ${input.args || ''}`.trim();
    case 'WebFetch': return `WebFetch ${input.url}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 300)}`;
  }
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && typeof b === 'object').map(b => b.text ?? (b.type === 'image' ? M.image : '')).join('\n');
  return JSON.stringify(c);
}

// A child transcript uses the same UUID chain as its parent, but all of its
// messages are sidechain records. Keep branch selection shared with collection
// so a rewound dispatch is never described as current work.
export function claudeActiveRecords(records, { child = false } = {}) {
  const byUuid = new Map();
  let leaf = null, leafIndex = -1;
  for (const [index, rec] of records.entries()) {
    if (!rec || typeof rec !== 'object' || !rec.uuid) continue;
    byUuid.set(rec.uuid, rec);
    if ((rec.type === 'user' || rec.type === 'assistant') && (child || !rec.isSidechain)) { leaf = rec; leafIndex = index; }
  }
  const chain = [], seen = new Set();
  for (let rec = leaf; rec && !seen.has(rec.uuid); rec = rec.parentUuid ? byUuid.get(rec.parentUuid) : null) {
    seen.add(rec.uuid);
    chain.push(rec);
  }
  chain.reverse();
  // A lifecycle update or queued correction can be the newest record without
  // another chat message. Admit only the tail attached to the selected branch;
  // attachments on an earlier discarded offshoot must remain historical.
  for (let index = leafIndex + 1; index < records.length; index++) {
    const rec = records[index];
    if (rec?.type !== 'attachment' || !rec.uuid || seen.has(rec.uuid) || (!child && rec.isSidechain) || !seen.has(rec.parentUuid)) continue;
    seen.add(rec.uuid);
    chain.push(rec);
  }
  return chain;
}

export function parseClaude(file, { records, child = false } = {}) {
  const session = { tool: 'claude', file, id: path.basename(file, '.jsonl'), client: 'cli', cwd: null, model: null, permission: null, title: null, summary: null, turns: [] };
  records = records || [...readJsonl(file)];
  if (child) session.id = session.id.replace(/^agent-/, '');
  let custom = null;
  let entrypoint = null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if ((child || !rec.isSidechain) && textValue(rec.entrypoint)) entrypoint = textValue(rec.entrypoint);
    if (rec.type === 'ai-title' && textValue(rec.aiTitle)) session.title = textValue(rec.aiTitle);
    else if (rec.type === 'custom-title' && textValue(rec.customTitle)) custom = textValue(rec.customTitle);
    else if (rec.type === 'permission-mode') session.permission = rec.permissionMode;
    else if (rec.type === 'relocated' && (child || !rec.isSidechain) && pathValue(rec.relocatedCwd)) session.cwd = pathValue(rec.relocatedCwd);
    if ((child || !rec.isSidechain) && pathValue(rec.cwd)) session.cwd = pathValue(rec.cwd);
    if (child && textValue(rec.sessionId)) session.sessionId = rec.sessionId;
  }
  // 用户 /rename 或 --name 起的名字优先于自动生成的标题
  if (custom) session.title = custom;
  session.client = clientFor(entrypoint);
  const desktop = !child && session.client === 'desktop' ? desktopSessions().get(session.id) : null;
  if (desktop) {
    if (!desktop.isArchived) session.desktopId = desktop.desktopId;
    session.title ||= desktop.title;
    session.cwd ||= desktop.cwd || desktop.originCwd;
    session.permission ||= desktop.permission;
  }

  // 沿 parentUuid 从最新叶子往回走，得到当前真正生效的那条分支（rewind 掉的分支不算）；
  // 压缩边界的 parentUuid 为 null，自然停在压缩摘要处
  const chain = claudeActiveRecords(records, { child });

  let turn = null;
  const tools = new Map();
  const newTurn = user => { turn = { user, ts: null, assistant: [], reasoning: [], tools: [], interjections: [] }; session.turns.push(turn); };

  for (const rec of chain) {
    // 用户在 agent 干活途中插的话，存成 queued_command 附件，常是纠偏指令
    const a = rec.type === 'attachment' ? rec.attachment : null;
    if (a?.type === 'queued_command' && a.origin?.kind === 'human' && a.prompt) {
      if (!turn) newTurn(null);
      turn.interjections.push(String(a.prompt));
      continue;
    }
    const msg = rec.message;
    if (!msg) continue;
    if (rec.type === 'assistant') {
      if (msg.model && msg.model !== '<synthetic>') session.model = msg.model;
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (!b || typeof b !== 'object') continue;
        if (!turn) newTurn(null);
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) turn.assistant.push(b.text);
        else if (b.type === 'thinking' && b.thinking) turn.reasoning.push(b.thinking);
        else if (b.type === 'tool_use') {
          const t = { id: b.id, name: b.name, input: b.input, caller: b.caller,
            ts: rec.timestamp || null, uuid: rec.uuid,
            brief: briefTool(b.name, b.input || {}), output: null, shell: b.name === 'Bash', cwd: rec.cwd };
          turn.tools.push(t); tools.set(b.id, t);
        }
      }
      continue;
    }
    if (rec.type !== 'user' || rec.isMeta) continue;
    if (rec.isCompactSummary) { session.summary = resultText(msg.content); continue; }
    const content = msg.content;
    if (typeof content === 'string') {
      const t = cleanUserText(content);
      if (t) { newTurn(t); turn.ts = rec.timestamp; }
      continue;
    }
    const texts = [];
    for (const b of Array.isArray(content) ? content : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const t = tools.get(b.tool_use_id);
        if (t) {
          t.output = (b.is_error ? '[error]\n' : '') + resultText(b.content);
          t.isError = b.is_error === true;
          if (rec.toolUseResult !== undefined) t.resultMetadata = rec.toolUseResult;
          if (rec.toolEndsTurn !== undefined) t.toolEndsTurn = rec.toolEndsTurn;
          // Bash 失败的结果以「Exit code N」开头；权限被拒等报错没有退出码，命令根本没跑
          const code = resultText(b.content).match(/^Exit code (\d+)/);
          t.exit = code ? +code[1] : b.is_error ? null : 0;
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const t = cleanUserText(b.text);
        if (t) texts.push(t);
      } else if (b.type === 'image') texts.push(M.image);
    }
    if (texts.length) { newTurn(texts.join('\n')); turn.ts = rec.timestamp; }
  }
  return session;
}
