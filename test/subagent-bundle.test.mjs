import './helpers/provider-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { createTranscriptStore, readTranscript, writeAgentBundle } from '../lib/subagents.mjs';
import { renderHandoff } from '../lib/render.mjs';
import { snapshot } from '../lib/snapshot.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-agent-bundle-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const writeLog = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
};

test('disk capture preserves initial bytes across short reads, short writes and live appends, then survives staging cleanup', t => {
  const parent = fs.mkdtempSync(path.join(tmp, 'disk-store-'));
  const file = writeLog(path.join(parent, 'live.jsonl'), [{ text: 'հայերեն '.repeat(90000) }]);
  fs.appendFileSync(file, Buffer.from([0xe2, 0x82]));
  const before = fs.readFileSync(file);
  const store = createTranscriptStore(parent);
  const originalRead = fs.readSync, originalWrite = fs.writeSync;
  let appended = false;
  const read = t.mock.method(fs, 'readSync', (...args) => {
    args[3] = Math.min(args[3], 8191);
    const n = originalRead(...args);
    if (!appended) { appended = true; fs.appendFileSync(file, 'appended after capture began'); }
    return n;
  });
  const write = t.mock.method(fs, 'writeSync', (...args) => {
    if (Buffer.isBuffer(args[1])) args[3] = Math.min(args[3], 4093);
    return originalWrite(...args);
  });
  const source = store.capture(file);
  read.mock.restore(); write.mock.restore();
  assert.equal(source.byteLength, before.length);
  assert.equal(source.sha256, createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(fs.readFileSync(source.snapshotFile), before);
  assert.equal(source.records.length, 1);
  assert.equal(source.warnings.length, 2, 'changed source and partial UTF-8 are both explicit');
  assert.ok(!Object.hasOwn(source, 'raw') && !Object.hasOwn(source, 'content'));
  const session = { tool: 'claude', id: 'root', file, turns: [] };
  const bundle = writeAgentBundle({ directory: path.join(parent, 'bundle'), source, session, collection: { agents: [], warnings: [] } });
  fs.unlinkSync(file);
  store.cleanup(); store.cleanup();
  assert.ok(!fs.existsSync(source.snapshotFile));
  assert.deepEqual(fs.readFileSync(bundle.source), before, 'published root remains immutable without any children');
  if (process.platform !== 'win32') assert.equal(fs.statSync(bundle.source).mode & 0o777, 0o600);
});

test('disk capture cleans partial writes and CLI cleans staging when parsing fails', t => {
  const parent = fs.mkdtempSync(path.join(tmp, 'failed-store-'));
  const file = writeLog(path.join(parent, 'source.jsonl'), [{ type: 'user', text: 'request' }]);
  const store = createTranscriptStore(parent);
  const write = t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.throws(() => store.capture(file), /disk full/);
  write.mock.restore();
  const staged = fs.readdirSync(parent).find(name => name.startsWith('.capture-'));
  assert.deepEqual(fs.readdirSync(path.join(parent, staged)), []);
  store.cleanup();
  const invalid = path.join(parent, 'empty.jsonl');
  fs.writeFileSync(invalid, '');
  const hopDir = path.join(parent, 'hop');
  const run = spawnSync(process.execPath, [path.resolve('bin/hop.mjs'), 'codex', '--session', invalid, '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, HOP_DIR: hopDir },
  });
  assert.equal(run.status, 1);
  assert.deepEqual(fs.readdirSync(path.join(hopDir, 'handoffs')), []);
});

test('agent bundle preserves unabridged evidence outside the compact budget and survives source cleanup', () => {
  const assignment = 'Inspect these changes.\n' + 'հայերեն '.repeat(12000) + '\nASSIGNMENT-END';
  const report = 'RESULT-START\n~~~\n# embedded heading\n' + 'result '.repeat(15000) + 'RESULT-END';
  const file = writeLog(path.join(tmp, 'bundle-source.jsonl'), [{ type: 'user', text: 'Continue' }]);
  fs.appendFileSync(file, '{"unfinished":');
  fs.appendFileSync(file, Buffer.from([0xe2, 0x82])); // a writer stopped in the middle of a UTF-8 character
  const source = readTranscript(file);
  assert.equal(source.records.length, 1);
  assert.equal(source.warnings.length, 1);
  const session = { tool: 'claude', id: 'root', file, turns: [{ user: 'Continue', assistant: [], reasoning: [], tools: [] }] };
  const childFile = writeLog(path.join(tmp, 'bundle-child.jsonl'), [{ assignment, report }]);
  const transcript = readTranscript(childFile);
  const collection = {
    warnings: [],
    agents: [{ id: '../../untrusted-id', parentId: 'root', status: 'unknown', relation: 'confirmed', cwd: tmp,
      assignments: [{ text: assignment, kind: 'dispatch', ts: '2026-10-11T01:00:00Z' },
        { text: 'Newer correction: review only; do not edit.', kind: 'followup', ts: '2026-10-11T02:00:00Z' },
        { text: assignment, kind: 'initial_child_input', ts: '2026-10-11T01:00:00Z' }],
      events: [{ type: 'report', text: report }], warnings: [],
      transcript, session: { turns: [{ user: assignment, assistant: [report], tools: [], reasoning: [], interjections: [] }] } },
    { id: 'missing', parentId: 'root', status: 'unknown', relation: 'confirmed', warnings: ['Transcript unavailable'], transcript: null }],
  };
  for (const lang of ['en', 'zh']) {
    const directory = path.join(tmp, `bundle-${lang}`);
    const bundle = writeAgentBundle({ directory, source, session, collection, lang });
    assert.equal(bundle.count, 2);
    assert.equal(bundle.incomplete, 1);
    assert.equal(bundle.warnings, 1);
    const doc = renderHandoff({ session, snap: { cwd: tmp, exists: true, git: null, listeners: [] }, to: 'codex', budget: 6 * 1024, agentBundle: bundle, lang });
    assert.ok(Buffer.byteLength(doc) < 6 * 1024);
    assert.ok(doc.includes(bundle.index), 'the index remains reachable at the smallest render level');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const data = JSON.parse(fs.readFileSync(path.join(directory, manifest.agents[0].files.data), 'utf8'));
    assert.equal(data.assignments[0].text, assignment);
    assert.equal(data.events[0].text, report);
    assert.equal(data.session.turns[0].assistant[0], report);
    assert.equal(manifest.agents[0].followupPreviews.find(p => p.kind === 'followup').text, 'Newer correction: review only; do not edit.');
    assert.equal(bundle.recordedNoncompleted, 2);
    assert.equal(bundle.contextsWithWarnings, 1, 'uncertain lifecycle and missing evidence are separate counts');
    assert.ok(doc.includes(bundle.recovery), 'reconstruction checks survive the compact handoff budget');
    assert.equal(data.recovery.disposition, 'review-required');
    assert.equal(data.recovery.inputs[1].pointer, '/assignments/1');
    assert.equal(data.recovery.parent.data, 'source-context.json');
    assert.ok(!Object.hasOwn(manifest.agents[0], 'latestInstructionPreview'), 'cross-file collection order is not chronology');
    assert.equal(fs.readFileSync(path.join(directory, manifest.agents[0].files.transcript), 'utf8'), transcript.content);
    assert.ok(fs.readFileSync(path.join(directory, manifest.agents[0].files.context), 'utf8').includes(report));
    assert.ok(!manifest.agents[1].files.transcript, 'missing logs are explicit instead of fabricated');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    }
    assert.throws(() => writeAgentBundle({ directory, source, session, collection, lang }), /EEXIST/);
    assert.ok(fs.existsSync(bundle.index), 'collision must never remove an existing bundle');
  }
  fs.unlinkSync(file);
  fs.unlinkSync(childFile);
  const saved = fs.readFileSync(path.join(tmp, 'bundle-en', 'source.jsonl'), 'utf8');
  assert.equal(saved, source.content, 'including malformed trailing text for later inspection');
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'bundle-en', 'source.jsonl')), source.raw);
  const directory = path.join(tmp, 'bundle-en');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  for (const snapshot of manifest.evidenceSources) {
    assert.ok(fs.existsSync(path.join(directory, snapshot.file)), 'source lookup resolves after originals are deleted');
  }
  assert.ok(manifest.evidenceSources.some(s => s.original === childFile && s.file === 'agent-0001.jsonl'));
});

