import './helpers/provider-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { captureIdentity, withArtifactLock, listArtifacts, planCleanup, cleanArtifact } from '../lib/artifacts.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-artifacts-'));
  const root = path.join(temporary, 'hop');
  fs.mkdirSync(path.join(root, 'handoffs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'run'));
  const source = path.join(temporary, 'provider.jsonl');
  fs.writeFileSync(source, 'live provider evidence\n');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  function capture(id, { legacy = false, title = 'Shared task', sourceId = 'same-source', script = true, contents = 'handoff', bundle = true } = {}) {
    const stem = `2026-10-12-10-00-00-codex-to-claude-${id}`;
    const handoff = path.join(root, 'handoffs', `${stem}.md`), directory = path.join(root, 'handoffs', `${stem}.agents`);
    const scriptFile = path.join(root, 'run', `${stem}.sh`);
    fs.writeFileSync(handoff, contents);
    if (bundle) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'index.md'), 'index');
      fs.writeFileSync(path.join(directory, 'source.jsonl'), 'source snapshot');
      fs.writeFileSync(path.join(directory, 'source-context.json'), JSON.stringify({ title, cwd: '/repo', file: source, id: sourceId }));
      fs.writeFileSync(path.join(directory, 'agent-0001.jsonl'), 'agent snapshot');
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, source, agents: [{ files: { transcript: 'agent-0001.jsonl' } }] }));
    }
    if (script) fs.writeFileSync(scriptFile, '#!/bin/sh\n');
    const row = { ts: Date.now(), from: 'codex', fromId: sourceId, fromDesktopId: 'desktop-source', to: 'claude', cwd: '/repo', handoff,
      ...(bundle ? { agentIndex: path.join(directory, 'index.md') } : {}),
      ...(!legacy ? { captureId: id, title, ...(script ? { script: scriptFile } : {}) } : {}) };
    fs.appendFileSync(path.join(root, 'links.jsonl'), JSON.stringify(row) + '\n');
    return { id: legacy ? stem : id, stem, handoff, bundle: directory, script: scriptFile, row };
  }
  return { root, temporary, source, capture };
}
function assertBlocked(fn) { assert.throws(fn, error => error.code === 'CLEANUP_BLOCKED'); }
function originalCapture(root, { fromId = 'legacy-source', cwd = '/legacy-repo', content = 'legacy handoff', ts = Date.now() } = {}) {
  const stem = '2026-10-12-10-00-00-codex-to-claude', handoff = path.join(root, 'handoffs', `${stem}.md`);
  fs.writeFileSync(handoff, content);
  // Original upstream rows had no capture ID, title, bundle, or script.
  const row = { ts, from: 'codex', fromId, to: 'claude', cwd, handoff };
  fs.appendFileSync(path.join(root, 'links.jsonl'), JSON.stringify(row) + '\n');
  return { id: stem, stem, handoff, row };
}

test('capture identities preserve timestamp/direction naming and distinguish repeated source/title captures', t => {
  const { root } = fixture(t), now = new Date('2026-10-12T10:00:00.000Z');
  const options = { root, now, session: { id: '../../provider', title: 'Fix / Login — été 💥' }, from: 'codex', to: 'claude' };
  const one = captureIdentity(options), two = captureIdentity(options);
  assert.notEqual(one.id, two.id);
  assert.match(one.stem, /^2026-10-12-10-00-00-codex-to-claude-[a-f0-9]{8}$/);
  assert.equal(one.title, 'Fix / Login — été 💥');
  assert.equal(path.dirname(one.handoff), path.join(root, 'handoffs'));
  assert.equal(one.bundle, one.handoff.slice(0, -3) + '.agents');
  assert.equal(one.script, path.join(root, 'run', `${one.stem}.sh`));
  assert.equal(captureIdentity({ ...options, title: '登录修复' }).title, '登录修复');
  assert.equal(captureIdentity({ ...options, title: 'a'.repeat(300) }).stem.length, one.stem.length);
});

