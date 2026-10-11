import './helpers/provider-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude } from '../lib/claude.mjs';
import { collectClaudeAgents } from '../lib/claude-agents.mjs';
import { readTranscript } from '../lib/subagents.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-claude-agents-'));
  const rootId = 'root-session', file = path.join(directory, `${rootId}.jsonl`);
  const base = { cwd: '/repo', entrypoint: 'claude-desktop', sessionId: rootId, isSidechain: false };
  const user = (uuid, parentUuid, content, extra = {}) => ({ ...base, type: 'user', uuid, parentUuid,
    timestamp: '2026-10-11T10:00:00.000Z', message: { role: 'user', content }, ...extra });
  const assistant = (uuid, parentUuid, content, extra = {}) => ({ ...base, type: 'assistant', uuid, parentUuid,
    timestamp: '2026-10-11T10:00:00.000Z', message: { model: 'claude-model', content }, ...extra });
  const write = (target, records) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    return target;
  };
  const child = (id, records, metadata, workflow = null) => {
    const dir = workflow ? path.join(directory, rootId, 'subagents', 'workflows', workflow) : path.join(directory, rootId, 'subagents');
    const target = write(path.join(dir, `agent-${id}.jsonl`), records.map(r => ({ ...r, agentId: id, isSidechain: true })));
    if (metadata) fs.writeFileSync(target.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(metadata));
    return target;
  };
  const collect = (records, options) => {
    write(file, records);
    const source = readTranscript(file), session = parseClaude(file, { records: source.records });
    return { session, ...collectClaudeAgents(session, source.records, options) };
  };
  return { directory, file, rootId, user, assistant, write, child, collect };
}
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const diskCapture = directory => {
  let captures = 0;
  return file => {
    const snapshot = readTranscript(file), snapshotFile = path.join(directory, `snapshot-${captures++}.jsonl`);
    fs.writeFileSync(snapshotFile, snapshot.raw);
    return { ...snapshot, snapshotFile };
  };
};

test('compact Claude capture retains complete recovery evidence without retaining ordinary tool payloads', () => {
  const f = fixture(), workflow = 'wf_compact';
  const prompt = 'Complete assignment '.repeat(2000), followup = 'Precise follow-up '.repeat(2000);
  const report = { findings: ['Complete report '.repeat(2000)], count: 3 };
  const ordinary = 'UNRELATED-TOOL-PAYLOAD '.repeat(20000);
  const childFile = f.child('compact-child', [
    f.user('cu', null, prompt),
    { type: 'attachment', uuid: 'noise', parentUuid: 'cu', attachment: { type: 'non_recovery_context', data: ordinary } },
    f.assistant('ca', 'noise', [tool('read-code', 'Read', { file_path: '/repo/file', unneeded: ordinary })]),
    f.user('cr', 'ca', [result('read-code', ordinary)]),
    f.user('delivered-followup', 'cr', followup, { timestamp: '2026-10-11T10:01:02.000Z' }),
    f.assistant('structured', 'delivered-followup', [tool('report', 'StructuredOutput', report)], { timestamp: '2026-10-11T10:01:03.000Z' }),
    { type: 'attachment', uuid: 'report-data', parentUuid: 'structured', attachment: { type: 'structured_output', data: report, toolUseID: 'report' } },
    f.user('accepted', 'report-data', [result('report', 'Accepted')], { toolEndsTurn: true, cwd: '/repo/exact-worktree', timestamp: '2026-10-11T10:02:00.000Z' }),
    f.assistant('final', 'accepted', [{ type: 'text', text: ordinary }], { cwd: '/repo/exact-worktree' }),
  ], { agentType: 'worker', description: 'Compact child', model: 'explicit-model', toolUseId: 'launch' }, workflow);
  const journal = path.join(path.dirname(childFile), 'journal.jsonl');
  f.write(journal, [{ type: 'started', agentId: 'compact-child' }, { type: 'result', agentId: 'compact-child', result: report }]);
  const captured = new Map();
  const capture = file => {
    const snapshot = readTranscript(file), snapshotFile = path.join(f.directory, `capture-${captured.size}.jsonl`);
    fs.writeFileSync(snapshotFile, snapshot.raw);
    captured.set(file, { snapshotFile, bytes: snapshot.raw });
    return { file, snapshotFile, byteLength: snapshot.raw.length, records: snapshot.records,
      warnings: snapshot.warnings, capturedAt: snapshot.capturedAt };
  };
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'),
    f.assistant('a', 'u', [tool('launch', 'Agent', { prompt, description: 'Compact child' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'compact-child', status: 'async_launched' } }),
    { type: 'attachment', uuid: 'root-noise', parentUuid: 'r', attachment: { type: 'non_recovery_context', data: ordinary } },
    f.assistant('message', 'root-noise', [tool('follow', 'SendMessage', { to: 'compact-child', message: 'Short serialized value' })],
      { wireToolInputs: { follow: { to: 'compact-child', message: followup } }, timestamp: '2026-10-11T10:01:00.000Z' }),
    f.user('message-result', 'message', [result('follow', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'compact-child' }, timestamp: '2026-10-11T10:01:01.000Z' }),
    f.assistant('workflow', 'message-result', [tool('workflow-launch', 'Bash', { command: ordinary })]),
    f.user('workflow-result', 'workflow', [result('workflow-launch', 'Launched workflow')], { toolUseResult: { taskType: 'local_workflow', runId: workflow, status: 'async_launched' } }),
  ], { capture, compact: true });
  const node = agents.find(agent => agent.id === 'compact-child');
  assert.equal(node.relation, 'confirmed');
  assert.equal(node.status, 'completed');
  assert.equal(node.cwd, '/repo/exact-worktree');
  assert.equal(node.model, 'explicit-model');
  assert.equal(node.session.sessionId, f.rootId);
  assert.equal(node.session.turns, undefined, 'the full normalized child conversation is not held');
  assert.equal(node.assignments.find(a => a.kind === 'dispatch').text, prompt);
  const correction = node.assignments.find(a => a.kind === 'followup');
  assert.equal(correction.text, followup, 'wire inputs retain the complete actual correction');
  assert.equal(correction.source.record, 5, 'discarded records do not renumber provenance');
  assert.equal(correction.source.currentBranch, true);
  const accepted = node.events.find(event => event.type === 'report_accepted');
  assert.equal(accepted.source.record, 8);
  assert.equal(accepted.source.currentBranch, true);
  assert.deepEqual(node.events.find(event => event.type === 'structured_report').result, report);
  assert.deepEqual(node.events.find(event => event.type === 'workflow_result').result, report);
  assert.equal(node.events.find(event => event.type === 'workflow_launch').result.runId, workflow, 'an ordinary tool can still launch a workflow');
  assert.ok(!JSON.stringify(node).includes('UNRELATED-TOOL-PAYLOAD'), 'ordinary tool bodies and chat text live only in the raw snapshot');
  for (const snapshot of [node.transcript, ...node.sources.filter(source => source.kind === 'workflow-journal')]) {
    assert.equal(snapshot.records, undefined);
    assert.equal(snapshot.raw, undefined);
    assert.equal(snapshot.content, undefined);
    fs.unlinkSync(snapshot.file);
    assert.deepEqual(fs.readFileSync(snapshot.snapshotFile), captured.get(snapshot.file).bytes, 'the complete captured bytes survive source cleanup');
  }
  fs.rmSync(f.directory, { recursive: true, force: true });
});

test('compact Claude capture cannot substitute a live file for a preserved raw snapshot', () => {
  const f = fixture();
  f.child('child', [f.user('cu', null, 'Assignment')], { toolUseId: 'launch' });
  const { agents, warnings } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Assignment' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'child', status: 'async_launched' } }),
  ], { compact: true });
  assert.equal(agents[0].transcript, null);
  assert.match(warnings.join('\n'), /preserved snapshotFile/);
  assert.match(agents[0].warnings.join('\n'), /No local transcript/);
  fs.rmSync(f.directory, { recursive: true, force: true });
});

