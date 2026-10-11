import './helpers/provider-env.mjs';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-claude-desktop-'));
const config = path.join(tmp, 'config');
const desktop = path.join(tmp, 'Claude');
const priorConfig = process.env.CLAUDE_CONFIG_DIR;
const priorDesktop = process.env.HOP_CLAUDE_DESKTOP_DIR;
process.env.CLAUDE_CONFIG_DIR = config;
process.env.HOP_CLAUDE_DESKTOP_DIR = desktop;
const { findClaudeSessions, claudeFileById, parseClaude } = await import('../lib/claude.mjs');
if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = priorConfig;
if (priorDesktop === undefined) delete process.env.HOP_CLAUDE_DESKTOP_DIR;
else process.env.HOP_CLAUDE_DESKTOP_DIR = priorDesktop;

beforeEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(desktop, { recursive: true, force: true });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function transcript(id, records, project = 'project') {
  const file = path.join(config, 'projects', project, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function metadata(id, values = {}, account = 'account') {
  const file = path.join(desktop, 'claude-code-sessions', account, 'org', `local_${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, ...values }));
  return file;
}

const user = (entrypoint, extra = {}) => ({
  type: 'user', uuid: 'u1', parentUuid: null, cwd: '/repo',
  ...(entrypoint ? { entrypoint } : {}),
  message: { role: 'user', content: 'Fixture request' }, ...extra,
});
const discover = (options = {}) => findClaudeSessions({ target: '/repo', targetIsRepo: true, ...options });

test('Claude discovery separates desktop, CLI, and legacy sessions while excluding noninteractive and sidechain logs', () => {
  transcript('desktop', [user('claude-desktop')]);
  transcript('cli', [
    { type: 'ai-title', aiTitle: 'Generated CLI title' },
    { type: 'custom-title', customTitle: 'CLI rename' },
    user('cli'),
  ]);
  transcript('legacy', [user(null)]);
  transcript('sdk', [user('sdk-cli')]);
  transcript('unknown', [user('future-client')]);
  transcript('sidechain', [user('claude-desktop', { isSidechain: true })]);
  transcript('invalid-cwd', [user('cli', { cwd: { invalid: true } })]);
  metadata('cli', { title: 'Unrelated stale app metadata' });
  const ids = options => discover(options).map(session => session.id).sort();
  assert.deepEqual(ids(), ['cli', 'desktop', 'legacy']);
  assert.deepEqual(ids({ client: 'desktop' }), ['desktop']);
  assert.deepEqual(ids({ client: 'cli' }), ['cli', 'legacy']);
  assert.equal(parseClaude(claudeFileById('desktop')).client, 'desktop');
  assert.equal(parseClaude(claudeFileById('legacy')).client, 'cli');
  const cli = discover({ client: 'cli' }).find(session => session.id === 'cli');
  assert.equal(cli.desktopId, undefined);
  assert.equal(cli.title, 'CLI rename');
  assert.equal(cli.cwd, '/repo');
  assert.equal(discover({ client: 'cli' }).find(session => session.id === 'legacy').title, null);
});

test('Desktop IDs resolve local transcripts and metadata enriches titles and original repository matching without replacing transcript state', () => {
  const file = transcript('desktop', [
    { type: 'ai-title', aiTitle: 'Generated title' },
    { type: 'custom-title', customTitle: 'User chosen title' },
    { type: 'permission-mode', permissionMode: 'plan' },
    user('claude-desktop', { cwd: '/worktrees/current' }),
    { type: 'relocated', relocatedCwd: '/worktrees/latest' },
    user('sdk-cli', { uuid: 'side', isSidechain: true, cwd: '/unrelated' }),
  ]);
  metadata('desktop', { cwd: '/stale', originCwd: '/repo', title: 'Stale metadata title', permissionMode: 'default' });
  metadata('missing', { cwd: '/repo', title: 'Transcript unavailable' });
  assert.equal(claudeFileById('local_desktop'), file);
  assert.equal(claudeFileById('desktop'), file);
  assert.equal(claudeFileById(file), file);
  assert.equal(claudeFileById('local_missing'), null);
  const [candidate] = discover({ client: 'desktop' });
  assert.equal(candidate.id, 'desktop');
  assert.equal(candidate.desktopId, 'local_desktop');
  assert.equal(candidate.cwd, '/worktrees/latest');
  assert.equal(candidate.title, 'User chosen title');
  const session = parseClaude(file);
  assert.equal(session.title, 'User chosen title');
  assert.equal(session.cwd, '/worktrees/latest');
  assert.equal(session.permission, 'plan');
  assert.equal(session.desktopId, 'local_desktop');
  assert.deepEqual(session.turns.map(turn => turn.user), ['Fixture request']);
  assert.deepEqual(discover({ target: '/stale', client: 'desktop' }), []);

  const unnamed = transcript('unnamed', [user('claude-desktop', { cwd: null })]);
  metadata('unnamed', { cwd: '/repo', title: 'App title', permissionMode: 'default' });
  const enriched = parseClaude(unnamed);
  assert.equal(enriched.title, 'App title');
  assert.equal(enriched.cwd, '/repo');
  assert.equal(enriched.permission, 'default');
  assert.equal(discover({ client: 'desktop' }).find(item => item.id === 'unnamed').title, 'App title');
  metadata('desktop', { cwd: '/stale', originCwd: '/repo', isArchived: true });
  assert.equal(claudeFileById('local_desktop'), file, 'Archived local transcripts remain readable by explicit ID');
  assert.equal(parseClaude(file).desktopId, undefined, 'Archived sessions cannot use the native return route');
  assert.equal(discover({ client: 'desktop' }).find(item => item.id === 'desktop').desktopId, undefined);
});

test('Missing and malformed desktop metadata remains optional and cannot fabricate sessions or corrupt existing titles', () => {
  const file = transcript('desktop', [
    { type: 'ai-title', aiTitle: 'Transcript title' },
    { type: 'custom-title', customTitle: '   ' },
    user('claude-desktop'),
  ]);
  assert.equal(parseClaude(file).title, 'Transcript title');
  assert.equal(discover()[0].client, 'desktop');
  metadata('desktop', { title: 'Older app title' });
  assert.equal(parseClaude(file).title, 'Transcript title');
  const broken = metadata('broken');
  fs.writeFileSync(broken, '{partial');
  metadata('missing-id', { cliSessionId: undefined });
  metadata('invalid', { cliSessionId: '../desktop', cwd: '/repo' });
  metadata('unsafe', { sessionId: 'local_bad_id', cliSessionId: 'desktop' });
  metadata('oversize', { sessionId: `local_${'x'.repeat(65)}`, cliSessionId: 'desktop' });
  metadata('absent', { cwd: '/repo' });
  assert.deepEqual(discover().map(item => item.id), ['desktop']);
  assert.equal(claudeFileById('local_missing-id'), null);
  assert.equal(claudeFileById('local_invalid'), null);
  assert.equal(claudeFileById('local_broken'), null);
  assert.equal(claudeFileById('local_bad_id'), null);
});

test('Head classification survives long metadata tails, duplicate relocated transcripts are deduplicated, and invalid files are skipped', () => {
  const older = transcript('desktop', [user('claude-desktop', { cwd: '/old' })], 'old-project');
  const current = transcript('desktop', [
    { type: 'custom-title', customTitle: 'Old title' },
    user('claude-desktop'),
    { type: 'progress', data: 'x'.repeat(300_000) },
    { type: 'custom-title', customTitle: 'Current title' },
    user('claude-desktop', { uuid: 'renamed-user', parentUuid: 'u1' }),
  ], 'current-project');
  fs.utimesSync(older, new Date(0), new Date(Date.now() - 1000));
  transcript('sdk', [user('sdk-cli'), { type: 'progress', data: 'x'.repeat(300_000) }]);
  const fake = path.join(config, 'projects', 'current-project', 'directory.jsonl');
  fs.mkdirSync(fake);
  fs.symlinkSync(path.join(tmp, 'missing.jsonl'), path.join(path.dirname(fake), 'broken.jsonl'));
  const [candidate] = discover({ any: true });
  assert.equal(candidate.id, 'desktop');
  assert.equal(candidate.file, current);
  assert.equal(candidate.title, 'Current title');
  assert.equal(claudeFileById('desktop'), current);
  assert.equal(claudeFileById(fake), null);
});

test('Discovery recovers the latest source and moved cwd buried before large output, and still matches a buried original cwd', () => {
  const file = transcript('moved', [
    user('cli', { message: { role: 'user', content: 'x'.repeat(160_000) } }),
    user('claude-desktop', { uuid: 'u2', parentUuid: 'u1', cwd: '/worktrees/current' }),
    { type: 'progress', data: 'Large UTF-8 output Armenian հայերեն '.repeat(12_000) },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u2', message: { content: [{ type: 'text', text: 'Fixture answer' }] } },
  ]);
  fs.appendFileSync(file, '{"type":"unfinished');
  const [global] = discover({ any: true, client: 'desktop' });
  assert.equal(global.cwd, '/worktrees/current');
  assert.equal(global.client, 'desktop');
  assert.equal(global.cwd, parseClaude(file).cwd);
  assert.deepEqual(discover({ client: 'cli' }), []);
  assert.equal(discover({ client: 'desktop' })[0].file, file, 'The original cwd remains discoverable beyond the head sample');
  assert.equal(discover({ client: 'desktop', target: '/worktrees/current' })[0].file, file);
  assert.deepEqual(discover({ target: '/unrelated' }), []);
});

test('Existing paths with trailing spaces remain exact for transcript relocation and desktop cwd and origin metadata', () => {
  const actualTmp = fs.realpathSync(tmp);
  const origin = path.join(actualTmp, 'repo ');
  const moved = path.join(actualTmp, 'worktree ');
  const sibling = path.join(actualTmp, 'repo');
  for (const dir of [origin, moved, sibling]) fs.mkdirSync(dir, { recursive: true });
  const cli = transcript('spaced-cli', [user('cli', { cwd: origin }), { type: 'relocated', relocatedCwd: moved }]);
  const app = transcript('spaced-desktop', [user('claude-desktop', { cwd: null })]);
  metadata('spaced-desktop', { cwd: moved, originCwd: origin });
  const options = { target: origin, targetIsRepo: false };
  const candidates = discover(options);
  assert.deepEqual(candidates.map(item => item.id).sort(), ['spaced-cli', 'spaced-desktop']);
  assert.ok(candidates.every(item => item.cwd === moved));
  assert.equal(parseClaude(cli).cwd, moved);
  assert.equal(parseClaude(app).cwd, moved);
  assert.deepEqual(discover({ target: sibling, targetIsRepo: false }), [], 'Trimming must not match the sibling repository');
});