test('inventory identifies repeated titles/source IDs and restores legacy title from managed metadata only', t => {
  const { root, capture, source } = fixture(t);
  const one = capture('11111111'), two = capture('22222222'), old = capture('33333333', { legacy: true });
  fs.unlinkSync(source); // title lookup must not depend on a live provider log
  const records = listArtifacts({ root });
  assert.deepEqual(records.map(item => item.id), [one.id, two.id, old.stem]);
  assert.ok(records.every(item => item.title === 'Shared task' && item.cwd === '/repo' && item.fromId === 'same-source'));
  assert.equal(records[2].script, null);
  assert.equal(records[2].safe, true);
  assert.throws(() => planCleanup('same-source', { root }), error => error.code === 'CAPTURE_NOT_FOUND');
  assert.throws(() => planCleanup('2026-10-12', { root }), error => error.code === 'CAPTURE_NOT_FOUND');
  assert.throws(() => planCleanup('111', { root }), error => error.code === 'CAPTURE_NOT_FOUND');
  assert.equal(planCleanup(one.id, { root }).artifact.id, one.id);
});

test('listing and preview do not create roots or locks', t => {
  const { temporary, root, capture } = fixture(t);
  const absent = path.join(temporary, 'absent');
  assert.deepEqual(listArtifacts({ root: absent }), []);
  assert.equal(fs.existsSync(absent), false);
  capture('11111111');
  const before = fs.readdirSync(root).sort();
  listArtifacts({ root }); planCleanup('11111111', { root });
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('cleanup removes only the selected registered handoff, flat bundle, and matching script', t => {
  const { root, capture, source } = fixture(t);
  const selected = capture('11111111'), retained = capture('22222222');
  const oldScript = path.join(root, 'run', 'launch-123.sh');
  fs.writeFileSync(oldScript, 'unregistered legacy script');
  const staging = path.join(root, 'handoffs', '.capture-active');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'source.jsonl'), selected.stem);
  const originalLog = fs.readFileSync(path.join(root, 'links.jsonl'), 'utf8');
  const plan = planCleanup(selected.id, { root });
  assert.equal(plan.canClean, true);
  assert.ok(plan.files.some(file => file.path === selected.script));
  assert.equal(plan.totalBytes, plan.files.reduce((sum, file) => sum + file.bytes, 0));
  const result = cleanArtifact(selected.id, { root });
  assert.equal(result.removed, true);
  for (const file of [selected.handoff, selected.bundle, selected.script]) assert.equal(fs.existsSync(file), false);
  for (const file of [retained.handoff, retained.bundle, retained.script, oldScript, source, staging]) assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(path.join(root, 'links.jsonl'), 'utf8'), originalLog);
  assert.equal(listArtifacts({ root }).find(item => item.id === selected.id).status, 'removed');
  assert.deepEqual(cleanArtifact(selected.id, { root }).deletedPaths, [], 'removed capture can be safely retried');
});

test('legacy cleanup preserves even a matching launch script unless it was explicitly registered', t => {
  const { root, capture } = fixture(t), old = capture('aaaaaaaa', { legacy: true });
  assert.equal(planCleanup(old.stem, { root }).files.some(file => file.path === old.script), false);
  cleanArtifact(old.stem, { root });
  assert.equal(fs.existsSync(old.script), true);
});

test('original no-suffix captures coexist with modern captures and preserve unassociated launch scripts', t => {
  const { root, capture, source } = fixture(t), old = originalCapture(root), modern = capture('11111111');
  const unassociated = path.join(root, 'run', 'launch-2026-10-12-10-00-00.sh');
  fs.writeFileSync(unassociated, 'legacy launch');
  // A modern filename shares the legacy prefix, but is a different artifact.
  fs.writeFileSync(path.join(modern.bundle, 'index.md'), `Read ${modern.handoff}\nRead ${modern.bundle}/source.jsonl`);
  const inventory = listArtifacts({ root });
  assert.deepEqual(inventory.map(item => item.id), [old.stem, modern.id]);
  assert.equal(inventory[0].bundle, null);
  assert.equal(inventory[0].safe, true);
  assert.equal(planCleanup(old.stem, { root }).canClean, true);
  assert.equal(planCleanup(modern.id, { root }).canClean, true);
  cleanArtifact(old.stem, { root });
  for (const file of [modern.handoff, modern.bundle, unassociated, source]) assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(old.handoff), false);
});