test('compact Claude capture preserves metadata lifecycle notifications with default recovery parity', () => {
  const f = fixture();
  const variants = [
    { id: 'string-child', status: 'completed', flags: { isMeta: true }, blocks: false },
    { id: 'blocks-child', status: 'failed', flags: { isMeta: true }, blocks: true },
    { id: 'summary-child', status: 'interrupted', flags: { isCompactSummary: true }, blocks: false },
  ];
  for (const variant of variants) f.child(variant.id, [f.user(`child-${variant.id}`, null, `Assignment ${variant.id}`)], { toolUseId: `launch-${variant.id}` });
  const records = [f.user('u', null, 'Coordinate'), f.assistant('a', 'u', variants.map(variant =>
    tool(`launch-${variant.id}`, 'Agent', { prompt: `Assignment ${variant.id}` })))];
  let parent = 'a';
  for (const variant of variants) {
    const uuid = `result-${variant.id}`;
    records.push(f.user(uuid, parent, [result(`launch-${variant.id}`, 'Running')], {
      toolUseResult: { agentId: variant.id, status: 'async_launched' },
    }));
    parent = uuid;
  }
  for (const variant of variants) {
    const uuid = `notice-${variant.id}`;
    const notice = `<task-notification><task-id>${variant.id}</task-id><status>${variant.status}</status><summary>${'Full notification '.repeat(1000)}</summary></task-notification>`;
    records.push(f.user(uuid, parent, variant.blocks ? [{ type: 'text', text: notice }] : notice,
      { ...variant.flags, timestamp: '2026-10-11T10:02:00.000Z' }));
    parent = uuid;
  }
  const standard = f.collect(records);
  let captures = 0;
  const capture = file => {
    const snapshot = readTranscript(file), snapshotFile = path.join(f.directory, `parity-capture-${captures++}.jsonl`);
    fs.writeFileSync(snapshotFile, snapshot.raw);
    return { file, snapshotFile, byteLength: snapshot.raw.length, records: snapshot.records,
      warnings: snapshot.warnings, capturedAt: snapshot.capturedAt };
  };
  const compact = f.collect(records, { capture, compact: true });
  const recovery = ({ session, transcript, sources, ...view }) => view;
  assert.deepEqual(compact.agents.map(recovery), standard.agents.map(recovery), 'compact projection preserves every recovery field and original provenance');
  for (const variant of variants) {
    const node = compact.agents.find(agent => agent.id === variant.id);
    assert.equal(node.status, variant.status);
    assert.equal(node.statusEvidence.type, 'task_notification');
    assert.equal(node.statusEvidence.source.currentBranch, true);
    assert.ok(node.statusEvidence.text.includes('Full notification '.repeat(1000)), 'the lifecycle notice is retained in full');
  }
  fs.rmSync(f.directory, { recursive: true, force: true });
});

