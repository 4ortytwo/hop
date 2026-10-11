#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HOP_DIR, gitTop, realpath } from '../lib/util.mjs';
import { findCodexSessions, codexFileById, parseCodex } from '../lib/codex.mjs';
import { findClaudeSessions, claudeFileById, parseClaude } from '../lib/claude.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { renderHandoff, TOOL_NAMES, resumeCmd, cliResumeCmd, taskName } from '../lib/render.mjs';
import { M } from '../lib/i18n.mjs';
import { buildScript, writeScript, openTab, runHere, desktopUrl, openDesktop } from '../lib/launch.mjs';
import { collectClaudeAgents } from '../lib/claude-agents.mjs';
import { collectCodexAgents } from '../lib/codex-agents.mjs';
import { createTranscriptStore, writeAgentBundle } from '../lib/subagents.mjs';
import { captureIdentity, withArtifactLock, listArtifacts, planCleanup, cleanArtifact } from '../lib/artifacts.mjs';


function parseArgs(argv) {
  const o = { extra: [], days: 14, budget: 48, source: 'all' };
  const dd = argv.indexOf('--');
  if (dd !== -1) { o.extra = argv.slice(dd + 1); argv = argv.slice(0, dd); }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') o.latest = true;
    else if (a === '--list') o.list = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--here') o.here = true;
    else if (a === '--desktop') o.desktop = true;
    else if (a === '--no-git') o.noGit = true;
    else if (['--session', '--source', '--days', '--budget'].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(M.missingValue(a));
      o[a.slice(2)] = a === '--days' || a === '--budget' ? Number(value) : value;
    }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!o.to && !a.startsWith('-')) o.to = a;
    else throw new Error(M.badArg(a));
  }
  if (!['all', 'cli', 'desktop'].includes(o.source)) throw new Error(M.badSource(o.source));
  if (!Number.isSafeInteger(o.days) || o.days <= 0) throw new Error(M.badNumber('--days'));
  if (!Number.isFinite(o.budget) || o.budget <= 0) throw new Error(M.badNumber('--budget'));
  if (o.desktop && (o.here || o.extra.length)) throw new Error(M.desktopArgs);
  if (o.session && (o.list || o.latest)) throw new Error(M.sessionArgs);
  return o;
}

const ago = ms => M.ago(Math.round((Date.now() - ms) / 60000));
const display = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function cleanup(argv) {
  let selector, list = false, yes = false, dryRun = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { console.log(M.cleanUsage); return; }
    if (arg === '--list') list = true;
    else if (arg === '--yes') yes = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (!selector && !arg.startsWith('-')) selector = arg;
    else throw new Error(M.badArg(arg));
  }
  if ((list && (selector || yes || dryRun)) || (yes && dryRun) || (!selector && (yes || dryRun))) throw new Error(M.cleanArgs);
  if (!selector) {
    const artifacts = listArtifacts().filter(a => a.status !== 'removed');
    console.log(M.cleanListHeader(HOP_DIR));
    if (!artifacts.length) console.log(M.cleanEmpty);
    for (const a of artifacts) {
      console.log(`\n${display(a.id || a.stem || '?')}  ${display(a.title || M.cleanUntitled)}  (${size(a.bytes || 0)})`);
      console.log(`  ${display(a.from)} → ${display(a.to)}  ${display(a.fromId)}${a.fromDesktopId ? ` / ${display(a.fromDesktopId)}` : ''}`);
      console.log(`  ${display(a.cwd)}\n  ${display(a.handoff)}`);
      for (const warning of a.warnings || []) console.log(`  ! ${display(warning)}`);
    }
    console.log(`\n${M.cleanListNote}`);
    return;
  }
  let plan, blocked = false;
  try { plan = yes ? cleanArtifact(selector) : planCleanup(selector); }
  catch (error) {
    if (error.code !== 'CLEANUP_BLOCKED' || !error.plan) throw error;
    plan = error.plan;
    blocked = true;
    process.exitCode = 1;
  }
  console.log(M.cleanSelected(display(plan.artifact.title || M.cleanUntitled), display(plan.artifact.id), size(plan.totalBytes)));
  console.log(`  ${display(plan.artifact.fromId)}  ${display(plan.artifact.cwd)}`);
  // The bundle is flat but can contain thousands of files; show its directory
  // once, with the exact file count, rather than dumping every transcript name.
  console.log(M.cleanPaths(display(plan.artifact.handoff), display(plan.artifact.bundle || ''), plan.files.length));
  if (plan.artifact.script) console.log(`  ${display(plan.artifact.script)}`);
  for (const warning of plan.warnings || []) console.log(`! ${display(warning)}`);
  for (const dependent of plan.dependents || []) console.log(M.cleanDependent(display(dependent.id)));
  for (const blocker of plan.blockers || []) console.log(`! ${display(blocker)}`);
  console.log(yes && !blocked ? M.cleanDeleted : plan.canClean ? M.cleanPreview(display(plan.artifact.id)) : M.cleanBlocked);
}

