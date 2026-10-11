import './helpers/provider-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-codex-agents-'));
process.env.CODEX_HOME = directory;
const { collectCodexAgents } = await import('../lib/codex-agents.mjs');
const { parseCodex, codexFileById } = await import('../lib/codex.mjs');
const { readTranscript } = await import('../lib/subagents.mjs');
const { assessRecovery } = await import('../lib/recovery.mjs');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const at = n => `2026-10-11T12:00:${String(n).padStart(2, '0')}Z`;
const rec = (type, payload, n = 1, ordinal) => ({ type, payload, timestamp: at(n), ...(ordinal === undefined ? {} : { ordinal }) });
const rootMeta = id => ({ id, source: 'vscode', originator: 'Codex Desktop', cwd: '/project' });
const childMeta = (id, parent, agentPath, extra = {}) => ({
  id, parent_thread_id: parent, cwd: '/project', originator: 'Codex Desktop',
  agent_path: agentPath, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: agentPath, agent_role: 'worker' } } },
  ...extra,
});
function write(meta, records = [], archived = false, tail = '') {
  const dir = archived ? path.join(directory, 'archived_sessions') : path.join(directory, 'sessions', '2026', '10', '11');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${meta.id}.jsonl`);
  fs.writeFileSync(file, [rec('session_meta', meta, 0, 0), ...records].map(r => JSON.stringify(r)).join('\n') + '\n' + tail);
  return file;
}
function call(name, args, id, n = 1, namespace = 'collaboration', ordinal) {
  return rec('response_item', { type: 'function_call', namespace, name, arguments: JSON.stringify(args), call_id: id, id: `${id}-item` }, n, ordinal);
}
const output = (id, value, n = 1, ordinal) => rec('response_item', { type: 'function_call_output', call_id: id, output: typeof value === 'string' ? value : JSON.stringify(value) }, n, ordinal);
function collect(file) {
  const source = readTranscript(file), session = parseCodex(file, { records: source.records });
  return { ...collectCodexAgents(session, source.records), session };
}
function message(kind, sender, recipient, text, n, turnId) {
  return rec('response_item', {
    type: 'agent_message', author: sender, recipient,
    content: [{ type: 'input_text', text: `Message Type: ${kind}\nTask name: ${recipient}\nSender: ${sender}\nPayload:\n${text}` }],
    ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
  }, n);
}

// Synthetic envelope bytes, not ciphertext copied from a private session.
const opaqueAssignment = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), Buffer.alloc(64, 1)]).toString('base64url');
const recoveryOf = node => assessRecovery(node, { files: { context: 'agent.md', data: 'agent.json', transcript: node.transcript?.file },
  workspace: { cwd: '/project', exists: true }, parent: { data: 'source-context.json' }, children: [] });

test('opaque spawn and encrypted delivery remain evidence without treating injected setup as a brief', () => {
  const root = write(rootMeta('opaque-root'), [
    call('spawn_agent', { task_name: 'work', message: opaqueAssignment }, 'opaque-spawn', 1),
    output('opaque-spawn', { agent_id: 'opaque-child' }, 2),
  ]);
  const delivered = message('NEW_TASK', '/root', '/root/work', '', 3, 'opaque-turn');
  delivered.payload.content.push({ type: 'encrypted_content', encrypted_content: opaqueAssignment });
  write(childMeta('opaque-child', 'opaque-root', '/root/work'), [
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nInjected setup' }] }, 2),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>Injected environment</environment_context>' }] }, 2),
    rec('event_msg', { type: 'task_started', turn_id: 'opaque-turn' }, 3), delivered,
    rec('event_msg', { type: 'task_complete', turn_id: 'opaque-turn' }, 4),
  ]);
  const node = collect(root).agents[0], recovery = recoveryOf(node);
  assert.equal(node.status, 'completed', 'input readability does not change recorded lifecycle');
  assert.deepEqual(node.assignments.map(a => [a.kind, a.readability, a.text]), [
    ['spawn', 'opaque', opaqueAssignment], ['assignment', 'opaque', opaqueAssignment],
  ]);
  assert.equal(node.assignments[1].source.contentIndex, 1);
  assert.ok(node.warnings.some(w => w.includes('opaque assignment')));
  assert.ok(node.session.turns.every(t => t.user === null));
  assert.deepEqual(recovery.sessionInputs, []);
  assert.equal(recovery.disposition, 'review-required');
  assert.ok(recovery.checks.includes('missing-assignment'));
  assert.ok(recovery.checks.includes('opaque-assignment'));
});

test('encrypted delivered corrections need review even when parent calls are missing and an earlier brief is readable', () => {
  for (const knownField of [true, false]) {
    const id = `opaque-delivery-${knownField}`, agentPath = `/root/${id}`;
    const root = write(rootMeta(`${id}-root`));
    const correction = message('MESSAGE', '/root', agentPath, '', 4);
    correction.payload.content.push(knownField ? { type: 'encrypted_content', encrypted_content: opaqueAssignment }
      : { type: 'encrypted_content', unknown_encoding: { retained: true } });
    write(childMeta(`${id}-child`, `${id}-root`, agentPath), [
      rec('event_msg', { type: 'task_started', turn_id: 'delivered-turn' }, 1),
      message('NEW_TASK', '/root', agentPath, 'Review only the requested files', 2, 'delivered-turn'), correction,
      rec('event_msg', { type: 'task_complete', turn_id: 'delivered-turn' }, 5),
    ]);
    const node = collect(root).agents[0], recovery = recoveryOf(node);
    assert.deepEqual(node.assignments.map(a => a.readability), ['readable', 'opaque']);
    assert.equal(node.assignments[1].text, knownField ? opaqueAssignment : null);
    assert.equal(node.assignments[0].text, 'Review only the requested files');
    assert.equal(recovery.disposition, 'review-required');
    assert.ok(recovery.checks.includes('opaque-assignment'));
    assert.ok(!recovery.checks.includes('missing-assignment'), 'the earlier readable brief remains available');
    assert.equal(node.transcript.records.some(r => r.payload?.content?.some(p => p.type === 'encrypted_content')), true);
  }
});

test('ordinary long text, base64 and embedded token examples stay readable', () => {
  const texts = ['Full readable assignment. '.repeat(2000), 'A'.repeat(24000), `Explain this token: ${opaqueAssignment}`, 'gAAAA' + 'A'.repeat(100), `${opaqueAssignment}=`];
  const root = write(rootMeta('long-readable-root'), texts.flatMap((text, i) => [
    call('spawn_agent', { task_name: `readable-${i}`, message: text }, `readable-spawn-${i}`, i * 2 + 1),
    output(`readable-spawn-${i}`, { agent_id: `long-readable-${i}` }, i * 2 + 2),
  ]));
  for (let i = 0; i < texts.length; i++) write(childMeta(`long-readable-${i}`, 'long-readable-root', `/root/readable-${i}`));
  for (const [i, node] of collect(root).agents.entries()) {
    assert.equal(node.assignments[0].text, texts[i]);
    assert.equal(node.assignments[0].readability, 'readable');
    assert.deepEqual(node.warnings, []);
    assert.equal(recoveryOf(node).disposition, 'reconstruction-candidate');
  }
});

test('validated metadata recovers nested archived children, latest worktree and delivered assignments', () => {
  const root = write(rootMeta('tree-root'));
  const child = write(childMeta('tree-child', 'tree-root', '/root/build', { subagent_history_start_ordinal: 999 }), [
    rec('event_msg', { type: 'task_started', turn_id: 'tree-turn' }, 1),
    message('NEW_TASK', '/root', '/root/build', 'Own implementation task', 1, 'tree-turn'),
    rec('turn_context', { cwd: '/worktrees/implementation', model: 'gpt-example' }, 2),
    rec('event_msg', { type: 'task_complete', turn_id: 'tree-turn', last_agent_message: 'Implementation report' }, 3),
    call('send_message', { target: '/root', message: 'Progress to parent' }, 'tree-progress', 4),
    output('tree-progress', '', 5),
  ], true);
  write(childMeta('tree-grandchild', 'tree-child', '/root/build/review'), [rec('event_msg', { type: 'task_started' }, 4)]);
  write({ ...rootMeta('tree-user-fork'), forked_from_id: 'tree-root', parent_thread_id: 'tree-root' });
  write({ id: 'tree-guardian', parent_thread_id: 'tree-root', source: { subagent: { other: 'guardian' } } });
  const result = collect(root);
  assert.deepEqual(result.agents.map(a => a.id), ['tree-child', 'tree-grandchild']);
  const node = result.agents[0];
  assert.equal(node.cwd, '/worktrees/implementation');
  assert.equal(node.model, 'gpt-example');
  assert.equal(node.status, 'completed');
  assert.equal(node.statusEvidence.lastKnown, true);
  assert.equal(node.assignments[0].text, 'Own implementation task', 'history ordinal is provenance, not an unconditional filter');
  assert.equal(node.transcript.file, child);
  assert.equal(Buffer.isBuffer(node.transcript.raw), true);
  assert.equal(codexFileById('tree-child'), child);
  assert.ok(node.session.turns[0].agentMessages[0].includes('Own implementation task'));
  assert.deepEqual(node.session.turns[0].interjections, [], 'agent assignments are not human steering');
  assert.equal(result.agents[1].parentId, 'tree-child');
  assert.ok(node.events.some(e => e.type === 'outgoing-message' && e.text === 'Progress to parent'));
});

test('legacy tool identities survive compaction; later successful send_input resumes a completed agent', () => {
  write(childMeta('legacy-child', 'legacy-root', null, { multi_agent_version: 'v1' }), [rec('event_msg', { type: 'task_complete', last_agent_message: 'Existing report' }, 3)]);
  const root = write(rootMeta('legacy-root'), [
    call('functions.spawn_agent', { message: 'First assignment', agent_type: 'worker' }, 'legacy-spawn', 1, undefined),
    output('legacy-spawn', { agent_id: 'legacy-child', nickname: 'Example' }, 2),
    rec('compacted', { message: 'Compact context' }, 3),
    call('wait_agent', { targets: ['legacy-child'] }, 'legacy-wait', 4, 'multi_agent_v1'),
    output('legacy-wait', { status: { 'legacy-child': { completed: 'Waited report' } }, timed_out: false }, 5),
    call('send_input', { id: 'legacy-child', message: 'Follow-up without interrupt' }, 'legacy-resume', 6, 'functions'),
    output('legacy-resume', { submission_id: 'submission-example' }, 7),
  ]);
  const result = collect(root), node = result.agents[0];
  assert.equal(node.id, 'legacy-child');
  assert.deepEqual(node.assignments.map(a => a.text), ['First assignment', 'Follow-up without interrupt']);
  assert.equal(node.status, 'running');
  assert.equal(node.statusEvidence.type, 'send_input');
  assert.ok(node.events.some(e => e.text === 'Waited report'));
  assert.equal(result.session.summary, 'Compact context');
});

test('a late successful spawn acknowledgement preserves the native child outcome', () => {
  for (const completed of [false, true]) {
    const rootId = `late-spawn-${completed}-root`, childId = `late-spawn-${completed}-child`;
    const root = write(rootMeta(rootId), [
      call('spawn_agent', { task_name: 'work', message: 'Spawned work' }, `late-spawn-${completed}`, 3),
      output(`late-spawn-${completed}`, { agent_id: childId }, 10),
    ]);
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'child-turn' }, 5),
      ...(completed ? [rec('event_msg', { type: 'task_complete', turn_id: 'child-turn' }, 7)] : []),
    ]);
    const node = collect(root).agents[0];
    assert.equal(node.status, completed ? 'completed' : 'running');
    assert.equal(node.statusEvidence.ts, at(completed ? 7 : 5));
    assert.equal(node.events.find(e => e.type === 'spawn').ts, at(10));
    assert.deepEqual(node.warnings, []);
  }
});

test('closed, interrupted, resumed and unknown statuses retain chronological evidence and reports', () => {
  write(childMeta('state-child', 'state-root', '/root/state'), [rec('event_msg', { type: 'task_complete' }, 2)]);
  const root = write(rootMeta('state-root'), [
    call('close_agent', { target: '/root/state' }, 'state-close', 3, 'multi_agent_v1'),
    output('state-close', { previous_status: { completed: 'Report before closing' } }, 4),
    call('resume_agent', { id: 'state-child' }, 'state-resume', 5, 'functions'),
    output('state-resume', { status: 'pending_init' }, 6),
    call('list_agents', {}, 'state-list', 7),
    output('state-list', { agents: [{ agent_name: '/root', agent_status: 'running' }, { agent_name: '/root/state', agent_status: 'future_state' }] }, 8),
    call('interrupt_agent', { target: 'state' }, 'state-interrupt', 9),
    output('state-interrupt', { previous_status: 'running' }, 10),
  ]);
  const result = collect(root);
  assert.equal(result.agents.length, 1, 'root list entry is never a phantom child');
  assert.equal(result.agents[0].status, 'interrupted');
  assert.equal(result.agents[0].statusEvidence.ts, at(10));
  assert.ok(result.agents[0].warnings.some(w => w.includes('Unrecognized agent status')));
  assert.deepEqual(result.agents[0].events.find(e => e.type === 'close_agent').raw.previous_status, { completed: 'Report before closing' });
});

test('missing, failed, pending and malformed child evidence stays explicit', () => {
  write(childMeta('malformed-child', 'missing-root', '/root/malformed'), [rec('event_msg', { type: 'task_started' }, 1)], false, '{"unfinished":');
  const root = write(rootMeta('missing-root'), [
    call('spawn_agent', { message: 'Missing log assignment' }, 'missing-spawn', 1, 'multi_agent_v1'),
    output('missing-spawn', { agent_id: 'deleted-child' }, 2),
    call('spawn_agent', { task_name: 'failed', message: 'Failed assignment' }, 'failed-spawn', 3),
    output('failed-spawn', { error: 'Agent limit' }, 4),
    call('spawn_agent', { task_name: 'pending', message: 'Pending assignment' }, 'pending-spawn', 5),
  ]);
  const result = collect(root);
  const missing = result.agents.find(a => a.id === 'deleted-child');
  assert.equal(missing.transcript, null);
  assert.ok(missing.warnings.length);
  assert.equal(result.agents.find(a => a.name === 'failed').status, 'failed');
  assert.equal(result.agents.find(a => a.name === 'failed').statusEvidence.ts, at(4), 'failed spawn evidence uses the failure output time');
  assert.equal(result.agents.find(a => a.name === 'pending').status, 'unknown');
  assert.ok(result.agents.find(a => a.id === 'malformed-child').warnings.some(w => w.includes('malformed')));

  const fork = write({ ...rootMeta('missing-evidence-root'), forked_from_id: 'unavailable-fork-parent' }, [
    call('spawn_agent', { task_name: 'same', message: 'Ambiguous copied assignment' }, 'missing-evidence-ambiguous', 1),
    output('missing-evidence-ambiguous', { task_name: '/root/same' }, 2),
    call('spawn_agent', { message: 'Known current assignment' }, 'missing-evidence-exact', 3, 'multi_agent_v1'),
    output('missing-evidence-exact', { agent_id: 'missing-evidence-child' }, 4),
  ]);
  write(childMeta('missing-evidence-child', 'missing-evidence-root', '/root/same'), [message('NEW_TASK', '/root', '/root/same', 'Delivered assignment', 5)]);
  const ambiguous = collect(fork), current = ambiguous.agents.find(a => a.id === 'missing-evidence-child');
  assert.deepEqual(current.assignments.map(a => a.text), ['Known current assignment', 'Delivered assignment']);
  assert.ok(ambiguous.agents.some(a => a.relation === 'unlinked' && a.assignments.some(a => a.text === 'Ambiguous copied assignment')));
  assert.ok(ambiguous.warnings.some(w => w.includes('Missing inline fork ancestor')));
});

test('functions.exec literal collaboration calls are recovered without evaluating code or matching quoted examples', () => {
  write(childMeta('wrapped-child', 'wrapped-root', '/root/wrapped'));
  const root = write(rootMeta('wrapped-root'), [
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'wrapped-call', input: "const example = 'tools.spawn_agent({task_name: fake})'; const result = await tools.collaboration__spawn_agent({task_name: 'wrapped', message: 'Literal assignment', agent_type: 'worker'}); text(result);" }, 1),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'wrapped-call', output: [{ type: 'text', text: JSON.stringify({ task_name: '/root/wrapped' }) }] }, 2),
    call('wait', { cell_id: 'code-cell' }, 'cell-wait', 3, 'functions'),
    output('cell-wait', { completed: 'Code cell output' }, 4),
  ]);
  const result = collect(root);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].assignments[0].text, 'Literal assignment');
  assert.equal(result.agents[0].status, 'running');
  assert.ok(result.session.turns[0].tools[0].output.includes('/root/wrapped'));
  assert.ok(result.session.turns[0].tools[0].rawOutput);
});

test('forked child inherited parent calls do not duplicate sibling assignments or lifecycle state', () => {
  const spawn = call('spawn_agent', { task_name: 'sibling', message: 'Sibling assignment' }, 'inherited-spawn', 1);
  const spawnResult = output('inherited-spawn', { task_name: '/root/sibling' }, 2);
  const parentDone = rec('event_msg', { type: 'task_complete', turn_id: 'parent-turn' }, 3);
  const root = write(rootMeta('inherit-root'), [spawn, spawnResult, parentDone]);
  write(childMeta('inherit-sibling', 'inherit-root', '/root/sibling'));
  write(childMeta('inherit-child', 'inherit-root', '/root/child', { forked_from_id: 'inherit-root', subagent_history_start_ordinal: 99 }), [
    spawn, spawnResult, parentDone,
    rec('event_msg', { type: 'task_started', turn_id: 'child-turn' }, 4),
    message('NEW_TASK', '/root', '/root/child', 'Own child assignment', 5, 'child-turn'),
  ]);
  const result = collect(root);
  assert.equal(result.agents.length, 2);
  assert.equal(result.agents.find(a => a.id === 'inherit-sibling').assignments.length, 1);
  assert.equal(result.agents.find(a => a.id === 'inherit-child').status, 'running');
});

test('paginated fork history exports only its recorded prefix and classifies prior agents as historical', () => {
  const baseRecords = [
    call('spawn_agent', { task_name: 'past', message: 'Past assignment' }, 'past-spawn', 1, 'collaboration', 1),
    output('past-spawn', { task_name: '/root/past' }, 2, 2),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Later unrelated private task' }] }, 9, 3),
  ];
  const base = write(rootMeta('history-base'), baseRecords);
  write(childMeta('history-child', 'history-base', '/root/past'), [rec('event_msg', { type: 'task_complete' }, 3)]);
  const root = write({ ...rootMeta('history-fork'), forked_from_id: 'history-base', history_base: { thread_id: 'history-base', end_ordinal_exclusive: 3, end_byte_offset: fs.readFileSync(base).indexOf(JSON.stringify(baseRecords[2])) } });
  const result = collect(root);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].relation, 'historical');
  assert.equal(result.agents[0].assignments[0].text, 'Past assignment');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].kind, 'history-base-prefix');
  assert.equal(result.sources[0].content.includes('Later unrelated private task'), false);
  assert.equal(result.sources[0].raw.includes(Buffer.from('Later unrelated private task')), false);
});

test('collaboration event identities and status maps are retained, and symlink transcripts are not exported', () => {
  write(childMeta('events-child', 'events-root', '/root/events'));
  const linked = path.join(directory, 'sessions', '2026', '10', '11', 'rollout-symlink-child.jsonl');
  const outside = path.join(directory, 'outside.jsonl');
  fs.writeFileSync(outside, JSON.stringify(rec('session_meta', childMeta('symlink-child', 'events-root', '/root/linked'))));
  fs.symlinkSync(outside, linked);
  const root = write(rootMeta('events-root'), [
    rec('event_msg', { type: 'collab_agent_spawn_end', receiver_thread_id: 'events-child', prompt: 'Event assignment', status: 'running' }, 1),
    rec('event_msg', { type: 'collab_waiting_end', agent_statuses: { 'events-child': { completed: 'Event report' } } }, 2),
    call('spawn_agent', { task_name: 'linked', message: 'Link assignment' }, 'link-spawn', 3),
    output('link-spawn', { agent_id: 'symlink-child' }, 4),
  ]);
  const result = collect(root);
  assert.equal(result.agents.find(a => a.id === 'events-child').status, 'completed');
  assert.equal(result.agents.find(a => a.id === 'events-child').events.at(-1).text, 'Event report');
  assert.equal(result.agents.find(a => a.id === 'symlink-child').transcript, null);
});

test('child history references do not replay root calls and historical aliases are scoped to their original parent', () => {
  const ownSpawn = call('spawn_agent', { task_name: 'same', message: 'Current assignment' }, 'dedupe-spawn', 1, 'collaboration', 1);
  const ownResult = output('dedupe-spawn', { task_name: '/root/same' }, 2, 2);
  const root = write(rootMeta('dedupe-root'), [ownSpawn, ownResult]);
  write(childMeta('dedupe-current', 'dedupe-root', '/root/same', {
    history_base: { thread_id: 'dedupe-root', end_ordinal_exclusive: 3 },
  }), [rec('event_msg', { type: 'task_complete' }, 3, 1)]);
  const deduped = collect(root);
  assert.equal(deduped.agents[0].assignments.length, 1);
  assert.equal(deduped.agents[0].events.filter(e => e.type === 'spawn').length, 1);
  assert.equal(deduped.agents[0].status, 'completed');

  write(rootMeta('alias-old-root'), [
    call('spawn_agent', { task_name: 'same', message: 'Historical assignment' }, 'alias-past-spawn', 1, 'collaboration', 1),
    output('alias-past-spawn', { task_name: '/root/same' }, 2, 2),
  ]);
  write(childMeta('alias-old-child', 'alias-old-root', '/root/same'));
  const fork = write({ ...rootMeta('alias-current-root'), history_base: { thread_id: 'alias-old-root', end_ordinal_exclusive: 3 } }, [
    call('spawn_agent', { task_name: 'same', message: 'Current fork assignment' }, 'alias-current-spawn', 4, 'collaboration', 10),
    output('alias-current-spawn', { task_name: '/root/same' }, 5, 11),
  ]);
  write(childMeta('alias-current-child', 'alias-current-root', '/root/same'));
  const aliased = collect(fork);
  assert.equal(aliased.agents.length, 2);
  assert.deepEqual(aliased.agents.find(a => a.id === 'alias-old-child').assignments.map(a => a.text), ['Historical assignment']);
  assert.deepEqual(aliased.agents.find(a => a.id === 'alias-current-child').assignments.map(a => a.text), ['Current fork assignment']);
});

test('a delayed final report cannot finish a newer child run', () => {
  const root = write(rootMeta('causal-root'), [
    call('followup_task', { target: 'run', message: 'New follow-up' }, 'causal-followup', 4),
    output('causal-followup', '', 5),
    message('FINAL_ANSWER', '/root/run', '/root', 'Previous run report delivered late', 9),
  ]);
  write(childMeta('causal-child', 'causal-root', '/root/run'), [
    rec('event_msg', { type: 'task_complete', turn_id: 'previous-turn' }, 2),
    rec('event_msg', { type: 'task_started', turn_id: 'new-turn' }, 6),
  ]);
  const result = collect(root), node = result.agents[0];
  assert.equal(node.status, 'running');
  assert.equal(node.statusEvidence.type, 'task_started');
  assert.ok(node.events.some(e => e.type === 'report' && e.text.includes('Previous run')));

  const pendingRoot = write(rootMeta('causal-pending-root'), [call('followup_task', { target: 'pending', message: 'Unacknowledged follow-up' }, 'causal-pending', 3)]);
  write(childMeta('causal-pending-child', 'causal-pending-root', '/root/pending'), [
    rec('event_msg', { type: 'task_started', turn_id: 'previous-turn' }, 1),
    rec('event_msg', { type: 'task_complete', turn_id: 'previous-turn' }, 2),
  ]);
  const pending = collect(pendingRoot).agents[0];
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.lastNativeStatus.status, 'completed');
  assert.ok(pending.warnings.some(w => w.includes('no recorded acknowledgement')));

  const deliveredRoot = write(rootMeta('causal-delivered-root'));
  write(childMeta('causal-delivered-child', 'causal-delivered-root', '/root/delivered'), [
    rec('event_msg', { type: 'task_complete', turn_id: 'old-delivered-turn' }, 2),
    message('NEW_TASK', '/root', '/root/delivered', 'New task after the old completion', 3),
  ]);
  const delivered = collect(deliveredRoot).agents[0];
  assert.equal(delivered.status, 'unknown');
  assert.ok(delivered.warnings.some(w => w.includes('no matching recorded child lifecycle acknowledgement')));

  const lateCompletionRoot = write(rootMeta('causal-old-completion-root'), [call('followup_task', { target: 'work', message: 'New work' }, 'pending-old-completion', 3)]);
  write(childMeta('causal-old-completion-child', 'causal-old-completion-root', '/root/work'), [
    rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1, 1),
    message('NEW_TASK', '/root', '/root/work', 'New work', 4),
    rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 5, 3),
  ]);
  const late = collect(lateCompletionRoot).agents[0];
  assert.equal(late.status, 'unknown', 'delivery without matching run cannot let the old turn complete new work');
  assert.equal(late.lastNativeStatus.status, 'completed');
});

test('successful work submission does not let an older native turn complete the follow-up', () => {
  for (const method of ['followup_task', 'send_input']) {
    const rootId = `acknowledged-${method}-root`, childId = `acknowledged-${method}-child`;
    const root = write(rootMeta(rootId), [
      call(method, { target: 'work', message: 'New work' }, `acknowledged-${method}`, 3),
      output(`acknowledged-${method}`, method === 'send_input' ? { submission_id: 'queued-input' } : '', 4),
    ]);
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1),
      rec('event_msg', { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'Old result' }, 5),
    ]);
    const node = collect(root).agents[0];
    assert.equal(node.status, 'unknown', method);
    assert.equal(node.pendingAssignmentEvidence.ts, at(3));
    assert.equal(node.lastNativeStatus.status, 'completed');
    assert.equal(node.lastNativeStatus.turnId, 'old-turn');
    assert.ok(node.events.some(e => e.type === 'task_complete' && e.observedStatus === 'completed' && e.text === 'Old result'));
    assert.ok(node.warnings.some(w => w.includes('no matching recorded child lifecycle acknowledgement')));
  }
});

test('failed deliveries preserve native lifecycle while keeping undelivered work and context explicit', () => {
  for (const { method, laterTurn = false } of [
    { method: 'followup_task' }, { method: 'send_input' }, { method: 'send_message' },
    { method: 'followup_task', laterTurn: true },
  ]) {
    const suffix = `${method}-${laterTurn}`, rootId = `failed-delivery-${suffix}-root`, childId = `failed-delivery-${suffix}-child`;
    const root = write(rootMeta(rootId), [
      call(method, { ...(method === 'send_input' ? { id: childId } : { target: 'work' }), message: 'Undelivered intent' }, `failed-delivery-${suffix}`, 3),
      output(`failed-delivery-${suffix}`, { error: 'Delivery rejected' }, 4),
    ]);
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1),
      rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 2),
      ...(laterTurn ? [
        rec('event_msg', { type: 'task_started', turn_id: 'unrelated-turn' }, 5),
        rec('event_msg', { type: 'task_complete', turn_id: 'unrelated-turn' }, 6),
      ] : []),
    ]);
    const node = collect(root).agents[0];
    assert.equal(node.status, 'completed', 'delivery failure does not change the native child outcome');
    assert.equal(node.statusEvidence.ts, at(laterTurn ? 6 : 2));
    assert.equal(node.pendingAssignmentEvidence, undefined, 'a failed request cannot be acknowledged by an unrelated native start');
    assert.ok(node.warnings.some(w => w.includes(`${method} delivery failed`)));
    assert.ok(node.assignments.some(a => a.text === 'Undelivered intent'));
    assert.equal(node.events.find(e => e.type === method).raw.error, 'Delivery rejected');
  }

  const root = write(rootMeta('failed-outgoing-root'));
  write(childMeta('failed-outgoing-child', 'failed-outgoing-root', '/root/work'), [
    rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 2),
    call('send_message', { target: '/root', message: 'Undelivered progress' }, 'failed-outgoing-message', 3),
    output('failed-outgoing-message', { error: 'Delivery rejected' }, 4),
  ]);
  const outgoing = collect(root).agents[0];
  assert.equal(outgoing.status, 'completed');
  assert.ok(outgoing.warnings.some(w => w.includes('send_message delivery from this agent failed')));
  assert.ok(outgoing.events.some(e => e.type === 'outgoing-message' && e.text === 'Undelivered progress' && e.raw.error === 'Delivery rejected'));
});

test('new-turn or explicit running-turn delivery can acknowledge submitted work', () => {
  for (const { delivery, ackAt, delivered = true } of [
    { delivery: 'new-turn', ackAt: 4 },
    { delivery: 'running-turn', ackAt: 4 },
    { delivery: 'new-turn-late-ack', ackAt: 10, delivered: false },
  ]) {
    const rootId = `matched-${delivery}-root`, childId = `matched-${delivery}-child`;
    const root = write(rootMeta(rootId), [
      call('followup_task', { target: 'work', message: 'New work' }, `matched-${delivery}`, 3),
      output(`matched-${delivery}`, '', ackAt),
    ]);
    const receivingTurn = delivery === 'running-turn' ? 'old-turn' : 'new-turn';
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1),
      message('NEW_TASK', '/root', '/root/work', 'Original work', 1, 'old-turn'),
      ...(receivingTurn === 'new-turn' ? [
        rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 2),
        rec('event_msg', { type: 'task_started', turn_id: receivingTurn }, 5),
      ] : []),
      ...(delivered ? [message('NEW_TASK', '/root', '/root/work', 'New work', 6, receivingTurn)] : []),
      rec('event_msg', { type: 'task_complete', turn_id: receivingTurn, last_agent_message: 'New result' }, 7),
    ]);
    const node = collect(root).agents[0];
    assert.equal(node.status, 'completed', delivery);
    assert.equal(node.statusEvidence.ts, at(7));
    assert.equal(node.pendingAssignmentEvidence, undefined);
    assert.deepEqual(node.warnings, []);
    assert.equal(node.events.find(e => e.type === 'followup_task').ts, at(ackAt), 'ACK arrival time remains event provenance');
    assert.ok(node.events.some(e => e.type === 'task_complete' && e.status === 'completed' && e.text === 'New result'));
  }

  for (const oldStartPresent of [true, false]) for (const terminalType of ['task_complete', 'turn_aborted']) {
    const suffix = `${oldStartPresent}-${terminalType}`, rootId = `started-followup-${suffix}-root`;
    const root = write(rootMeta(rootId), [
      call('followup_task', { target: 'work', message: 'New work' }, `started-followup-${suffix}`, 3),
      output(`started-followup-${suffix}`, '', 4),
    ]);
    const report = terminalType === 'task_complete' ? 'Delayed old result' : 'Delayed old interruption';
    write(childMeta(`started-followup-${suffix}-child`, rootId, '/root/work'), [
      ...(oldStartPresent ? [rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1)] : []),
      rec('event_msg', { type: 'task_started', turn_id: 'new-turn' }, 5),
      rec('event_msg', { type: terminalType, turn_id: 'old-turn', ...(terminalType === 'task_complete' ? { last_agent_message: report } : { reason: report }) }, 7),
    ]);
    const started = collect(root).agents[0];
    assert.equal(started.status, oldStartPresent ? 'running' : 'unknown', 'a different turn cannot finish the latest native turn');
    assert.equal(started.statusEvidence.ts, at(oldStartPresent ? 5 : 7));
    assert.equal(started.pendingAssignmentEvidence, undefined);
    assert.equal(started.warnings.some(w => w.includes('its own start is missing')), !oldStartPresent);
    assert.ok(started.events.some(e => e.text === report && e.observedStatus === (terminalType === 'task_complete' ? 'completed' : 'interrupted')));
  }
});

test('plain messages retain context without triggering work, while trigger_turn messages need acknowledgement', () => {
  for (const trigger of [false, true]) {
    const rootId = `message-trigger-${trigger}-root`, childId = `message-trigger-${trigger}-child`;
    const root = write(rootMeta(rootId), [
      call('send_message', { target: 'work', message: 'More context' }, `message-trigger-${trigger}`, 3),
      output(`message-trigger-${trigger}`, '', 4),
    ]);
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1),
      rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 2),
      rec('inter_agent_communication_metadata', { trigger_turn: trigger }, 5),
      message('MESSAGE', '/root', '/root/work', 'More context', 5),
    ]);
    const node = collect(root).agents[0];
    assert.equal(node.status, trigger ? 'unknown' : 'completed');
    assert.equal(!!node.pendingAssignmentEvidence, trigger);
    assert.ok(node.assignments.some(a => a.text === 'More context'));
  }
});

test('later-visited sibling follow-ups use the recipient lifecycle rather than document order', () => {
  for (const newerTurn of [false, true]) {
    const rootId = `sibling-followup-${newerTurn}-root`, childId = `a-sibling-target-${newerTurn}`;
    const root = write(rootMeta(rootId));
    write(childMeta(childId, rootId, '/root/work'), [
      rec('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1),
      rec('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, newerTurn ? 2 : 5),
      ...(newerTurn ? [
        rec('event_msg', { type: 'task_started', turn_id: 'new-turn' }, 5),
        rec('event_msg', { type: 'task_complete', turn_id: 'new-turn' }, 7),
      ] : []),
    ]);
    write(childMeta(`z-sibling-sender-${newerTurn}`, rootId, '/root/sender'), [
      call('followup_task', { target: '/root/work', message: 'Sibling follow-up' }, `sibling-followup-${newerTurn}`, 3),
      output(`sibling-followup-${newerTurn}`, '', 4),
    ]);
    const node = collect(root).agents.find(a => a.id === childId);
    assert.equal(node.status, newerTurn ? 'completed' : 'unknown');
    assert.equal(!!node.pendingAssignmentEvidence, !newerTurn);
    assert.equal(node.warnings.length, newerTurn ? 0 : 1);
    assert.ok(node.assignments.some(a => a.text === 'Sibling follow-up'));
  }
});

test('a delivered assignment cannot use the sender native turn as child acknowledgement', () => {
  const root = write(rootMeta('sender-turn-root'), [
    rec('event_msg', { type: 'task_started', turn_id: 'sender-turn' }, 1),
    message('NEW_TASK', '/root', '/root/work', 'New work', 3, 'sender-turn'),
    rec('event_msg', { type: 'task_complete', turn_id: 'sender-turn' }, 5),
  ]);
  write(childMeta('sender-turn-child', 'sender-turn-root', '/root/work'), [
    rec('event_msg', { type: 'task_complete', turn_id: 'old-child-turn' }, 2),
  ]);
  const node = collect(root).agents[0];
  assert.equal(node.status, 'unknown');
  assert.equal(node.pendingAssignmentEvidence.ts, at(3));
  assert.equal(node.lastNativeStatus.turnId, 'old-child-turn');
  assert.ok(node.warnings.some(w => w.includes('no matching recorded child lifecycle acknowledgement')));
});

test('wrapped literal escapes are decoded exactly or rejected without corrupting assignment text', () => {
  write(childMeta('escape-child', 'escape-root', '/root/escape'));
  const root = write(rootMeta('escape-root'), [
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'escape-call', input: "text(await tools.spawn_agent({task_name: 'escape', message: 'Hex \\x41 and unicode \\u0042'}));" }, 1),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'escape-call', output: [{ type: 'text', text: JSON.stringify({ task_name: '/root/escape' }) }] }, 2),
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'unsupported-call', input: "text(await tools.spawn_agent({task_name: 'escape', message: 'Brace \\u{1F603}'}));" }, 3),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'unsupported-call', output: [{ type: 'text', text: JSON.stringify({ task_name: '/root/escape' }) }] }, 4),
  ]);
  const result = collect(root);
  assert.deepEqual(result.agents[0].assignments.map(a => a.text), ['Hex A and unicode B']);
  assert.ok(result.warnings.some(w => w.includes('not interpretable')));
});

test('inline user-fork copies without history_base retain their original agent lineage', () => {
  const oldCalls = [
    call('spawn_agent', { task_name: 'build', message: 'OLD assignment' }, 'inline-old-spawn', 1, 'collaboration', 21),
    output('inline-old-spawn', { task_name: '/root/build' }, 2, 22),
  ];
  write(rootMeta('inline-fork-base'), [
    ...oldCalls,
    call('spawn_agent', { task_name: 'future', message: 'Unrelated later assignment' }, 'inline-future-spawn', 20, 'collaboration', 23),
    output('inline-future-spawn', { task_name: '/root/future' }, 21, 24),
  ]);
  write(childMeta('inline-old-build', 'inline-fork-base', '/root/build'));
  write(childMeta('inline-future', 'inline-fork-base', '/root/future'));
  const fork = write({ ...rootMeta('inline-fork'), forked_from_id: 'inline-fork-base' }, [
    ...oldCalls.map((r, i) => ({ ...r, ordinal: i + 1 })),
    call('spawn_agent', { task_name: 'build', message: 'NEW assignment' }, 'inline-new-spawn', 10, 'collaboration', 3),
    output('inline-new-spawn', { task_name: '/root/build' }, 11, 4),
  ]);
  write(childMeta('inline-new-build', 'inline-fork', '/root/build'));
  const result = collect(fork);
  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.agents.find(a => a.id === 'inline-old-build').assignments.map(a => a.text), ['OLD assignment']);
  assert.equal(result.agents.find(a => a.id === 'inline-old-build').relation, 'historical');
  assert.deepEqual(result.agents.find(a => a.id === 'inline-new-build').assignments.map(a => a.text), ['NEW assignment']);
  assert.equal(result.agents.find(a => a.id === 'inline-new-build').relation, 'confirmed');
  assert.equal(result.sources.length, 0, 'the ancestor raw suffix is neither exported nor processed');
});

test('historical and current siblings use their own tree for identical canonical path aliases', () => {
  write(rootMeta('sibling-old-root'), [
    call('spawn_agent', { task_name: 'a', message: 'Old A' }, 'sibling-old-a', 1, 'collaboration', 1),
    output('sibling-old-a', { task_name: '/root/a' }, 2, 2),
    call('spawn_agent', { task_name: 'b', message: 'Old B' }, 'sibling-old-b', 3, 'collaboration', 3),
    output('sibling-old-b', { task_name: '/root/b' }, 4, 4),
  ]);
  write(childMeta('sibling-old-a-agent', 'sibling-old-root', '/root/a'), [
    call('send_message', { target: '/root/b', message: 'Old shared API' }, 'sibling-old-message', 5, 'collaboration', 1),
    output('sibling-old-message', {}, 6, 2),
  ]);
  write(childMeta('sibling-old-b-agent', 'sibling-old-root', '/root/b'));
  const fork = write({ ...rootMeta('sibling-current-root'), history_base: { thread_id: 'sibling-old-root', end_ordinal_exclusive: 5 } });
  write(childMeta('sibling-current-a', 'sibling-current-root', '/root/a'), [
    call('send_message', { target: '/root/b', message: 'Current shared API' }, 'sibling-current-message', 7, 'collaboration', 1),
    output('sibling-current-message', {}, 8, 2),
  ]);
  write(childMeta('sibling-current-b', 'sibling-current-root', '/root/b'));
  const result = collect(fork);
  assert.equal(result.agents.length, 4, 'sibling routing never creates phantom unresolved agents');
  assert.deepEqual(result.agents.find(a => a.id === 'sibling-old-b-agent').assignments.map(a => a.text), ['Old B', 'Old shared API']);
  assert.deepEqual(result.agents.find(a => a.id === 'sibling-current-b').assignments.map(a => a.text), ['Current shared API']);
});