test('Claude duplicate scoped agent IDs preserve both raw logs and select the newest recorded conversation', () => {
  for (const compact of [false, true]) {
    const f = fixture();
    const newer = f.child('shared-agent', [
      f.user('new-u', null, 'Newer assignment', { cwd: '/repo/newer', timestamp: '2026-10-11T12:00:00.000Z' }),
      f.assistant('new-a', 'new-u', [{ type: 'text', text: 'Newer conversation' }], { cwd: '/repo/newer', timestamp: '2026-10-11T12:02:00.000Z' }),
    ], { toolUseId: 'launch' });
    const older = f.child('shared-agent', [
      f.user('old-u', null, 'Older workflow assignment', { cwd: '/repo/older', timestamp: '2026-10-11T11:00:00.000Z' }),
      f.assistant('old-a', 'old-u', [{ type: 'text', text: 'Older conversation' }], { cwd: '/repo/older', timestamp: '2026-10-11T11:02:00.000Z' }),
    ], { agentType: 'workflow-subagent' }, 'wf_older');
    const originals = new Map([newer, older].map(file => [file, fs.readFileSync(file)]));
    let captures = 0;
    const capture = file => {
      const snapshot = readTranscript(file), snapshotFile = path.join(f.directory, `collision-capture-${captures++}.jsonl`);
      fs.writeFileSync(snapshotFile, snapshot.raw);
      return { ...snapshot, snapshotFile, sourceMtimeMs: file === older ? 200 : 100 };
    };
    const { agents } = f.collect([
      f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Shared assignment' })]),
      f.user('r', 'a', [result('launch', 'Running')], { toolUseResult: { agentId: 'shared-agent', status: 'async_launched' } }),
    ], { capture, compact });
    assert.equal(agents.length, 1);
    const node = agents[0], history = node.sources.filter(source => source.kind === 'agent-history');
    assert.equal(node.transcript.file, newer, 'recorded chronology wins over enumeration and source modification time');
    assert.equal(node.session.file, newer);
    assert.equal(node.cwd, '/repo/newer');
    assert.equal(node.session.cwd, '/repo/newer');
    assert.equal(history.length, 1);
    assert.equal(history[0].file, older);
    assert.match(node.warnings.join('\n'), /Multiple local transcripts.*latest recorded timestamp/);
    for (const snapshot of [node.transcript, ...history]) {
      fs.unlinkSync(snapshot.file);
      assert.deepEqual(compact ? fs.readFileSync(snapshot.snapshotFile) : snapshot.raw, originals.get(snapshot.file), 'neither raw history disappears after source cleanup');
      if (compact) assert.equal(snapshot.records, undefined);
    }
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude duplicate transcript chronology falls back to captured modification time with an explicit ambiguity warning', () => {
  const f = fixture();
  const newer = f.child('shared-agent', [f.user('new-u', null, 'New assignment', { cwd: '/repo/newer', timestamp: null })]);
  const older = f.child('shared-agent', [f.user('old-u', null, 'Old assignment', { cwd: '/repo/older', timestamp: null })], null, 'wf_older');
  const capture = file => ({ ...readTranscript(file), sourceMtimeMs: file === newer ? 200 : 100 });
  const { agents } = f.collect([f.user('u', null, 'Coordinate')], { capture });
  assert.equal(agents[0].transcript.file, newer);
  assert.equal(agents[0].cwd, '/repo/newer');
  assert.equal(agents[0].sources.find(source => source.kind === 'agent-history').file, older);
  assert.match(agents[0].warnings.join('\n'), /captured source modification time; chronology is ambiguous/);
  fs.rmSync(f.directory, { recursive: true, force: true });
});

test('Claude selected primary replaces older derived metadata and model while preserving both metadata sources', () => {
  for (const compact of [false, true]) {
    const f = fixture();
    const older = f.child('shared-agent', [f.user('old-u', null, 'Old assignment', { timestamp: '2026-10-11T10:00:00.000Z' })],
      { toolUseId: 'launch', description: 'Old name', agentType: 'old-role', model: 'old-model' });
    const newer = f.child('shared-agent', [f.user('new-u', null, 'New assignment', { cwd: '/repo/newer', timestamp: '2026-10-11T11:00:00.000Z' })],
      { toolUseId: 'launch', description: 'New name', agentType: 'new-role', model: 'new-model' }, 'wf_newer');
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Old assignment' })])],
      { capture: diskCapture(f.directory), compact });
    const node = agents[0];
    assert.equal(node.transcript.file, newer);
    assert.equal(node.cwd, '/repo/newer');
    assert.equal(node.model, 'new-model');
    assert.equal(node.name, 'New name');
    assert.equal(node.role, 'new-role');
    assert.equal(node.metadata.model, 'new-model');
    assert.equal(node.metadataSource, newer.replace(/\.jsonl$/, '.meta.json'));
    assert.deepEqual(node.sources.filter(source => source.kind === 'agent-metadata').map(source => source.file).sort(),
      [newer, older].map(file => file.replace(/\.jsonl$/, '.meta.json')).sort());
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude distinct primary initial input fences historical completion without inventing a change for copied input', () => {
  for (const compact of [false, true]) for (const copied of [false, true]) {
    const f = fixture();
    const original = [
      f.user('cu', null, 'Old assignment', { timestamp: '2026-10-11T10:00:02.000Z' }),
      f.assistant('ca', 'cu', [tool('handback', 'SubagentHandback', { message: 'Old report' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
      f.user('cr', 'ca', [result('handback', 'Accepted')], { toolEndsTurn: true, timestamp: '2026-10-11T10:00:04.000Z' }),
    ];
    const historical = f.child('shared-agent', original, null, 'wf_old');
    const primary = f.child('shared-agent', copied ? [...original,
      f.assistant('tail', 'cr', [{ type: 'text', text: 'Same finished task' }], { timestamp: '2026-10-11T10:01:00.000Z' }),
    ] : [f.user('new-input', null, 'New task', { timestamp: '2026-10-11T10:01:00.000Z' })], { toolUseId: 'launch' });
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Old assignment' })]),
      f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'shared-agent', status: 'async_launched' } }),
    ], { capture: diskCapture(f.directory), compact });
    const node = agents[0];
    assert.equal(node.transcript.file, primary);
    assert.equal(node.status, copied ? 'completed' : 'unknown');
    assert.equal(node.statusEvidence.type, copied ? 'report_accepted' : 'assignment_pending');
    assert.equal(node.statusEvidence.source.file, primary);
    assert.equal(node.events.find(event => event.type === 'report_accepted' && event.source.file === historical).source.currentBranch, false);
    assert.equal(node.warnings.some(warning => warning.includes('newer assignment')), !copied);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude overlapping copied dispatches use only the primary branch for current and rewound work', () => {
  for (const compact of [false, true]) for (const rewound of [false, true]) {
    const f = fixture();
    const original = [f.user('cu', null, 'Parent assignment', { timestamp: '2026-10-11T10:00:02.000Z' }),
      f.assistant('ca', 'cu', [tool('nested-call', 'Agent', { prompt: 'Nested assignment' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
      f.user('cr', 'ca', [result('nested-call', 'Launched')], { toolUseResult: { agentId: 'nested', status: 'async_launched' }, timestamp: '2026-10-11T10:00:04.000Z' })];
    const historical = f.child('shared-agent', original, null, 'wf_old');
    const primary = f.child('shared-agent', [...original, rewound
      ? f.user('rewind', 'cu', 'Work after rewind', { timestamp: '2026-10-11T10:01:00.000Z' })
      : f.assistant('tail', 'cr', [{ type: 'text', text: 'Current nested dispatch' }], { timestamp: '2026-10-11T10:01:00.000Z' })], { toolUseId: 'launch' });
    f.child('nested', [f.user('nu', null, 'Nested assignment')], { parentAgentId: 'shared-agent', toolUseId: 'nested-call' });
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Parent assignment' })]),
      f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'shared-agent', status: 'async_launched' } }),
    ], { capture: diskCapture(f.directory), compact });
    const nested = agents.find(agent => agent.id === 'nested');
    assert.equal(nested.relation, rewound ? 'historical' : 'confirmed');
    const dispatch = nested.assignments.find(assignment => assignment.kind === 'dispatch');
    assert.equal(dispatch.source.file, primary, 'a later-scanned historical duplicate cannot replace primary call provenance');
    assert.equal(dispatch.source.currentBranch, !rewound);
    assert.equal(nested.events.find(event => event.type === 'dispatch_result' && event.source.file === historical).source.currentBranch, false);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude acknowledged main-conversation messages stay on their sender with compact recovery parity', () => {
  const f = fixture(), message = 'Complete outgoing report '.repeat(2000);
  const acknowledgement = { success: true, message: "Message queued for the main conversation's next turn." };
  f.child('sender', [
    f.user('cu', null, 'Sender assignment'),
    f.assistant('report', 'cu', [tool('handback', 'SubagentHandback', { message: 'Accepted report' })]),
    f.user('accepted', 'report', [result('handback', 'Accepted')], { toolEndsTurn: true }),
    f.assistant('outgoing', 'accepted', [tool('message-main', 'SendMessage', { to: 'main', summary: 'Report', message })]),
    f.user('queued', 'outgoing', [result('message-main', [{ type: 'text', text: JSON.stringify(acknowledgement) }])]),
  ], { toolUseId: 'launch' });
  const records = [f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Sender assignment' })]),
    f.user('r', 'a', [result('launch', 'Running')], { toolUseResult: { agentId: 'sender', status: 'async_launched' } })];
  const standard = f.collect(records);
  const capture = file => {
    const snapshot = readTranscript(file), snapshotFile = path.join(f.directory, 'main-capture.jsonl');
    fs.writeFileSync(snapshotFile, snapshot.raw);
    return { ...snapshot, snapshotFile };
  };
  const compact = f.collect(records, { capture, compact: true });
  const recovery = ({ session, transcript, sources, ...view }) => view;
  assert.deepEqual(compact.agents.map(recovery), standard.agents.map(recovery));
  assert.equal(compact.agents.length, 1, 'main conversation routing does not invent a child agent');
  const node = compact.agents[0], request = node.events.find(event => event.type === 'outgoing_message');
  assert.equal(request.input.message, message);
  assert.equal(request.text, message);
  assert.equal(request.destination, 'main-conversation');
  assert.deepEqual(node.events.find(event => event.type === 'outgoing_message_result').result, acknowledgement);
  assert.ok(!node.assignments.some(assignment => assignment.kind === 'followup'), 'outgoing reports are not new instructions to the sender');
  assert.equal(node.status, 'completed', 'sending a report does not resume its sender');
  fs.rmSync(f.directory, { recursive: true, force: true });
});

test('Claude main aliases require routing proof and preserve agents actually named main', () => {
  for (const namedMain of [false, true]) {
    const f = fixture();
    f.child('sender', [f.user('cu', null, 'Sender assignment'),
      f.assistant('outgoing', 'cu', [tool('message-main', 'SendMessage', { to: 'main', message: 'Complete message' })]),
      f.user('queued', 'outgoing', [result('message-main', JSON.stringify({ success: true,
        message: namedMain ? "Message queued for the main conversation's next turn." : 'Accepted' }))]),
    ], { toolUseId: 'launch' });
    if (namedMain) f.child('real-main', [f.user('main-u', null, 'Actual main assignment')], { description: 'main', toolUseId: 'launch-main' });
    const launches = [tool('launch', 'Agent', { prompt: 'Sender assignment' })];
    if (namedMain) launches.push(tool('launch-main', 'Agent', { description: 'main', prompt: 'Actual main assignment' }));
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', launches),
      f.user('r', 'a', [result('launch', 'Running')], { toolUseResult: { agentId: 'sender', status: 'async_launched' } })]);
    assert.equal(agents.length, 2);
    assert.ok(!agents.find(agent => agent.id === 'sender').events.some(event => event.type === 'outgoing_message'));
    if (namedMain) {
      assert.equal(agents.find(agent => agent.id === 'real-main').assignments.find(assignment => assignment.kind === 'followup').text, 'Complete message');
      assert.ok(!agents.some(agent => agent.id.startsWith('message:')));
    } else assert.match(agents.find(agent => agent.id.startsWith('message:')).warnings.join('\n'), /recipient main could not be resolved/);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude queued background-job notices remain events and only identified agent notices update lifecycle', () => {
  for (const compact of [false, true]) {
    const f = fixture(), workflow = 'wf_notices';
    const origin = { kind: 'task-notification', producer: 'session-task' };
    const background = `<task-notification><task-id>background-job-test</task-id><status>completed</status><summary>${'Complete Bash output '.repeat(1000)}</summary></task-notification>`;
    const agentNotice = '<task-notification><task-id>known-agent</task-id><tool-use-id>launch-known</tool-use-id><status>completed</status></task-notification>';
    const file = f.child('workflow-owner', [f.user('cu', null, 'Workflow assignment'),
      f.assistant('ca', 'cu', [tool('launch-known', 'Agent', { prompt: 'Known assignment' }), tool('bash', 'Bash', { command: 'background job' })]),
      f.user('cr', 'ca', [result('launch-known', 'Running')], { toolUseResult: { agentId: 'known-agent', status: 'async_launched' } }),
      f.user('br', 'cr', [result('bash', 'Background job started')]),
      { type: 'attachment', uuid: 'bash-notice', parentUuid: 'br', timestamp: '2026-10-11T10:01:00.000Z', attachment: { type: 'queued_command', origin, prompt: background } },
      { type: 'attachment', uuid: 'agent-notice', parentUuid: 'bash-notice', timestamp: '2026-10-11T10:02:00.000Z', attachment: { type: 'queued_command', origin, prompt: agentNotice } },
    ], null, workflow);
    f.child('known-agent', [f.user('known-u', null, 'Known assignment')], { parentAgentId: 'workflow-owner', toolUseId: 'launch-known' });
    f.write(path.join(path.dirname(file), 'journal.jsonl'), [{ type: 'started', agentId: 'workflow-owner' },
      { type: 'result', agentId: 'workflow-owner', result: { done: 'Workflow finished' } }]);
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('workflow', 'Bash', { command: 'Workflow' })]),
      f.user('r', 'a', [result('workflow', 'Launched')], { toolUseResult: { taskType: 'local_workflow', runId: workflow } }),
    ], { capture: diskCapture(f.directory), compact });
    const owner = agents.find(agent => agent.id === 'workflow-owner'), known = agents.find(agent => agent.id === 'known-agent');
    assert.equal(agents.length, 2, 'a Bash-job ID never becomes a synthetic agent');
    assert.equal(owner.status, 'completed');
    assert.ok(!owner.assignments.some(assignment => assignment.kind === 'queued_followup'));
    assert.ok(!owner.events.some(event => event.type === 'task_notification'), 'background completion never defaults to the owner lifecycle');
    const recorded = owner.events.find(event => event.type === 'queued_task_notification' && event.source.uuid === 'bash-notice');
    assert.equal(recorded.text, background);
    assert.deepEqual(recorded.origin, origin);
    assert.equal(recorded.result.prompt, background);
    assert.equal(recorded.source.record, 5);
    assert.equal(known.status, 'completed');
    assert.equal(known.statusEvidence.type, 'task_notification');
    assert.equal(known.statusEvidence.text, agentNotice);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude adjacent workflow harness request and computed-task messages are one initial assignment', () => {
  for (const compact of [false, true]) for (const status of ['completed', 'failed']) for (const identity of ['legacy', 'prompt-id']) {
    const f = fixture(), workflow = 'wf_harness', request = '[Workflow harness — user request]\nFull original request';
    const computed = '[Workflow harness — computed task]\nFull computed assignment';
    const first = identity === 'prompt-id' ? { promptId: 'initial-prompt' } : {};
    const second = identity === 'prompt-id' ? { promptId: 'initial-prompt', timestamp: '2026-10-11T10:00:00.001Z' } : {};
    const file = f.child('harness-child', [f.user('cu', null, request, first), f.user('computed', 'cu', computed, second),
      f.assistant('ca', 'computed', [{ type: 'text', text: 'Work report' }]),
    ], null, workflow);
    f.write(path.join(path.dirname(file), 'journal.jsonl'), [{ type: 'started', agentId: 'harness-child' },
      { type: status === 'completed' ? 'result' : 'failed', agentId: 'harness-child', result: { detail: 'Explicit workflow outcome' } }]);
    const { agents } = f.collect([f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('workflow', 'Bash', { command: 'Workflow' })]),
      f.user('r', 'a', [result('workflow', 'Launched')], { toolUseResult: { taskType: 'local_workflow', runId: workflow } }),
    ], { capture: diskCapture(f.directory), compact });
    const child = agents[0];
    assert.equal(child.status, status);
    assert.deepEqual(child.assignments.map(assignment => [assignment.kind, assignment.text]), [['initial_child_input', request], ['initial_child_input', computed]]);
    assert.ok(!child.warnings.some(warning => warning.includes('newer assignment')));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude workflow harness grouping preserves later and ordinary pre-reply correction boundaries', () => {
  for (const compact of [false, true]) for (const boundary of ['later-timestamp', 'assistant-work', 'ordinary-input', 'different-prompt', 'partial-prompt', 'nonadjacent']) {
    const f = fixture(), workflow = 'wf_harness';
    const promptIdentity = ['different-prompt', 'partial-prompt'].includes(boundary) ? { promptId: 'initial-prompt' } : {};
    const records = [f.user('cu', null, '[Workflow harness — user request]\nOriginal request', promptIdentity)];
    if (boundary === 'assistant-work') records.push(f.assistant('ca', 'cu', [{ type: 'text', text: 'Work already started' }]));
    if (boundary === 'nonadjacent') records.push(f.user('meta', 'cu', 'Intervening context', { isMeta: true }));
    records.push(f.user('correction', boundary === 'assistant-work' ? 'ca' : boundary === 'nonadjacent' ? 'meta' : 'cu',
      boundary === 'ordinary-input' ? 'Actual corrective input' : '[Workflow harness — computed task]\nNew assignment',
      { timestamp: boundary === 'later-timestamp' ? '2026-10-11T10:01:00.000Z' : '2026-10-11T10:00:00.000Z',
        ...(boundary === 'different-prompt' ? { promptId: 'correction-prompt' } : {}) }));
    const file = f.child('harness-child', records, null, workflow);
    f.write(path.join(path.dirname(file), 'journal.jsonl'), [{ type: 'result', agentId: 'harness-child', result: { done: 'Previous task' } }]);
    const { agents } = f.collect([f.user('u', null, 'Coordinate')], { capture: diskCapture(f.directory), compact });
    assert.equal(agents[0].assignments.at(-1).kind, 'child_input');
    assert.equal(agents[0].status, 'unknown');
    assert.equal(agents[0].statusEvidence.type, 'assignment_pending');
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude exact native child interruption is lifecycle evidence with compact recovery parity', () => {
  for (const blocks of [false, true]) {
    const f = fixture(), marker = '[Request interrupted by user]';
    f.child('agent', [
      f.user('cu', null, 'Original assignment', { timestamp: '2026-10-11T10:00:01.000Z' }),
      f.assistant('ca', 'cu', [{ type: 'text', text: 'Original work' }], { timestamp: '2026-10-11T10:00:02.000Z' }),
      f.user('correction', 'ca', 'New assignment', { timestamp: '2026-10-11T10:00:04.000Z' }),
      f.user('interrupted', 'correction', blocks ? [{ type: 'text', text: marker }] : marker,
        { timestamp: '2026-10-11T10:00:05.000Z' }),
    ], { toolUseId: 'launch' });
    const records = [f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Original assignment' })]),
      f.user('r', 'a', [result('launch', 'Completed')], { toolUseResult: { agentId: 'agent', status: 'completed' }, timestamp: '2026-10-11T10:00:02.000Z' }),
      f.assistant('resume', 'r', [tool('new-request', 'Agent', { resume: 'agent', prompt: 'New assignment' })], { timestamp: '2026-10-11T10:00:03.000Z' })];
    const standard = f.collect(records), compact = f.collect(records, { capture: diskCapture(f.directory), compact: true });
    const recovery = ({ session, transcript, sources, ...view }) => view;
    assert.deepEqual(compact.agents.map(recovery), standard.agents.map(recovery));
    const node = compact.agents[0];
    assert.equal(node.status, 'interrupted', 'the current child request ended even when its parent resume result was never recorded');
    assert.equal(node.statusEvidence.type, 'child_interrupted');
    assert.equal(node.statusEvidence.source.record, 4);
    assert.equal(node.statusEvidence.source.currentBranch, true);
    assert.equal(node.statusEvidence.text, marker);
    assert.ok(!node.assignments.some(assignment => assignment.text === marker), 'a native interruption is never a new assignment');
    assert.equal(node.assignments.at(-1).text, 'New assignment');
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude interruption handling preserves ordinary input, discarded branches and later resume boundaries', () => {
  for (const compact of [false, true]) for (const boundary of ['quoted', 'surrounding', 'mixed-content', 'discarded', 'later-input', 'later-resume', 'undated-resume', 'undelivered-resume']) {
    const f = fixture(), marker = '[Request interrupted by user]';
    const native = !['quoted', 'surrounding', 'mixed-content'].includes(boundary);
    const content = boundary === 'quoted' ? `"${marker}"` : boundary === 'surrounding' ? `${marker}\nContinue investigating` :
      boundary === 'mixed-content' ? [{ type: 'text', text: marker }, { type: 'image', source: { type: 'base64', data: 'image' } }] : marker;
    const child = [f.user('cu', null, 'Original assignment', { timestamp: '2026-10-11T10:00:01.000Z' }),
      f.assistant('ca', 'cu', [{ type: 'text', text: 'Working' }], { timestamp: '2026-10-11T10:00:02.000Z' }),
      f.user('notice', 'ca', content, { timestamp: boundary === 'undelivered-resume' ? '2026-10-11T10:00:05.000Z' : '2026-10-11T10:00:03.000Z' })];
    if (boundary === 'discarded') child.push(f.assistant('current', 'ca', [{ type: 'text', text: 'Current branch' }], { timestamp: '2026-10-11T10:00:04.000Z' }));
    if (boundary === 'later-input') child.push(f.user('new-input', 'notice', 'Actual new assignment', { timestamp: '2026-10-11T10:00:04.000Z' }));
    f.child('agent', child, { toolUseId: 'launch' });
    const records = [f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Original assignment' })]),
      f.user('r', 'a', [result('launch', 'Running')], { toolUseResult: { agentId: 'agent', status: 'async_launched' }, timestamp: '2026-10-11T10:00:02.000Z' })];
    if (['later-resume', 'undated-resume', 'undelivered-resume'].includes(boundary)) records.push(f.assistant('resume', 'r', [tool('new-request', 'Agent', { resume: 'agent', prompt: 'New assignment' })],
      { timestamp: boundary === 'undated-resume' ? null : boundary === 'undelivered-resume' ? '2026-10-11T10:00:03.000Z' : '2026-10-11T10:00:04.000Z' }));
    const { agents } = f.collect(records, { capture: diskCapture(f.directory), compact });
    const node = agents[0];
    assert.equal(node.status, boundary === 'discarded' ? 'running' : 'unknown', `${boundary}, compact=${compact}`);
    assert.equal(node.events.some(event => event.type === 'child_interrupted'), native);
    if (!native) assert.equal(node.assignments.at(-1).kind, 'child_input', 'ordinary content remains an assignment boundary');
    if (boundary === 'discarded') assert.equal(node.events.find(event => event.type === 'child_interrupted').source.currentBranch, false);
    if (['later-input', 'later-resume', 'undated-resume', 'undelivered-resume'].includes(boundary)) assert.equal(node.statusEvidence.type, 'assignment_pending');
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude native request interruption does not overwrite a terminal workflow invocation outcome', () => {
  for (const compact of [false, true]) for (const boundary of ['completed', 'failed', 'new-input', 'repeated-run']) {
    const f = fixture(), workflow = 'wf_interruption';
    const child = [f.user('cu', null, 'Original assignment'),
      f.user('interrupted', 'cu', '[Request interrupted by user]', { timestamp: '2026-10-11T10:00:01.000Z' })];
    if (boundary === 'new-input') child.push(f.user('new-input', 'interrupted', 'New assignment', { timestamp: '2026-10-11T10:00:02.000Z' }));
    else child.push(f.assistant('report', 'interrupted', [{ type: 'text', text: 'Workflow outcome' }], { timestamp: '2026-10-11T10:00:02.000Z' }));
    const file = f.child('agent', child, null, workflow);
    const journal = [{ type: 'started', agentId: 'agent', key: 'request-1' }];
    if (boundary === 'repeated-run') journal.push({ type: 'started', agentId: 'agent', key: 'request-2' });
    journal.push({ type: boundary === 'failed' ? 'failed' : 'result', agentId: 'agent', key: boundary === 'repeated-run' ? 'request-2' : 'request-1', result: 'Explicit workflow outcome' });
    f.write(path.join(path.dirname(file), 'journal.jsonl'), journal);
    const { agents } = f.collect([f.user('u', null, 'Coordinate')], { capture: diskCapture(f.directory), compact });
    const node = agents[0];
    assert.equal(node.status, ['new-input', 'repeated-run'].includes(boundary) ? 'unknown' : boundary);
    assert.ok(node.events.some(event => event.type === 'child_interrupted'), 'the request interruption remains recoverable');
    if (['completed', 'failed'].includes(boundary)) assert.equal(node.statusEvidence.type, boundary === 'completed' ? 'workflow_result' : 'workflow_failed');
    if (boundary === 'new-input') assert.equal(node.statusEvidence.type, 'assignment_pending');
    if (boundary === 'repeated-run') assert.match(node.warnings.join('\n'), /multiple untimestamped workflow invocations/);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('Claude preserves full assignment, report, resumed follow-up and exact child cwd', () => {
  const f = fixture(), prompt = 'assignment '.repeat(2000), report = 'report '.repeat(3000), followup = 'correction '.repeat(2000);
  const childFile = f.child('agent-one', [
    f.user('c1', null, prompt),
    f.assistant('c2', 'c1', [tool('bash', 'Bash', { command: 'check', workdir: '/repo/worktree' })]),
    f.user('c3', 'c2', [result('bash', report)], { cwd: '/repo/.claude/worktrees/exact' }),
    f.assistant('c4', 'c3', [{ type: 'text', text: 'Still investigating.' }], { cwd: '/repo/.claude/worktrees/exact' }),
  ], { agentType: 'worker', description: 'Bounded assignment', toolUseId: 'launch', spawnDepth: 1 });
  const value = f.collect([
    f.user('u', null, 'Coordinate the task'),
    f.assistant('a', 'u', [tool('launch', 'Agent', { prompt, description: 'Bounded assignment', subagent_type: 'worker', run_in_background: true })]),
    f.user('r', 'a', [result('launch', report)], { toolUseResult: { agentId: 'agent-one', status: 'completed', prompt, handbackReport: { text: report } } }),
    f.assistant('follow', 'r', [tool('message', 'SendMessage', { to: 'agent-one', message: followup, content: 'legacy shorter value' })],
      { wireToolInputs: { message: { to: 'agent-one', message: followup } }, timestamp: '2026-10-11T10:01:00.000Z' }),
    f.user('message-result', 'follow', [result('message', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'agent-one', pin: { id: 'agent-one', name: 'Bounded assignment' } }, timestamp: '2026-10-11T10:01:01.000Z' }),
  ]);
  assert.equal(value.agents.length, 1);
  const agent = value.agents[0];
  assert.equal(agent.relation, 'confirmed');
  assert.equal(agent.status, 'running', 'A resumed agent is no longer last recorded as completed');
  assert.equal(agent.cwd, '/repo/.claude/worktrees/exact');
  assert.equal(agent.transcript.file, childFile);
  assert.ok(Buffer.isBuffer(agent.transcript.raw));
  assert.equal(agent.assignments.find(a => a.kind === 'dispatch').text, prompt);
  assert.equal(agent.assignments.find(a => a.kind === 'followup').text, followup);
  assert.equal(agent.events.find(e => e.type === 'handback_report').result.text, report);
  assert.equal(agent.session.turns[0].tools[0].input.command, 'check');
  assert.equal(agent.session.turns[0].tools[0].output, report);
  assert.equal(agent.session.turns[0].tools[0].id, 'bash');
  assert.equal(agent.session.sessionId, f.rootId);
});

test('Claude metadata and child dispatches retain nested agents and accepted handbacks', () => {
  const f = fixture();
  f.child('parent-agent', [
    f.user('pu', null, 'Own parent files'),
    f.assistant('pa', 'pu', [tool('nested-launch', 'Agent', { description: 'Nested work', prompt: 'Own nested files', subagent_type: 'explorer' })]),
    f.user('pr', 'pa', [result('nested-launch', 'Launched')], { toolUseResult: { agentId: 'nested-agent', status: 'async_launched' } }),
  ], { agentType: 'worker', toolUseId: 'launch', spawnDepth: 1 });
  f.child('nested-agent', [
    f.user('nu', null, 'Own nested files'),
    f.assistant('na', 'nu', [tool('handback', 'SubagentHandback', { message: 'Detailed final report' })]),
    f.user('nr', 'na', [result('handback', 'Report accepted')], { toolEndsTurn: true, timestamp: '2026-10-11T10:02:00.000Z' }),
  ], { agentType: 'explorer', parentAgentId: 'parent-agent', toolUseId: 'nested-launch', spawnDepth: 2 });
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Own parent files' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'parent-agent', status: 'async_launched' } }),
  ]);
  const nested = agents.find(a => a.id === 'nested-agent');
  assert.equal(nested.parentId, 'parent-agent');
  assert.equal(nested.relation, 'confirmed');
  assert.equal(nested.status, 'completed');
  assert.equal(nested.events.find(e => e.type === 'handback_report').text, 'Detailed final report');
});

test('Claude keeps pre-compaction and rewound dispatch evidence historical', () => {
  const f = fixture();
  f.child('old-agent', [f.user('child-u', null, 'Old task'), f.assistant('child-a', 'child-u', [{ type: 'text', text: 'A reply is not a lifecycle result' }])], { toolUseId: 'old-call' });
  const value = f.collect([
    f.user('u1', null, 'Initial task'),
    f.assistant('old-branch', 'u1', [tool('old-call', 'Task', { prompt: 'Old task', description: 'Previous branch' })]),
    f.user('old-result', 'old-branch', [result('old-call', 'Launched')], { toolUseResult: { agentId: 'old-agent', status: 'async_launched' } }),
    f.assistant('rewound', 'u1', [tool('precompact', 'Agent', { prompt: 'Historical task before compaction' })]),
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null, logicalParentUuid: 'rewound' },
    f.user('summary', 'compact', 'Compacted task summary', { isCompactSummary: true }),
    f.user('current', 'summary', 'Proceed with current task'),
    f.assistant('current-launch', 'current', [tool('current-call', 'Agent', { prompt: 'Current assignment' })]),
  ]);
  assert.equal(value.session.summary, 'Compacted task summary');
  assert.deepEqual(value.session.turns.flatMap(t => t.tools.map(t => t.id)), ['current-call']);
  assert.equal(value.agents.find(a => a.id === 'old-agent').relation, 'historical');
  assert.equal(value.agents.find(a => a.id.includes('precompact')).relation, 'historical');
  assert.equal(value.agents.find(a => a.id.includes('current-call')).relation, 'confirmed');
  assert.equal(value.agents.find(a => a.id === 'old-agent').assignments.find(a => a.kind === 'dispatch').source.currentBranch, false);
});

test('Claude desktop workflow journals preserve structured reports and missing failed children', () => {
  const f = fixture(), workflow = 'wf_example-123', report = { filesChanged: ['src/file.js'], done: ['detail '.repeat(10000)] };
  const childFile = f.child('workflow-child', [
    f.user('wu', null, 'Workflow assignment'),
    f.assistant('wa', 'wu', [tool('structured', 'StructuredOutput', report)]),
    { type: 'attachment', uuid: 'report', parentUuid: 'wa', attachment: { type: 'structured_output', data: report, toolUseID: 'structured' } },
    f.user('wr', 'report', [result('structured', 'Accepted')], { toolEndsTurn: true }),
  ], { agentType: 'workflow-subagent', workflowPhase: 'Build', description: 'Workflow child', spawnDepth: 1 }, workflow);
  const journal = path.join(path.dirname(childFile), 'journal.jsonl');
  f.write(journal, [
    { type: 'launched' }, { type: 'started', agentId: 'workflow-child', key: 'key', label: 'Child', phase: 'Build' },
    { type: 'result', agentId: 'workflow-child', key: 'key', result: report },
    { type: 'started', agentId: 'missing-workflow-child', key: 'missing' }, { type: 'failed', agentId: 'missing-workflow-child', key: 'missing' },
  ]);
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('workflow-launch', 'Bash', { command: 'workflow script' })]),
    f.user('r', 'a', [result('workflow-launch', 'Started')], { toolUseResult: { taskType: 'local_workflow', taskId: 'workflow-task', runId: workflow, transcriptDir: '/unrelated/path', status: 'async_launched' } }),
  ]);
  const child = agents.find(a => a.id === 'workflow-child'), missing = agents.find(a => a.id === 'missing-workflow-child');
  assert.equal(child.relation, 'confirmed');
  assert.equal(child.status, 'completed');
  assert.deepEqual(child.events.find(e => e.type === 'structured_report').result, report);
  assert.deepEqual(child.events.find(e => e.type === 'workflow_result').result, report);
  assert.equal(child.events.find(e => e.type === 'workflow_result').ts, null, 'Journal has no invented timestamp');
  assert.ok(Buffer.isBuffer(child.sources.find(s => s.kind === 'workflow-journal').raw));
  assert.equal(missing.status, 'failed');
  assert.equal(missing.relation, 'confirmed');
  assert.match(missing.warnings.join('\n'), /No local transcript/);
});

