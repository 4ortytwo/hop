import { clip } from './util.mjs';
import { LANG, MESSAGES } from './i18n.mjs';
import { openFailures } from './failures.mjs';

export const TOOL_NAMES = { codex: 'Codex', claude: 'Claude Code' };

export function resumeCmd(s) {
  if (s.client === 'desktop') {
    if (s.tool === 'codex') return `open 'codex://threads/${encodeURIComponent(s.id).replace(/'/g, '%27')}'`;
    if (s.desktopId) return `open 'claude://code/continue?session=${encodeURIComponent(s.desktopId)}'`;
  }
  return cliResumeCmd(s);
}

export function cliResumeCmd(s) {
  const id = /^[\w-]+$/.test(s.id) ? s.id : `'${String(s.id).replace(/'/g, `'\\''`)}'`;
  return s.tool === 'codex' ? `codex resume ${id}` : `claude --resume ${id}`;
}

// 往返交接时去掉上一次加的「（接自 X）」后缀，避免越叠越长
const HANDOFF_SUFFIX = /\s*(?:（接自 (?:Codex|Claude Code)）|\(from (?:Codex|Claude Code)\))$/;

// 任务名：源会话标题优先，没有标题就取第一句用户输入
export function taskName(s) {
  const title = s.title?.replace(HANDOFF_SUFFIX, '').trim();
  if (title) return title;
  const first = s.turns.find(t => t.user)?.user.trim().split('\n')[0];
  return first ? (first.length > 40 ? first.slice(0, 40) + '…' : first) : null;
}

// 由宽到紧的几档压缩参数，超预算就降一档
// tools = 每轮最多列几次调用，outK = 其中最后几次附带输出
const LEVELS = [
  { recent: 8, user: 4000, reply: 4000, think: 800, tools: 40, outK: 12, out: 1500, oldUser: 600, oldReply: 400, oldTools: 8 },
  { recent: 6, user: 3000, reply: 3000, think: 600, tools: 30, outK: 8, out: 1000, oldUser: 500, oldReply: 300, oldTools: 0 },
  { recent: 4, user: 2500, reply: 2500, think: 400, tools: 20, outK: 5, out: 600, oldUser: 300, oldReply: 200, oldTools: 0 },
  { recent: 3, user: 2000, reply: 2000, think: 0, tools: 12, outK: 3, out: 300, oldUser: 200, oldReply: 0, oldTools: 0 },
  { recent: 2, user: 1500, reply: 1500, think: 0, tools: 8, outK: 2, out: 200, oldUser: 120, oldReply: 0, oldTools: 0 },
  { recent: 1, user: 1500, reply: 1500, think: 0, tools: 5, outK: 0, out: 0, oldUser: 100, oldReply: 0, oldTools: 0 },
];

// 回复原文放进引用块，里面的 ## 标题就不会和交接文档自己的结构混在一起
const quote = s => s.split('\n').map(l => `> ${l}`).join('\n');
const fence = s => `~~~\n${s.replace(/~~~/g, '~ ~ ~')}\n~~~`;
const fmtTime = (ts, m) => ts ? new Date(ts).toLocaleString(m.timeLocale, { hour12: false }) : '';

function renderSnapshot(snap, m) {
  const L = [];
  if (!snap.exists) {
    L.push(m.snapGone(snap.cwd));
    return L.join('\n');
  }
  L.push(m.snapCwd(snap.cwd));
  const g = snap.git;
  if (g) {
    L.push(m.snapTop(g.top));
    L.push(m.snapBranch(g.branch, g.upstream, g.aheadBehind.replace(/\s+/, '/')));
    L.push(`- HEAD${m.sep}${g.head}`);
    if (g.passiveSnapshot) L.push(m.snapPassiveGit);
    if (g.inspectionWarnings?.length) L.push(fence(g.inspectionWarnings.join('\n')));
    L.push(`\n${m.snapStatus}\n${fence(g.status === null ? m.snapStatusUnavailable : g.status || (g.passiveSnapshot ? m.snapCleanScoped : m.snapClean))}`);
    if (g.diffStat) L.push(`${m.snapDiff}\n${fence(clip(g.diffStat, 3000))}`);
    L.push(`${m.snapLog}\n${fence(g.log)}`);
    if (g.worktrees.split('\n').length > 1) L.push(`${m.snapWorktrees}\n${fence(clip(g.worktrees, 2000))}`);
    if (g.stash) L.push(`stash${m.sep}\n${fence(clip(g.stash, 1000))}`);
  } else {
    L.push(snap.gitSkipped ? m.snapGitSkipped : m.snapNotGit);
  }
  L.push(snap.listeners.length
    ? `\n${m.snapListeners}\n${snap.listeners.map(x => `- ${x}`).join('\n')}`
    : `\n${m.snapNoListeners}`);
  return L.join('\n');
}

// 放在文档最前面、不参与逐档压缩：早期轮次的工具输出最先被裁掉，失败恰恰常藏在那里
function renderFailures(fails, m) {
  const L = [m.docFailures, m.failuresIntro];
  for (const f of fails) {
    const time = fmtTime(f.ts, m);
    L.push(`- \`${clip(f.brief.replace(/\n/g, ' ↵ '), 400).replace(/`/g, "'")}\`\n  ${f.pending ? m.failurePending(f.turn, time) : m.failureMeta(f.exit, f.turn, time, f.cwd)}`);
    if (f.output) L.push(fence(clip(f.output, 1500)));
  }
  return L.join('\n\n');
}