test('reconstruction review keeps uncertain children, pending work and stopped results separate from reusable completions', () => {
  const directory = path.join(tmp, 'recovery-bundle');
  const file = writeLog(path.join(tmp, 'recovery-source.jsonl'), [{ request: 'Continue delegated work' }]);
  const source = readTranscript(file);
  const session = { tool: 'codex', id: 'root', file, turns: [] };
  const base = { relation: 'confirmed', cwd: tmp, transcript: source, warnings: [], assignments: [{ kind: 'spawn', text: 'Review existing edits; own src/auth only.' }], events: [] };
  const collection = { warnings: [], agents: [
    { ...base, id: 'parent', parentId: 'root', status: 'completed' },
    { ...base, id: 'child', parentId: 'parent', status: 'unknown' },
    { ...base, id: 'old-turn', parentId: 'root', status: 'completed', pendingAssignmentEvidence: { file, ordinal: 8 } },
    { ...base, id: 'stopped', parentId: 'root', status: 'closed', events: [{ type: 'task_complete', status: 'completed', text: 'Existing findings' }] },
    { ...base, id: 'historical', parentId: 'root', relation: 'historical', status: 'failed' },
    { ...base, id: 'native-input', parentId: 'root', status: 'failed', assignments: [], session: { turns: [{ user: 'Review only src/auth with preserved findings' }] } },
    { ...base, id: 'missing-context', parentId: 'root', status: 'running', cwd: path.join(tmp, 'deleted-worktree'), transcript: null, assignments: [] },
  ] };
  const bundle = writeAgentBundle({ directory, source, session, collection, lang: 'en' });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const byId = Object.fromEntries(manifest.agents.map(a => [a.id, a]));
  assert.equal(byId.parent.recovery.disposition, 'reuse-results');
  assert.equal(byId.child.recovery.disposition, 'review-required');
  assert.equal(byId.parent.recovery.children[0].data, byId.child.files.data);
  assert.equal(byId.child.recovery.parent.data, byId.parent.files.data);
  assert.ok(byId['old-turn'].recovery.checks.includes('unresolved-assignment'), 'an apparent completion never hides an unresolved follow-up');
  assert.equal(byId.stopped.recovery.disposition, 'review-required', 'closed is not proof that work remains');
  assert.ok(byId.historical.recovery.checks.includes('verify-task-relevance'));
  assert.equal(byId['native-input'].recovery.disposition, 'reconstruction-candidate');
  assert.deepEqual(byId['native-input'].recovery.sessionInputs, [{ pointer: '/session/turns/0/user', readability: 'readable' }]);
  const missing = byId['missing-context'].recovery.checks;
  for (const reason of ['missing-assignment', 'missing-progress-transcript', 'workspace-unavailable']) assert.ok(missing.includes(reason));
  const review = fs.readFileSync(bundle.recovery, 'utf8');
  for (const node of manifest.agents.slice(1)) assert.ok(review.includes(node.files.context));
  assert.ok(!review.includes(byId.parent.files.context), 'a completed parent is reusable while its uncertain child remains visible');
  assert.equal(bundle.recordedNoncompleted, 5);
  assert.equal(bundle.reviewRequired, 5);
  assert.equal(bundle.reconstructionCandidates, 1);
  assert.ok(manifest.agents.every(a => a.recovery.continuationVerified === false));
});