test('Claude missing, failed, malformed and symlinked records stay explicit', () => {
  const f = fixture();
  const malformed = f.child('malformed-agent', [f.user('cu', null, 'Partial child')], { toolUseId: 'partial-launch' });
  fs.appendFileSync(malformed, '{"type":"assistant","unfinished":');
  const scope = path.dirname(malformed), outside = f.write(path.join(f.directory, 'unrelated.jsonl'), [f.user('private', null, 'Unrelated evidence')]);
  fs.symlinkSync(outside, path.join(scope, 'agent-symlink.jsonl'));
  fs.symlinkSync(outside, malformed.replace(/\.jsonl$/, '.meta.json') + '.ignored');
  const { agents, warnings } = f.collect([
    f.user('u', null, 'Coordinate'),
    f.assistant('a', 'u', [tool('failed-launch', 'Agent', { prompt: 'Failed dispatch' }), tool('pending-launch', 'Agent', { prompt: 'Pending dispatch' }), tool('partial-launch', 'Agent', { prompt: 'Partial child' })]),
    f.user('r', 'a', [result('failed-launch', 'Dispatch error', { is_error: true })]),
  ]);
  assert.equal(agents.find(a => a.id.includes('failed-launch')).status, 'failed');
  assert.equal(agents.find(a => a.id.includes('pending-launch')).status, 'unknown');
  const partial = agents.find(a => a.id === 'malformed-agent');
  assert.match(partial.warnings.join('\n'), /malformed or incomplete/);
  assert.match(partial.transcript.content, /unfinished/);
  assert.equal(agents.some(a => a.id === 'symlink'), false);
  assert.match(warnings.join('\n'), /Skipped symlink/);
});