function main() {
  if (process.argv[2] === 'clean') return cleanup(process.argv.slice(3));
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.to) { console.log(M.usage); return; }
  const to = { cc: 'claude', claude: 'claude', codex: 'codex', cx: 'codex' }[o.to];
  if (!to) throw new Error(M.badTarget(o.to));
  const from = to === 'claude' ? 'codex' : 'claude';
  const find = from === 'codex' ? findCodexSessions : findClaudeSessions;

  const here = process.cwd();
  const top = o.noGit ? null : gitTop(here);
  const target = realpath(top || here);

  let file, scope;
  if (o.session) {
    file = from === 'codex' ? codexFileById(o.session) : claudeFileById(o.session);
    if (!file) throw new Error(M.sessionNotFound(TOOL_NAMES[from], o.session));
    scope = M.scopeGiven;
  } else {
    let cands = o.latest ? [] : find({ target, targetIsRepo: !!top, days: o.days, client: o.source });
    scope = M.scopeCwd(target);
    if (!cands.length) {
      if (!o.latest && !o.list) console.error(M.noCwdSessions(TOOL_NAMES[from]));
      cands = find({ target, targetIsRepo: !!top, days: o.days, any: true, client: o.source });
      scope = M.scopeGlobal;
    }
    if (o.list) {
      console.log(M.listHeader(TOOL_NAMES[from], scope));
      for (const c of cands.slice(0, 15)) console.log(`  ${ago(c.mtime).padEnd(8)} ${display(c.id)}  [${display(c.client)}]  ${display(c.cwd)}${c.title ? `  — ${display(c.title)}` : ''}`);
      return;
    }
    if (!cands.length) throw new Error(M.noSessions(o.days, TOOL_NAMES[from]));
    file = cands[0].file;
    // 同一目录常有多个并行会话，最近改动的那个不一定是用户想切的
    const busy = cands.filter(c => cands[0].mtime - c.mtime < 10 * 60000);
    if (busy.length > 1) {
      console.error(M.busyWarn(busy.length));
      for (const c of busy.slice(0, 5)) console.error(`   ${ago(c.mtime).padEnd(8)} ${c.id}  [${c.client}]  ${c.cwd}`);
    }
  }

  const captured = withArtifactLock(() => {
    const dir = path.join(HOP_DIR, 'handoffs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = createTranscriptStore(dir);
    try {
      const source = store.capture(file);
      const session = from === 'codex' ? parseCodex(file, { records: source.records }) : parseClaude(file, { records: source.records });
      if (o.source !== 'all' && session.client !== o.source) throw new Error(M.sourceMismatch(o.source, session.client));
      if (!session.turns.length && !session.summary) throw new Error(M.emptySession(file));
      const cwd = session.cwd || here;
      const snap = snapshot(cwd, { skipGit: o.noGit });
      if (o.desktop && !o.dryRun && (!snap.exists || !fs.statSync(cwd).isDirectory())) throw new Error(M.dirMissing(cwd));
      const identity = captureIdentity({ session, from, to, title: taskName(session) });
      const { handoff } = identity;
      const collection = from === 'codex' ? collectCodexAgents(session, source.records)
        : collectClaudeAgents(session, source.records, { capture: store.capture, compact: true });
      const agentBundle = writeAgentBundle({ directory: identity.bundle, session, source, collection, skipGit: o.noGit });
      const doc = renderHandoff({ session, snap, to, toClient: o.desktop ? 'desktop' : 'cli', budget: o.budget * 1024, agentBundle });
      fs.writeFileSync(handoff, doc, { mode: 0o600, flag: 'wx' });
      const script = !o.desktop && !o.dryRun
        ? writeScript(buildScript({ to, cwd, handoff, task: taskName(session), from: TOOL_NAMES[from], extra: o.extra }), identity.script)
        : null;
      fs.appendFileSync(path.join(HOP_DIR, 'links.jsonl'), JSON.stringify({ version: 2, captureId: identity.id, title: identity.title, ts: Date.now(), from, fromId: session.id, fromClient: session.client, fromDesktopId: session.desktopId, to, toClient: o.desktop ? 'desktop' : 'cli', cwd, handoff, ...(script ? { script } : {}), ...(agentBundle ? { agentIndex: agentBundle.index, agents: agentBundle.count } : {}) }) + '\n', { mode: 0o600 });
      return { session, cwd, snap, handoff, doc, agentBundle, script };
    } finally { store.cleanup(); }
  }); // Release staging and the mutation lock before opening/waiting on a target.
  const { session, cwd, snap, handoff, doc, agentBundle, script } = captured;

  console.log(M.outSource(`${TOOL_NAMES[from]} [${session.client}]`, session.id, scope, session.title));
  console.log(M.outCwd(cwd, snap.git?.branch));
  console.log(M.outHandoff(handoff, session.turns.length, (Buffer.byteLength(doc) / 1024).toFixed(1)));
  if (agentBundle) console.log(M.outAgents(agentBundle));
  console.log(M.outResume(resumeCmd(session)));
  if (session.client === 'desktop' && resumeCmd(session) !== cliResumeCmd(session)) console.log(`CLI       ${cliResumeCmd(session)}`);
  if (o.desktop) {
    if (to === 'claude' && /[/\\]\.claude[/\\]worktrees[/\\]/.test(cwd)) console.error(M.desktopWorktree);
    const url = desktopUrl({ to, cwd, handoff, task: taskName(session) });
    if (o.dryRun) console.log(M.desktopPreview(url));
    else { openDesktop(url); console.log(M.desktopOpened(TOOL_NAMES[to], to)); }
    return;
  }
  if (o.dryRun) return;

  if (o.here) runHere(script);
  const term = openTab(script);
  console.log(M.launched(term, TOOL_NAMES[to]));
}

try { main(); } catch (e) { console.error(`hop: ${e.message}`); process.exit(1); }