test('bundled opaque dispatches and followups cannot qualify as available reconstruction briefs', () => {
  const directory = path.join(tmp, 'opaque-recovery-bundle');
  // Synthetic format-shaped bytes; preserve them exactly as opaque evidence.
  const opaque = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), Buffer.alloc(64, 1)]).toString('base64url');
  const file = writeLog(path.join(tmp, 'opaque-recovery-source.jsonl'), [{ opaque }]);
  const source = readTranscript(file), session = { tool: 'codex', id: 'root', file, turns: [] };
  const base = { parentId: 'root', relation: 'confirmed', cwd: tmp, transcript: source, warnings: [], events: [], status: 'completed' };
  const collection = { warnings: [], agents: [
    { ...base, id: 'opaque-spawn', assignments: [{ kind: 'spawn', text: opaque }] },
    { ...base, id: 'opaque-followup', assignments: [{ kind: 'spawn', text: 'Earlier readable brief' }, { kind: 'followup', text: opaque }] },
    { ...base, id: 'opaque-native', assignments: [], session: { turns: [{ user: opaque }] } },
    { ...base, id: 'opaque-unknown', assignments: [{ kind: 'assignment', text: null, readability: 'opaque' }] },
  ] };
  const bundle = writeAgentBundle({ directory, source, session, collection, lang: 'en', skipGit: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  for (const agent of manifest.agents) {
    assert.equal(agent.recovery.disposition, 'review-required');
    assert.ok(agent.recovery.checks.includes('opaque-assignment'));
    assert.equal(agent.recovery.checks.includes('missing-assignment'), agent.id !== 'opaque-followup');
    const data = JSON.parse(fs.readFileSync(path.join(directory, agent.files.data)));
    if (agent.id === 'opaque-spawn') {
      assert.equal(data.assignments[0].text, opaque);
      assert.equal(data.recovery.inputs[0].readability, 'opaque');
    }
    if (agent.id === 'opaque-native') assert.deepEqual(data.recovery.sessionInputs, [{ pointer: '/session/turns/0/user', readability: 'opaque' }]);
  }
  assert.equal(bundle.reusableResults, 0, 'completed observations do not hide unreadable instructions');
  assert.equal(bundle.reviewRequired, 4);
});