test('Claude lifecycle notifications are separate from bash jobs and arbitrary replies', () => {
  const f = fixture();
  f.child('agent-life', [f.user('cu', null, 'Do work'), f.assistant('ca', 'cu', [{ type: 'text', text: 'Work is being checked' }])], { toolUseId: 'launch' });
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Do work' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'agent-life', status: 'async_launched' } }),
    { type: 'attachment', uuid: 'bash-status', parentUuid: 'r', attachment: { type: 'task_status', taskType: 'local_bash', taskId: 'bash-job', status: 'completed' } },
    f.user('notification', 'bash-status', '<task-notification><task-id>agent-life</task-id><tool-use-id>launch</tool-use-id><status>completed</status><result>Full report</result></task-notification>'),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'completed');
  assert.match(agents[0].events.find(e => e.type === 'task_notification').text, /Full report/);
});

test('Claude desktop task chips preserve queued assignments and dismissals without guessing sessions', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('chip', 'mcp__ccd_session__spawn_task', { prompt: 'Queued original task', title: 'Queue' })]),
    f.user('r', 'a', [result('chip', 'Task added (position 1, task_id: task_1234abcd). Currently pending.')], { toolUseResult: [{ type: 'text', text: 'Task added.' }] }),
    f.assistant('dismiss', 'r', [tool('remove', 'mcp__ccd_session__dismiss_task', { task_id: 'task_1234abcd', reason: 'No longer needed' })]),
    f.user('removed', 'dismiss', [result('remove', 'Task dismissed')]),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'task_1234abcd');
  assert.equal(agents[0].kind, 'queued-desktop-task');
  assert.equal(agents[0].status, 'closed');
  assert.equal(agents[0].assignments[0].text, 'Queued original task');
  assert.match(agents[0].warnings.join('\n'), /without a recorded local session/);
});