test('legitimate original same-second overwrite rows retain latest metadata and one deletion identity', t => {
  const { root } = fixture(t);
  originalCapture(root, { fromId: 'old-source', cwd: '/old-repo', content: 'old content', ts: 100 });
  const latest = originalCapture(root, { fromId: 'new-source', cwd: '/new-repo', content: 'latest content', ts: 101 });
  const records = listArtifacts({ root });
  assert.equal(records.length, 1);
  assert.equal(records[0].id, latest.stem);
  assert.equal(records[0].fromId, 'new-source');
  assert.equal(records[0].cwd, '/new-repo');
  assert.equal(records[0].line, 2);
  assert.ok(records[0].warnings.some(message => /overwritten|覆盖/.test(message)));
  assert.equal(planCleanup(latest.stem, { root }).canClean, true);
  cleanArtifact(latest.stem, { root });
  assert.equal(listArtifacts({ root })[0].status, 'removed');
  assert.equal(fs.readFileSync(path.join(root, 'links.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('legacy overwrite grouping does not hide forged paths or conflicting registered ownership', t => {
  const { root, temporary } = fixture(t), old = originalCapture(root);
  const log = path.join(root, 'links.jsonl'), original = fs.readFileSync(log);
  const outside = path.join(temporary, `${old.stem}.md`);
  fs.writeFileSync(outside, 'unrelated outside file');
  fs.appendFileSync(log, JSON.stringify({ ...old.row, handoff: outside }) + '\n');
  assert.ok(listArtifacts({ root }).some(item => !item.safe));
  assertBlocked(() => cleanArtifact(old.stem, { root }));
  fs.writeFileSync(log, original);
  const script = path.join(root, 'run', `${old.stem}.sh`);
  fs.writeFileSync(script, 'registered on conflicting row');
  fs.appendFileSync(log, JSON.stringify({ ...old.row, script }) + '\n');
  assert.ok(listArtifacts({ root }).every(item => !item.safe));
  assert.throws(() => planCleanup(old.stem, { root }), error => error.code === 'AMBIGUOUS_CAPTURE');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated outside file');
});

test('a retained exact legacy filename reference still blocks cleanup across chunk boundaries', t => {
  const { root, capture } = fixture(t), old = originalCapture(root), modern = capture('11111111');
  const raw = path.join(modern.bundle, 'source.jsonl');
  fs.writeFileSync(raw, 'x'.repeat(64 * 1024 - old.stem.length) + old.stem + '.md');
  assert.equal(planCleanup(old.stem, { root }).dependents[0].id, modern.id);
  assertBlocked(() => cleanArtifact(old.stem, { root }));
});

test('full raw-only references block cleanup, including references split across scan chunks', t => {
  const { root, capture } = fixture(t);
  const selected = capture('11111111'), retained = capture('22222222');
  const raw = path.join(retained.bundle, 'agent-0001.jsonl');
  fs.writeFileSync(raw, 'x'.repeat(64 * 1024 - 8) + selected.stem + '\n{"unfinished":');
  const plan = planCleanup(selected.id, { root });
  assert.equal(plan.canClean, false);
  assert.deepEqual(plan.dependents, [{ id: retained.id, stem: retained.stem, files: [raw] }]);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.existsSync(selected.handoff), true);
  assert.equal(planCleanup(retained.id, { root }).canClean, true, 'references in selected raw evidence are excluded from its own plan');
});

test('unindexed managed handoffs are retained and scanned for references', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const stem = '2026-10-12-10-00-01-claude-to-codex-cccccccc', file = path.join(root, 'handoffs', `${stem}.md`);
  fs.writeFileSync(file, `Read ${selected.handoff}`);
  const plan = planCleanup(selected.id, { root });
  assert.equal(plan.dependents[0].id, stem);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.existsSync(file), true);
});

test('malformed registry, corrupt metadata, and missing retained evidence fail closed', t => {
  const { root, capture } = fixture(t);
  const selected = capture('11111111'), retained = capture('22222222');
  const log = path.join(root, 'links.jsonl'), original = fs.readFileSync(log);
  fs.appendFileSync(log, '{broken\n');
  assert.equal(listArtifacts({ root }).at(-1).safe, false);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  fs.writeFileSync(log, original);
  fs.writeFileSync(path.join(retained.bundle, 'source-context.json'), '{broken');
  assert.equal(listArtifacts({ root })[1].safe, false);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  fs.writeFileSync(path.join(retained.bundle, 'source-context.json'), '{}');
  fs.unlinkSync(path.join(retained.bundle, 'agent-0001.jsonl'));
  assert.ok(planCleanup(selected.id, { root }).blockers.some(message => message.includes('agent-0001.jsonl')));
  assertBlocked(() => cleanArtifact(selected.id, { root }));
});