function renderTurnDetail(t, i, lv, m) {
  const L = [m.turnHead(i + 1, fmtTime(t.ts, m))];
  L.push(t.user ? `${m.userLabel}\n\n${fence(clip(t.user, lv.user))}` : m.userNone);
  if (t.interjections?.length) L.push(`${m.interjections}\n${t.interjections.map(x => `- ${clip(x, lv.user)}`).join('\n')}`);
  if (t.agentMessages?.length) L.push(`${m.agentMessages}\n${t.agentMessages.slice(-lv.tools).map(x => fence(clip(x, lv.reply))).join('\n')}`);
  if (lv.think && t.reasoning.length) {
    const r = t.reasoning.slice(-4).map(x => `- ${clip(x.replace(/\s+/g, ' '), lv.think)}`);
    L.push(`${m.reasoning}\n${r.join('\n')}`);
  }
  if (t.tools.length) {
    L.push(m.tools(t.tools.length));
    const shown = t.tools.slice(-lv.tools);
    if (t.tools.length > shown.length) L.push(m.toolsOmitted(t.tools.length - shown.length));
    shown.forEach((x, k) => {
      L.push(`- \`${clip(x.brief.replace(/\n/g, ' ↵ '), 400).replace(/`/g, "'")}\``);
      if (x.output != null && k >= shown.length - lv.outK) L.push(fence(clip(x.output.trim() || m.emptyOutput, lv.out)));
    });
  }
  if (t.assistant.length) L.push(`${m.reply}\n\n${quote(clip(t.assistant.join('\n\n'), lv.reply))}`);
  return L.join('\n\n');
}

function renderOldTurn(t, i, lv, m) {
  const L = [`${i + 1}. ${t.ts ? `[${fmtTime(t.ts, m)}] ` : ''}${t.user ? clip(t.user.replace(/\s+/g, ' '), lv.oldUser) : m.oldCont}`];
  for (const x of t.interjections || []) L.push(`   - ${m.oldInterjection}${clip(x.replace(/\s+/g, ' '), lv.oldUser)}`);
  if (t.agentMessages?.length) L.push(`   - ${m.agentMessages} ${t.agentMessages.length}`);
  if (lv.oldTools && t.tools.length) {
    for (const x of t.tools.slice(-lv.oldTools)) L.push(`   - \`${clip(x.brief.replace(/\s+/g, ' '), 150).replace(/`/g, "'")}\``);
    if (t.tools.length > lv.oldTools) L.push(m.oldToolsMore(t.tools.length));
  } else if (t.tools.length) L.push(m.oldToolsCount(t.tools.length));
  const last = t.assistant.at(-1);
  if (lv.oldReply && last) L.push(`   - ${m.oldReply}${clip(last.replace(/\s+/g, ' '), lv.oldReply)}`);
  return L.join('\n');
}

export function renderHandoff({ session, snap, to, toClient = 'cli', budget = 48 * 1024, lang = LANG, agentBundle = null }) {
  const from = TOOL_NAMES[session.tool], dest = `${TOOL_NAMES[to]}${toClient === 'desktop' ? ' (desktop)' : ''}`;
  const m = MESSAGES[lang];
  let doc = '';
  for (const lv of LEVELS) {
    doc = build(session, snap, from, dest, lv, m, agentBundle);
    if (Buffer.byteLength(doc) <= budget) break;
  }
  return doc;
}

function build(s, snap, from, dest, lv, m, agentBundle) {
  const turns = s.turns;
  const cut = Math.max(0, turns.length - lv.recent);
  const kv = (k, v) => `- ${k}${m.sep}${v}`;
  const L = [];
  L.push(m.docTitle(from, dest));
  L.push(m.docIntro(fmtTime(Date.now(), m), from));
  L.push(m.docGuide(from, agentBundle?.source || s.file));
  if (agentBundle) L.push(m.docAgents(agentBundle));
  const fails = openFailures(turns);
  if (fails.length) L.push(renderFailures(fails, m));

  L.push([
    `${m.docSource}\n`,
    kv(m.srcTool, `${from}${s.origin ? m.paren(s.origin) : ''}`),
    kv(m.srcId, `\`${s.id}\``),
    ...(s.client ? [kv(m.srcClient, s.client)] : []),
    ...(s.desktopId ? [kv(m.srcDesktopId, `\`${s.desktopId}\``)] : []),
    ...(s.title ? [kv(m.srcTitle, s.title)] : []),
    kv(m.srcModel, s.model || m.unknown),
    kv(m.srcPermission, s.permission || m.unknown),
    kv(m.srcTurns, `${turns.length}${s.summary ? m.srcHasSummary : ''}`),
    kv(m.srcResume, `\`${resumeCmd(s)}\``),
    ...(s.client === 'desktop' ? [kv('CLI', `\`${cliResumeCmd(s)}\``)] : []),
  ].join('\n'));

  L.push(`${m.docSnapshot}\n\n${renderSnapshot(snap, m)}`);

  if (s.summary) L.push(`${m.docSummary}\n\n${fence(clip(s.summary, 8000))}`);

  if (cut > 0) {
    L.push(`${m.docOld(cut)}\n\n${turns.slice(0, cut).map((t, i) => renderOldTurn(t, i, lv, m)).join('\n')}`);
  }
  L.push(`${m.docRecent(cut + 1, turns.length)}\n\n${turns.slice(cut).map((t, i) => renderTurnDetail(t, cut + i, lv, m)).join('\n\n---\n\n')}`);

  const lastTurn = turns.at(-1);
  if (lastTurn && !lastTurn.assistant.length) L.push(m.docInterrupted);
  return L.join('\n\n') + '\n';
}