test('Claude child parser terminates malformed parent UUID cycles', () => {
  const f = fixture(), file = f.child('cycle', [f.user('u', 'a', 'Input'), f.assistant('a', 'u', [{ type: 'text', text: 'Reply' }])]);
  const parsed = parseClaude(file, { child: true });
  assert.equal(parsed.turns.length, 1);
  assert.deepEqual(parsed.turns[0].assistant, ['Reply']);
});

test('Claude discarded lifecycle results and unsuccessful resume requests do not claim completion or running', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('launch', 'u', [tool('dispatch', 'Agent', { prompt: 'Assignment' })]),
    f.user('discarded-result', 'launch', [result('dispatch', 'Completed in discarded branch')], { toolUseResult: { agentId: 'missing-child', status: 'completed' } }),
    f.user('alternate', 'launch', 'Continue after rewind'),
    f.assistant('resume-request', 'alternate', [tool('resume', 'Agent', { resume: 'missing-child', prompt: 'Follow-up after rewind' })]),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].relation, 'confirmed');
  assert.equal(agents[0].status, 'unknown');
  assert.ok(agents[0].events.some(e => e.type === 'dispatch_result' && !e.source.currentBranch));
  assert.ok(agents[0].events.some(e => e.type === 'resume_requested'));
});

test('Claude SendMessage pin aliases resolve to one agent and retain full follow-up', () => {
  const f = fixture();
  f.child('agent-real', [f.user('cu', null, 'Assignment')], { toolUseId: 'launch', description: 'Reviewer name' });
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('launch-a', 'u', [tool('launch', 'Agent', { prompt: 'Assignment' })]),
    f.user('launch-r', 'launch-a', [result('launch', 'Started')], { toolUseResult: { agentId: 'agent-real', status: 'async_launched' } }),
    f.assistant('message-a', 'launch-r', [tool('message', 'SendMessage', { to: '@pin:reviewer', message: 'Full follow-up' })]),
    f.user('message-r', 'message-a', [result('message', 'Message delivered')], { toolUseResult: { success: true, pin: { id: 'agent-real', name: 'Reviewer name', ref: '@pin:reviewer' } } }),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].assignments.find(a => a.kind === 'followup').text, 'Full follow-up');
});