test('unreadable retained raw files block cleanup rather than inferring no references', t => {
  const { root, capture } = fixture(t);
  const selected = capture('11111111'), retained = capture('22222222');
  const unreadable = path.join(retained.bundle, 'source.jsonl'), original = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === unreadable) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original(file, ...args);
  };
  try {
    const plan = planCleanup(selected.id, { root });
    assert.ok(plan.blockers.some(message => message.includes(unreadable)));
    assertBlocked(() => cleanArtifact(selected.id, { root }));
  } finally { fs.openSync = original; }
  assert.equal(fs.existsSync(selected.handoff), true);
});

test('truncated or same-size edited retained snapshots cannot hide a reference from recorded integrity checks', t => {
  const { root, capture } = fixture(t), selected = capture('11111111'), retained = capture('22222222');
  const raw = path.join(retained.bundle, 'source.jsonl'), manifestFile = path.join(retained.bundle, 'manifest.json');
  const content = `Read ${selected.handoff}\n`, byteLength = Buffer.byteLength(content), sha256 = createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(raw, content);
  fs.writeFileSync(path.join(retained.bundle, 'recovery.md'), 'recovery');
  const manifest = { ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), version: 2,
    evidenceSources: [{ file: 'source.jsonl', byteLength, sha256 }] };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.equal(planCleanup(selected.id, { root }).dependents[0].id, retained.id);
  fs.writeFileSync(raw, 'shortened evidence without the reference');
  let plan = planCleanup(selected.id, { root });
  assert.equal(plan.canClean, false);
  assert.ok(plan.blockers.some(message => message.includes('byteLength') && message.includes(raw)));
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  fs.writeFileSync(raw, 'x'.repeat(byteLength));
  plan = planCleanup(selected.id, { root });
  assert.equal(plan.canClean, false);
  assert.ok(plan.blockers.some(message => message.includes('sha256') && message.includes(raw)));
  assert.equal(planCleanup(retained.id, { root }).canClean, true, 'selected evidence may be partial and is excluded from retained integrity checks');
  delete manifest.evidenceSources;
  manifest.sourceByteLength = byteLength; manifest.sourceSha256 = sha256;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.ok(planCleanup(selected.id, { root }).blockers.some(message => message.includes('sha256') && message.includes(raw)), 'root snapshot integrity fields supply a legacy manifest fallback');
});

test('paths outside the managed root and mismatched agent/script paths are never cleanup candidates', t => {
  const { root, temporary, capture } = fixture(t), selected = capture('11111111');
  const log = path.join(root, 'links.jsonl'), original = fs.readFileSync(log);
  const outside = path.join(temporary, `${selected.stem}.md`);
  fs.writeFileSync(outside, 'outside evidence');
  for (const patch of [{ handoff: outside }, { handoff: `${root}/handoffs/nested/../${selected.stem}.md` },
    { agentIndex: outside }, { script: path.join(root, 'run', 'launch-123.sh') }, { captureId: '22222222' }]) {
    fs.writeFileSync(log, JSON.stringify({ ...selected.row, ...patch }) + '\n');
    assert.equal(listArtifacts({ root })[0].safe, false);
  }
  fs.writeFileSync(log, original);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside evidence');
});

test('symlinked files, bundles, managed parents, and nested bundle content are rejected', t => {
  const { root, temporary, source, capture } = fixture(t), selected = capture('11111111');
  const target = path.join(selected.bundle, 'agent-0001.jsonl');
  fs.unlinkSync(target); fs.symlinkSync(source, target);
  assert.equal(listArtifacts({ root })[0].safe, false);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  fs.unlinkSync(target); fs.mkdirSync(target);
  assert.equal(listArtifacts({ root })[0].safe, false);
  fs.rmdirSync(target); fs.writeFileSync(target, 'snapshot');
  const originalBundle = `${selected.bundle}-saved`;
  fs.renameSync(selected.bundle, originalBundle); fs.symlinkSync(originalBundle, selected.bundle);
  assert.equal(listArtifacts({ root })[0].safe, false);
  fs.unlinkSync(selected.bundle); fs.renameSync(originalBundle, selected.bundle);
  const outside = path.join(temporary, 'handoffs');
  fs.renameSync(path.join(root, 'handoffs'), outside); fs.symlinkSync(outside, path.join(root, 'handoffs'));
  assert.equal(listArtifacts({ root })[0].safe, false);
  assert.throws(() => cleanArtifact(selected.id, { root }), error => error.code === 'UNSAFE_ARTIFACT');
  assert.equal(fs.readFileSync(source, 'utf8'), 'live provider evidence\n');
});