test('skipGit records root and cached child workspaces without invoking Git', t => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'skip-git-workspace-'));
  const file = writeLog(path.join(tmp, 'skip-git-source.jsonl'), [{ input: 'Inspect only' }]);
  const source = readTranscript(file);
  const directory = path.join(tmp, 'skip-git-bundle');
  const gitCalls = [];
  let lsofCalls = 0;
  const originalExec = childProcess.execFileSync;
  const mocked = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git') gitCalls.push(args);
    if (command === 'lsof') { lsofCalls++; return ''; }
    return originalExec(command, args, options);
  });
  syncBuiltinESMExports();
  let root;
  try {
    root = snapshot(cwd, { skipGit: true });
    writeAgentBundle({ directory, source, session: { id: 'root', tool: 'claude', file, turns: [] }, skipGit: true,
      collection: { warnings: [], agents: ['child-1', 'child-2'].map(id => ({ id, parentId: 'root', cwd,
        status: 'running', relation: 'confirmed', transcript: source, warnings: [], assignments: [{ text: 'Inspect only' }] })) } });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }

  assert.equal(root.cwd, cwd);
  assert.equal(root.exists, true);
  assert.equal(root.git, null);
  assert.equal(root.gitSkipped, true);
  assert.ok(Array.isArray(root.listeners));
  assert.equal(lsofCalls, 1, 'the root still performs its listener check');
  assert.deepEqual(gitCalls, []);
  for (let i = 1; i <= 2; i++) {
    const child = JSON.parse(fs.readFileSync(path.join(directory, `agent-${String(i).padStart(4, '0')}.json`), 'utf8'));
    assert.deepEqual(child.workspace, { cwd, exists: true, gitSkipped: true });
  }
});