test('Claude ListAgents records narrow evidenced rows and warns on missing child logs', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('listing', 'ListAgents', {})]),
    f.user('r', 'a', [result('listing', 'Listing')], { toolUseResult: { listing: 'Agents (1):\n  a1234567890abcdef  ·  Reviewer  ·  running  ·  Review bounded change\nDo not infer completed from this sentence.' } }),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'a1234567890abcdef');
  assert.equal(agents[0].name, 'Reviewer');
  assert.equal(agents[0].status, 'running');
  assert.equal(agents[0].relation, 'confirmed');
  assert.match(agents[0].warnings.join('\n'), /No local transcript/);
});

test('Claude explicit child dispatch establishes nesting when metadata is absent', () => {
  const f = fixture();
  f.child('parent', [
    f.user('pu', null, 'Parent assignment'),
    f.assistant('pa', 'pu', [tool('nested-call', 'Agent', { prompt: 'Nested assignment' })]),
    f.user('pr', 'pa', [result('nested-call', 'Launched')], { toolUseResult: { agentId: 'nested', status: 'async_launched' } }),
  ]);
  f.child('nested', [f.user('nu', null, 'Nested assignment')]);
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('parent-call', 'Agent', { prompt: 'Parent assignment' })]),
    f.user('r', 'a', [result('parent-call', 'Launched')], { toolUseResult: { agentId: 'parent', status: 'async_launched' } }),
  ]);
  assert.equal(agents.find(a => a.id === 'nested').parentId, 'parent');
  assert.equal(agents.find(a => a.id === 'nested').relation, 'confirmed');
});

test('Claude trailing active lifecycle attachment updates status while discarded offshoots stay historical', () => {
  const f = fixture();
  const base = [
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('parent-call', 'Agent', { prompt: 'Assignment' })]),
    f.user('r', 'a', [result('parent-call', 'Launched')], { toolUseResult: { agentId: 'parent', status: 'async_launched' } }),
  ];
  const status = { type: 'attachment', uuid: 'status', parentUuid: 'r', timestamp: '2026-10-11T10:01:00.000Z',
    attachment: { type: 'task_status', taskType: 'local_agent', taskId: 'parent', status: 'completed' } };
  const active = f.collect([...base, status]);
  assert.equal(active.agents[0].status, 'completed');
  assert.equal(active.agents[0].statusEvidence.source.currentBranch, true);
  const historical = f.collect([...base, status, f.user('alternate', 'r', 'Continue after rewind')]);
  assert.equal(historical.agents[0].status, 'running');
  assert.equal(historical.agents[0].events.find(e => e.type === 'task_status').source.currentBranch, false);
});

test('Claude legacy text-only Task agent IDs recover their adjacent child transcript', () => {
  const f = fixture();
  const legacy = f.write(path.join(f.directory, 'agent-legacy.jsonl'), [
    { ...f.user('cu', null, 'Legacy child assignment'), isSidechain: true, agentId: 'legacy' },
  ]);
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Task', { prompt: 'Legacy child assignment' })]),
    f.user('r', 'a', [result('launch', 'Task done\nagentId: legacy (for resuming)')]),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].transcript.file, legacy);
  assert.equal(agents[0].session.turns[0].user, 'Legacy child assignment');
});

test('Claude valid JSON with malformed child message shapes retains raw evidence and warnings', () => {
  const f = fixture();
  const childFile = f.child('malformed-shape', [
    f.user('cu', null, 'Child input'),
    f.assistant('ca', 'cu', [null, { type: 'text' }, { type: 'text', text: 'Valid reply' }]),
  ], { toolUseId: 'launch' });
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Child input' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'malformed-shape', status: 'async_launched' } }),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].transcript.file, childFile);
  assert.match(agents[0].warnings.join('\n'), /Malformed message content/);
  assert.deepEqual(agents[0].session.turns[0].assistant, ['Valid reply']);
});

test('Claude deeply nested current relationships resolve independently of directory order', () => {
  const f = fixture();
  const childDispatch = (id, next) => f.child(id, [
    f.user(`${id}-u`, null, `Assignment ${id}`),
    f.assistant(`${id}-a`, `${id}-u`, [tool(`${id}-call`, 'Agent', { prompt: `Assignment ${next}` })]),
    f.user(`${id}-r`, `${id}-a`, [result(`${id}-call`, 'Launched')], { toolUseResult: { agentId: next, status: 'async_launched' } }),
  ]);
  f.child('a-grandchild', [f.user('grand-u', null, 'Assignment a-grandchild')]);
  childDispatch('y-child', 'a-grandchild');
  childDispatch('z-parent', 'y-child');
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Assignment z-parent' })]),
    f.user('r', 'a', [result('launch', 'Launched')], { toolUseResult: { agentId: 'z-parent', status: 'async_launched' } }),
  ]);
  assert.equal(agents.find(a => a.id === 'a-grandchild').parentId, 'y-child');
  assert.equal(agents.find(a => a.id === 'y-child').parentId, 'z-parent');
  assert.ok(agents.every(a => a.relation === 'confirmed'));
});

test('Claude metadata-only agents preserve identity and metadata when launch has no result', () => {
  const f = fixture(), scope = path.join(f.directory, f.rootId, 'subagents');
  fs.mkdirSync(scope, { recursive: true });
  const metadataFile = path.join(scope, 'agent-known.meta.json');
  fs.writeFileSync(metadataFile, JSON.stringify({ toolUseId: 'launch', agentType: 'worker', description: 'Known assignment', spawnDepth: 1, custom: 'Retain custom fields' }));
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Pending original assignment' })]),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'known');
  assert.equal(agents[0].relation, 'confirmed');
  assert.equal(agents[0].metadata.custom, 'Retain custom fields');
  assert.equal(agents[0].sources[0].file, metadataFile);
  assert.ok(Buffer.isBuffer(agents[0].sources[0].raw));
  assert.match(agents[0].warnings.join('\n'), /No local transcript/);
});

test('Claude delayed completion from an older dispatch does not end a resumed assignment', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'),
    f.assistant('a', 'u', [tool('initial', 'Agent', { prompt: 'Initial assignment' })], { timestamp: '2026-10-11T10:00:01.000Z' }),
    f.user('r', 'a', [result('initial', 'Launched')], { toolUseResult: { agentId: 'agent', status: 'async_launched' }, timestamp: '2026-10-11T10:00:02.000Z' }),
    f.assistant('follow', 'r', [tool('followup', 'SendMessage', { to: 'agent', message: 'New assignment' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
    f.user('resumed', 'follow', [result('followup', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'agent' }, timestamp: '2026-10-11T10:00:04.000Z' }),
    f.user('late', 'resumed', '<task-notification><task-id>agent</task-id><tool-use-id>initial</tool-use-id><status>completed</status><result>Initial work done</result></task-notification>', { timestamp: '2026-10-11T10:00:05.000Z' }),
  ]);
  assert.equal(agents[0].status, 'running');
  assert.equal(agents[0].statusEvidence.runToolId, 'followup');
  assert.equal(agents[0].events.find(e => e.type === 'task_notification').supersededRun, true);
  assert.deepEqual(agents[0].runs.map(r => r.toolId), ['initial', 'followup']);
});

test('Claude terminal lifecycle attachments without run IDs after a resume stay uncertain', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('initial', 'Agent', { prompt: 'Initial' })]),
    f.user('r', 'a', [result('initial', 'Launched')], { toolUseResult: { agentId: 'agent', status: 'async_launched' }, timestamp: '2026-10-11T10:00:01.000Z' }),
    f.assistant('follow', 'r', [tool('followup', 'SendMessage', { to: 'agent', message: 'New assignment' })], { timestamp: '2026-10-11T10:00:02.000Z' }),
    f.user('resumed', 'follow', [result('followup', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'agent' }, timestamp: '2026-10-11T10:00:03.000Z' }),
    { type: 'attachment', uuid: 'status', parentUuid: 'resumed', timestamp: '2026-10-11T10:00:04.000Z', attachment: { type: 'task_status', taskType: 'local_agent', taskId: 'agent', status: 'completed' } },
  ]);
  assert.equal(agents[0].status, 'unknown');
  assert.equal(agents[0].statusEvidence.ambiguousRun, true);
  assert.match(agents[0].warnings.join('\n'), /no dispatch\/run ID/);
});