test('unexpected retained content and incomplete unindexed bundles block deletion', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const unexpected = path.join(root, 'handoffs', 'user-notes.md');
  fs.writeFileSync(unexpected, 'uncertain ownership');
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  fs.unlinkSync(unexpected);
  const orphan = path.join(root, 'handoffs', '2026-10-12-10-00-01-claude-to-codex-cccccccc.agents');
  fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'source.jsonl'), 'partial publish');
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.existsSync(orphan), true);
});

test('duplicate registry records cannot authorize deletion or ambiguous selection', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  fs.appendFileSync(path.join(root, 'links.jsonl'), JSON.stringify(selected.row) + '\n');
  assert.ok(listArtifacts({ root }).every(item => !item.safe));
  assert.throws(() => planCleanup(selected.id, { root }), error => error.code === 'AMBIGUOUS_CAPTURE');
});

test('the same modern capture ID registered for two distinct stems is unsafe', t => {
  const { root, capture } = fixture(t), one = capture('11111111', { bundle: false, script: false });
  const handoff = one.handoff.replace('-10-00-00-', '-10-00-01-');
  fs.writeFileSync(handoff, 'other same-ID capture');
  fs.appendFileSync(path.join(root, 'links.jsonl'), JSON.stringify({ ...one.row, handoff }) + '\n');
  assert.ok(listArtifacts({ root }).every(item => !item.safe));
  assert.throws(() => planCleanup(one.id, { root }), error => error.code === 'AMBIGUOUS_CAPTURE');
});

test('unmanifested user files in a registered bundle block deletion and remain untouched', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const notes = path.join(selected.bundle, 'user-notes.md');
  fs.writeFileSync(notes, 'user-owned notes');
  const plan = planCleanup(selected.id, { root });
  assert.equal(plan.canClean, false);
  assert.ok(plan.blockers.some(message => message.includes(notes)));
  assert.equal(plan.files.some(file => file.path === notes), false);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.readFileSync(notes, 'utf8'), 'user-owned notes');
  assert.equal(fs.existsSync(selected.handoff), true);
});

test('a handoff-only row cannot claim an unrelated same-stem bundle', t => {
  const { root, capture } = fixture(t), selected = capture('11111111', { bundle: false, script: false });
  fs.mkdirSync(selected.bundle);
  const notes = path.join(selected.bundle, 'user-notes.md');
  fs.writeFileSync(notes, 'unrelated notes');
  const inventory = listArtifacts({ root });
  assert.equal(inventory[0].bundle, null);
  assert.equal(inventory[0].files.some(file => file.path === selected.bundle || file.path === notes), false);
  assert.equal(planCleanup(selected.id, { root }).canClean, false, 'uncertain retained evidence fails closed');
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.readFileSync(notes, 'utf8'), 'unrelated notes');
});

test('nonempty registered bundles without manifests fail closed even for the selected capture', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  fs.unlinkSync(path.join(selected.bundle, 'manifest.json'));
  assert.equal(planCleanup(selected.id, { root }).canClean, false);
  assertBlocked(() => cleanArtifact(selected.id, { root }));
  assert.equal(fs.existsSync(path.join(selected.bundle, 'source.jsonl')), true);
});