test('root and child workspace snapshots do not execute configured monitors or content filters', { skip: process.platform === 'win32' }, t => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'configured-workspace-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.txt filter=hop=check\n');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'original\n');
  git('add', '.');
  const hooks = path.join(cwd, 'empty-hooks');
  fs.mkdirSync(hooks);
  git('-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Hop Test', '-c', 'user.email=test@invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const marker = path.join(cwd, 'executed'), hook = path.join(cwd, 'workspace-hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\ncat\n`, { mode: 0o700 });
  for (const key of ['core.fsmonitor', 'filter.hop=check.clean', 'filter.hop=check.smudge', 'filter.hop=check.process', 'diff.external']) git('config', key, hook);
  git('config', 'filter.hop=check.required', 'true');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'modified\n');
  const before = fs.readFileSync(path.join(cwd, '.git', 'index'));
  const root = snapshot(cwd);
  assert.match(root.git.status, /tracked\.txt/);
  assert.match(root.git.diffStat, /tracked\.txt/);
  const file = writeLog(path.join(tmp, 'configured-source.jsonl'), [{ input: 'Inspect only' }]);
  const source = readTranscript(file), directory = path.join(tmp, 'configured-bundle');
  writeAgentBundle({ directory, source, session: { id: 'root', tool: 'claude', file, turns: [] }, collection: { warnings: [],
    agents: [{ id: 'child', parentId: 'root', cwd, status: 'running', relation: 'confirmed', transcript: source, warnings: [], assignments: [{ text: 'Inspect only' }] }] } });
  const child = JSON.parse(fs.readFileSync(path.join(directory, 'agent-0001.json')));
  assert.match(child.workspace.git.status, /tracked\.txt/);
  assert.ok(!fs.existsSync(marker), 'passive snapshots must not run fsmonitor, filters or external diff');
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.git', 'index')), before, 'optional index refresh remains disabled');
  const session = { id: 'root', tool: 'claude', file, turns: [{ user: 'Inspect only', assistant: [], tools: [], reasoning: [] }] };
  const rendered = renderHandoff({ session, snap: root, to: 'codex', lang: 'en' });
  assert.match(rendered, /uncommitted changes inside submodules are not inspected/);
  const originalExec = childProcess.execFileSync;
  const mocked = t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (cmd === 'git' && args.includes('--get-regexp')) throw Object.assign(new Error('config output limit'), { code: 'ENOBUFS' });
    return originalExec(cmd, args, options);
  });
  syncBuiltinESMExports();
  try {
    const limited = snapshot(cwd);
    assert.equal(limited.git.status, null, 'configuration read failure closes working-tree inspection');
    assert.match(renderHandoff({ session, snap: limited, to: 'codex', lang: 'en' }), /status unavailable; do not assume clean/);
    assert.ok(!fs.existsSync(marker), 'a configuration read error cannot leave filters enabled');
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('desktop dry-run in both directions links complete child evidence and records the bundle in the hop log', () => {
  const workspace = path.join(tmp, 'integration-workspace');
  fs.mkdirSync(workspace);
  const home = path.join(tmp, 'integration-home');
  const prompt = 'Review only src/auth. ' + 'full assignment '.repeat(2000) + 'PROMPT-END';
  const report = 'REPORT-START ' + 'verified findings '.repeat(2000) + 'REPORT-END';
  const ccRoot = path.join(home, 'claude', 'projects', 'project', 'root.jsonl');
  const ccBase = { cwd: workspace, entrypoint: 'claude-desktop', sessionId: 'root' };
  writeLog(ccRoot, [
    { ...ccBase, type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Continue auth' } },
    { ...ccBase, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { description: 'Review auth', prompt, subagent_type: 'reviewer' } }] } },
    { ...ccBase, type: 'user', uuid: 'u2', parentUuid: 'a1', toolUseResult: { agentId: 'child', status: 'completed' }, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: report }] } },
  ]);
  const ccChild = writeLog(path.join(home, 'claude', 'projects', 'project', 'root', 'subagents', 'agent-child.jsonl'), [
    { ...ccBase, agentId: 'child', isSidechain: true, type: 'user', uuid: 'cu1', parentUuid: null, message: { content: prompt } },
    { ...ccBase, agentId: 'child', isSidechain: true, type: 'assistant', uuid: 'ca1', parentUuid: 'cu1', message: { content: [{ type: 'text', text: report }] } },
  ]);
  const cxDir = path.join(home, 'codex', 'sessions', '2026', '10', '11');
  const cxRoot = writeLog(path.join(cxDir, 'rollout-root.jsonl'), [
    { type: 'session_meta', payload: { id: 'cx-root', cwd: workspace, source: 'vscode', originator: 'Codex Desktop' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue auth' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn1', arguments: JSON.stringify({ message: prompt }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn1', output: JSON.stringify({ agent_id: 'cx-child' }) } },
  ]);
  const cxChild = writeLog(path.join(cxDir, 'rollout-cx-child.jsonl'), [
    { type: 'session_meta', payload: { id: 'cx-child', cwd: workspace, source: { subagent: { thread_spawn: { parent_thread_id: 'cx-root', depth: 1 } } } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: report }] } },
  ]);
  for (const [to, file, childFile] of [['codex', ccRoot, ccChild], ['cc', cxRoot, cxChild]]) {
    const hopDir = path.join(home, `hop-${to}`);
    const run = spawnSync(process.execPath, [path.resolve('bin/hop.mjs'), to, '--session', file, '--desktop', '--dry-run', '--budget', '6'], {
      cwd: workspace, encoding: 'utf8',
      env: { ...process.env, HOP_DIR: hopDir, HOP_LANG: 'en', CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), HOP_CLAUDE_DESKTOP_DIR: home },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Subagents 1;/);
    const record = JSON.parse(fs.readFileSync(path.join(hopDir, 'links.jsonl'), 'utf8').trim());
    assert.equal(record.agents, 1);
    const doc = fs.readFileSync(record.handoff, 'utf8');
    assert.ok(doc.includes(record.agentIndex));
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(record.agentIndex), 'manifest.json'), 'utf8'));
    const data = JSON.parse(fs.readFileSync(path.join(path.dirname(record.agentIndex), manifest.agents[0].files.data), 'utf8'));
    assert.ok(JSON.stringify(data).includes('PROMPT-END'));
    assert.ok(JSON.stringify(data).includes('REPORT-END'));
    assert.ok(data.recovery.inputs.length || data.recovery.sessionInputs.length, 'both providers expose assignment evidence for reconstruction');
    assert.ok(fs.existsSync(path.join(path.dirname(record.agentIndex), 'recovery.md')));
    assert.equal(fs.readFileSync(path.join(path.dirname(record.agentIndex), manifest.agents[0].files.transcript), 'utf8'), fs.readFileSync(childFile, 'utf8'));
    const url = new URL(run.stdout.split('\n').find(line => line.startsWith('Desktop   ')).slice('Desktop   '.length));
    assert.ok(url.searchParams.get(to === 'codex' ? 'prompt' : 'q').includes(record.handoff));
  }
});