test('Claude current root follow-ups establish relevance independently of an old metadata parent', () => {
  const f = fixture();
  f.child('child', [f.user('cu', null, 'Prior child assignment')], { parentAgentId: 'old-parent' });
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('message', 'SendMessage', { to: 'child', message: 'Current assignment' })]),
    f.user('r', 'a', [result('message', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'child' } }),
  ]);
  const child = agents.find(a => a.id === 'child');
  assert.equal(child.relation, 'confirmed');
  assert.equal(child.parentId, 'old-parent');
  assert.equal(child.status, 'running');
});

test('Claude an uncorrelated completion after the first recorded resume stays uncertain', () => {
  const f = fixture();
  const { agents } = f.collect([
    f.user('u', null, 'Continue a prior agent'), f.assistant('a', 'u', [tool('resume', 'SendMessage', { to: 'prior-agent', message: 'New assignment' })]),
    f.user('r', 'a', [result('resume', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'prior-agent' } }),
    { type: 'attachment', uuid: 'status', parentUuid: 'r', attachment: { type: 'task_status', taskType: 'local_agent', taskId: 'prior-agent', status: 'completed' } },
  ]);
  assert.equal(agents[0].runs.length, 1);
  assert.equal(agents[0].runs[0].isResume, true);
  assert.equal(agents[0].status, 'unknown');
  assert.match(agents[0].warnings.join('\n'), /no dispatch\/run ID/);
});

test('Claude pending Agent resume and newer child input fence completion from the old assignment', () => {
  const f = fixture();
  f.child('agent', [
    f.user('cu', null, 'Initial assignment', { timestamp: '2026-10-11T10:00:01.000Z' }),
    f.assistant('ca', 'cu', [tool('handback', 'SubagentHandback', { message: 'Initial report' })], { timestamp: '2026-10-11T10:00:02.000Z' }),
    f.user('cr', 'ca', [result('handback', 'Accepted')], { toolEndsTurn: true, timestamp: '2026-10-11T10:00:02.500Z' }),
    f.user('new-input', 'cr', 'New assignment', { timestamp: '2026-10-11T10:00:04.000Z' }),
  ]);
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('initial', 'Agent', { prompt: 'Initial assignment' })], { timestamp: '2026-10-11T10:00:01.000Z' }),
    f.user('r', 'a', [result('initial', 'Completed')], { toolUseResult: { agentId: 'agent', status: 'completed' }, timestamp: '2026-10-11T10:00:02.000Z' }),
    f.assistant('resume-request', 'r', [tool('resume', 'Agent', { resume: 'agent', prompt: 'New assignment' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
    f.user('late', 'resume-request', '<task-notification><task-id>agent</task-id><tool-use-id>initial</tool-use-id><status>completed</status><result>Initial done</result></task-notification>', { timestamp: '2026-10-11T10:00:05.000Z' }),
  ]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'unknown');
  assert.equal(agents[0].statusEvidence.type, 'assignment_pending');
  assert.ok(agents[0].events.some(e => e.type === 'handback_report' && e.text === 'Initial report'));
  assert.ok(agents[0].assignments.some(a => a.kind === 'child_input' && a.text === 'New assignment'));
});

test('Claude child acceptance after the latest input establishes completion even without a parent resume result', () => {
  const f = fixture();
  f.child('agent', [
    f.user('cu', null, 'Initial assignment', { timestamp: '2026-10-11T10:00:01.000Z' }),
    f.user('new-input', 'cu', 'New assignment', { timestamp: '2026-10-11T10:00:04.000Z' }),
    f.assistant('ca', 'new-input', [tool('handback', 'SubagentHandback', { message: 'Latest report' })], { timestamp: '2026-10-11T10:00:06.000Z' }),
    f.user('cr', 'ca', [result('handback', 'Accepted')], { toolEndsTurn: true, timestamp: '2026-10-11T10:00:07.000Z' }),
  ]);
  const { agents } = f.collect([
    f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('initial', 'Agent', { prompt: 'Initial assignment' })], { timestamp: '2026-10-11T10:00:01.000Z' }),
    f.user('r', 'a', [result('initial', 'Completed')], { toolUseResult: { agentId: 'agent', status: 'completed' }, timestamp: '2026-10-11T10:00:02.000Z' }),
    f.assistant('resume-request', 'r', [tool('resume', 'Agent', { resume: 'agent', prompt: 'New assignment' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
    f.user('late', 'resume-request', '<task-notification><task-id>agent</task-id><tool-use-id>initial</tool-use-id><status>completed</status><result>Initial done</result></task-notification>', { timestamp: '2026-10-11T10:00:08.000Z' }),
  ]);
  assert.equal(agents[0].status, 'completed');
  assert.equal(agents[0].statusEvidence.type, 'report_accepted');
  assert.equal(agents[0].statusEvidence.ts, '2026-10-11T10:00:07.000Z');
});

test('Claude delayed report acceptance cannot end a correction before its input reaches the child', () => {
  for (const compact of [false, true]) for (const boundary of ['old-invocation', 'undelivered-input', 'tied-input', 'queued-input', 'current-input']) {
    const f = fixture();
    const child = [f.user('cu', null, 'Original assignment', { timestamp: '2026-10-11T10:00:01.000Z' })];
    const delivered = ['queued-input', 'current-input'].includes(boundary);
    if (boundary === 'queued-input') child.push({ type: 'attachment', uuid: 'correction', parentUuid: 'cu', timestamp: '2026-10-11T10:00:04.500Z',
      attachment: { type: 'queued_command', prompt: 'New correction' } });
    if (['current-input', 'tied-input'].includes(boundary)) child.push(f.user('correction', 'cu', 'New correction',
      { timestamp: boundary === 'tied-input' ? '2026-10-11T10:00:03.000Z' : '2026-10-11T10:00:04.500Z' }));
    child.push(f.assistant('ca', delivered || boundary === 'tied-input' ? 'correction' : 'cu', [tool('report', 'SubagentHandback', { message: 'Preserved report' })],
      { timestamp: boundary === 'old-invocation' ? '2026-10-11T10:00:02.000Z' : '2026-10-11T10:00:04.750Z' }));
    child.push(f.user('cr', 'ca', [result('report', 'Accepted')], { toolEndsTurn: true, timestamp: '2026-10-11T10:00:05.000Z' }));
    f.child('agent', child, { toolUseId: 'launch' });
    const { agents } = f.collect([
      f.user('u', null, 'Coordinate'), f.assistant('a', 'u', [tool('launch', 'Agent', { prompt: 'Original assignment' })], { timestamp: '2026-10-11T10:00:01.000Z' }),
      f.user('r', 'a', [result('launch', 'Running')], { toolUseResult: { agentId: 'agent', status: 'async_launched' }, timestamp: '2026-10-11T10:00:02.000Z' }),
      f.assistant('follow', 'r', [tool('followup', 'SendMessage', { to: 'agent', message: 'New correction' })], { timestamp: '2026-10-11T10:00:03.000Z' }),
      f.user('ack', 'follow', [result('followup', 'Resumed')], { toolUseResult: { success: true, resumedAgentId: 'agent' }, timestamp: '2026-10-11T10:00:04.000Z' }),
    ], { capture: diskCapture(f.directory), compact });
    const node = agents[0], accepted = node.events.find(event => event.type === 'report_accepted');
    assert.equal(node.status, delivered ? 'completed' : 'running', `${boundary}, compact=${compact}`);
    assert.equal(node.statusEvidence.type, delivered ? 'report_accepted' : 'message_result');
    assert.equal(accepted.invocation.source.uuid, 'ca', 'full report invocation provenance survives compact capture');
    assert.equal(accepted.invocation.ts, boundary === 'old-invocation' ? '2026-10-11T10:00:02.000Z' : '2026-10-11T10:00:04.750Z');
    assert.ok(node.events.some(event => event.type === 'handback_report' && event.text === 'Preserved report'));
    if (!delivered) assert.match(node.warnings.join('\n'), /report acceptance cannot settle the newer assignment/);
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