test('artifact lock prevents overlapping capture/cleanup and releases on failure', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const moduleFile = fileURLToPath(new URL('../lib/artifacts.mjs', import.meta.url));
  withArtifactLock(() => {
    assert.throws(() => cleanArtifact(selected.id, { root }), error => error.code === 'ARTIFACT_LOCKED');
    const program = `import { withArtifactLock } from ${JSON.stringify(moduleFile)}; try { withArtifactLock(() => {}, {root: ${JSON.stringify(root)}}); process.exit(3); } catch (e) { if(e.code !== 'ARTIFACT_LOCKED') throw e; }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }, { root });
  assert.equal(fs.existsSync(path.join(root, '.artifacts.lock')), false);
  assert.throws(() => withArtifactLock(() => { throw new Error('capture failed'); }, { root }), /capture failed/);
  assert.equal(fs.existsSync(path.join(root, '.artifacts.lock')), false);
});

test('stale, foreign-host, and symlink locks are never automatically stolen', t => {
  const { root, source } = fixture(t), lock = path.join(root, '.artifacts.lock');
  for (const owner of [{ host: os.hostname(), pid: 2147483647 }, { host: 'another-host', pid: process.pid }]) {
    const contents = JSON.stringify(owner);
    fs.writeFileSync(lock, contents);
    assert.throws(() => withArtifactLock(() => {}, { root }), error => error.code === 'ARTIFACT_LOCKED' && error.message.includes('PID') && /manually|手动/.test(error.message));
    assert.equal(fs.readFileSync(lock, 'utf8'), contents);
    fs.unlinkSync(lock);
  }
  fs.symlinkSync(source, lock);
  assert.throws(() => withArtifactLock(() => {}, { root }), error => error.code === 'ARTIFACT_LOCKED');
  assert.equal(fs.readFileSync(source, 'utf8'), 'live provider evidence\n');
});

test('capture preflight rejects symlinked managed directories and publication log before callback writes', t => {
  const { root, temporary, source } = fixture(t);
  for (const name of ['handoffs', 'run', 'links.jsonl']) {
    const managed = path.join(root, name), saved = path.join(temporary, `${name}-saved`);
    const existed = fs.existsSync(managed);
    if (existed) fs.renameSync(managed, saved);
    fs.symlinkSync(name === 'links.jsonl' ? source : saved, managed);
    let called = false;
    assert.throws(() => withArtifactLock(() => { called = true; }, { root }), error => error.code === 'UNSAFE_ARTIFACT');
    assert.throws(() => captureIdentity({ root, from: 'codex', to: 'claude' }), error => error.code === 'UNSAFE_ARTIFACT');
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(root, '.artifacts.lock')), false);
    fs.unlinkSync(managed);
    if (existed) fs.renameSync(saved, managed);
  }
  assert.equal(fs.readFileSync(source, 'utf8'), 'live provider evidence\n');
});

test('partial deletion reports deleted/remaining files and a later retry completes safely', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const refused = path.join(selected.bundle, 'source.jsonl'), unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (file === refused) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return unlink(file);
  };
  try {
    assert.throws(() => cleanArtifact(selected.id, { root }), error => {
      assert.equal(error.code, 'PARTIAL_CLEANUP');
      assert.ok(error.deletedPaths.length > 0);
      assert.ok(error.remainingPaths.includes(refused));
      assert.equal(fs.existsSync(selected.handoff), true);
      return true;
    });
  } finally { fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(path.join(root, '.artifacts.lock')), false);
  assert.equal(listArtifacts({ root })[0].safe, true);
  assert.equal(planCleanup(selected.id, { root }).canClean, true);
  cleanArtifact(selected.id, { root });
  assert.equal(listArtifacts({ root })[0].status, 'removed');
});

test('interruption after the final manifest unlink leaves an empty registered bundle that can be retried', t => {
  const { root, capture } = fixture(t), selected = capture('11111111');
  const rmdir = fs.rmdirSync;
  fs.rmdirSync = file => {
    if (file === selected.bundle) throw Object.assign(new Error('directory removal denied'), { code: 'EACCES' });
    return rmdir(file);
  };
  try { assert.throws(() => cleanArtifact(selected.id, { root }), error => error.code === 'PARTIAL_CLEANUP'); }
  finally { fs.rmdirSync = rmdir; }
  assert.deepEqual(fs.readdirSync(selected.bundle), []);
  assert.equal(listArtifacts({ root })[0].safe, true);
  assert.equal(planCleanup(selected.id, { root }).canClean, true);
  cleanArtifact(selected.id, { root });
  assert.equal(listArtifacts({ root })[0].status, 'removed');
});

test('a file replaced during deletion is not unlinked through a symlink', t => {
  const { root, capture, source } = fixture(t), selected = capture('11111111');
  const next = path.join(selected.bundle, 'source.jsonl'), unlink = fs.unlinkSync;
  let changed = false;
  fs.unlinkSync = file => {
    const result = unlink(file);
    if (!changed && path.dirname(file) === selected.bundle) {
      changed = true;
      unlink(next); fs.symlinkSync(source, next);
    }
    return result;
  };
  try { assert.throws(() => cleanArtifact(selected.id, { root }), error => error.code === 'PARTIAL_CLEANUP'); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(fs.readFileSync(source, 'utf8'), 'live provider evidence\n');
  assert.equal(fs.lstatSync(next).isSymbolicLink(), true);
});
