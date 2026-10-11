import './helpers/provider-env.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readJsonlReverse } from '../lib/util.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-codex-'));
process.env.CODEX_HOME = tmp;
const { findCodexSessions, codexFileById, parseCodex, codexThreadName } = await import('../lib/codex.mjs');
beforeEach(() => {
  for (const name of fs.readdirSync(tmp)) {
    if (name === 'session_index.jsonl' || /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(name)) fs.rmSync(path.join(tmp, name));
  }
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('reverse transcript scan preserves long UTF-8 records and ignores an unfinished append', () => {
  const records = [{ cwd: '/worktree/հայերեն 🧭' }, { output: '🧭'.repeat(20_000) }, { type: 'done' }];
  const file = path.join(tmp, 'unicode.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\r\n') + '\n{"partial":');
  assert.deepEqual([...readJsonlReverse(file)], [...records].reverse());
  fs.writeFileSync(file, JSON.stringify(records[0]));
  assert.deepEqual([...readJsonlReverse(file)], [records[0]], 'last complete record needs no trailing newline');
});

function rollout(id, source, originator, records = []) {
  const dir = path.join(tmp, 'sessions', '2020', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2020-01-01-${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id, source, originator, cwd: '/project' } },
    ...records,
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('codex: active old desktop threads and moved worktrees remain discoverable; background agents stay excluded', () => {
  const file = rollout('desktop', 'vscode', 'Codex Desktop', [
    { type: 'turn_context', payload: { cwd: '/worktrees/task' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300_000) } },
  ]);
  rollout('work-desktop', 'vscode', 'codex_work_desktop');
  rollout('cli', 'cli', 'codex-tui');
  rollout('extension', 'vscode', 'vscode');
  rollout('exec', 'exec', 'codex_exec');
  rollout('subagent', { subagent: { other: 'guardian' } }, 'Codex Desktop');
  const find = opts => findCodexSessions({ target: '/project', targetIsRepo: true, ...opts }).map(s => s.id).sort();
  assert.deepEqual(find({ client: 'desktop' }), ['desktop', 'work-desktop']);
  assert.deepEqual(find({ client: 'cli' }), ['cli']);
  assert.deepEqual(find({}), ['cli', 'desktop', 'extension', 'work-desktop']);
  assert.deepEqual(find({ target: '/worktrees/task' }), ['desktop']);
  assert.equal(parseCodex(file).client, 'desktop');
  assert.equal(parseCodex(file).cwd, '/worktrees/task');
});

test('codex: explicit IDs find old sessions without substring collisions or a recency cutoff', () => {
  const file = rollout('old-id', 'vscode', 'Codex Desktop');
  fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(codexFileById('old-id'), file);
  assert.equal(codexFileById('id'), null);
  assert.equal(codexFileById(file), file);
  assert.equal(findCodexSessions({ any: true }).some(s => s.id === 'old-id'), false);
});

test('Codex CLI and Desktop discovery exposes latest valid indexed titles without changing source identity', () => {
  const desktop = rollout('named-desktop', 'vscode', 'Codex Desktop');
  rollout('named-cli', 'cli', 'codex-tui');
  rollout('unnamed-cli', 'cli', 'codex-tui');
  fs.writeFileSync(path.join(tmp, 'session_index.jsonl'), [
    { id: 'named-desktop', thread_name: 'Old title' },
    { id: 'named-cli', thread_name: 'CLI title' },
    { id: 'named-desktop', thread_name: 'Հոսք 🧭' },
    { id: 'named-desktop', thread_name: { invalid: true } },
    { id: 'named-desktop', thread_name: '   ' },
    null,
  ].map(record => JSON.stringify(record)).join('\n') + '\n{"unfinished":');
  const sessions = new Map(findCodexSessions({ any: true }).map(session => [session.id, session]));
  assert.equal(sessions.get('named-desktop').title, 'Հոսք 🧭');
  assert.equal(sessions.get('named-desktop').cwd, '/project');
  assert.equal(sessions.get('named-desktop').client, 'desktop');
  assert.equal(sessions.get('named-cli').title, 'CLI title');
  assert.equal(sessions.get('named-cli').client, 'cli');
  assert.equal(sessions.get('unnamed-cli').title, null);
  assert.equal(parseCodex(desktop).title, 'Հոսք 🧭');
});

const sqliteAvailable = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
test('Codex optional state metadata fills missing names read-only and supports older schemas', { skip: !sqliteAvailable }, () => {
  const file = rollout('database-name', 'vscode', 'Codex Desktop');
  rollout('database-title', 'vscode', 'Codex Desktop');
  rollout('index-name', 'cli', 'codex-tui');
  rollout('blank-name', 'cli', 'codex-tui');
  fs.writeFileSync(path.join(tmp, 'session_index.jsonl'), JSON.stringify({ id: 'index-name', thread_name: 'Indexed rename' }) + '\n');
  const database = path.join(tmp, 'state_5.sqlite');
  execFileSync('sqlite3', ['-init', os.devNull, database, `
    CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT);
    INSERT INTO threads VALUES ('database-name', 'Desktop rename', 'Generated title'),
      ('database-title', NULL, 'Stored title'), ('index-name', 'Older DB name', 'DB title'),
      ('blank-name', '  ', '  '), ('metadata-only', 'No transcript', 'No transcript');
  `]);
  const before = fs.readFileSync(database);
  const sessions = new Map(findCodexSessions({ any: true }).map(session => [session.id, session]));
  assert.equal(sessions.get('database-name').title, 'Desktop rename');
  assert.equal(sessions.get('database-title').title, 'Stored title');
  assert.equal(sessions.get('index-name').title, 'Indexed rename');
  assert.equal(sessions.get('blank-name').title, null);
  assert.equal(sessions.has('metadata-only'), false);
  assert.equal(parseCodex(file).title, 'Desktop rename');
  assert.deepEqual(fs.readFileSync(database), before, 'Title lookup must not modify the source database');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = path.join(tmp, 'no-executable');
    assert.equal(codexThreadName('database-name'), null);
    assert.equal(codexThreadName('index-name'), 'Indexed rename');
    assert.ok(findCodexSessions({ any: true }).some(session => session.id === 'database-name'));
  } finally { process.env.PATH = priorPath; }

  fs.rmSync(database);
  const oldDatabase = path.join(tmp, 'state_4.sqlite');
  execFileSync('sqlite3', ['-init', os.devNull, oldDatabase, `
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);
    INSERT INTO threads VALUES ('database-name', 'Legacy stored title');
  `]);
  assert.equal(codexThreadName('database-name'), 'Legacy stored title');
  fs.writeFileSync(database, 'corrupt optional metadata');
  assert.equal(codexThreadName('database-name'), null);
  assert.equal(codexThreadName('index-name'), 'Indexed rename');
  assert.ok(findCodexSessions({ any: true }).some(session => session.id === 'database-name'));
});

test('Codex WAL title lookup preserves the entire provider namespace and rejects a changing copy', { skip: !sqliteAvailable }, async () => {
  const source = fs.mkdtempSync(path.join(tmp, 'wal-source-'));
  const provider = fs.mkdtempSync(path.join(tmp, 'wal-provider-'));
  const original = path.join(source, 'state_5.sqlite');
  const ready = path.join(source, 'ready');
  const database = path.join(provider, 'state_5.sqlite');
  const index = path.join(provider, 'session_index.jsonl');
  const writer = spawn('sqlite3', ['-init', os.devNull, original], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => writer.on('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const poll = setInterval(() => { if (fs.existsSync(ready)) { clearInterval(poll); clearTimeout(timeout); resolve(); } }, 10);
      const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('WAL fixture writer did not become ready')); }, 3000);
      writer.on('error', reject);
      writer.stderr.on('data', chunk => reject(new Error(String(chunk))));
      writer.stdin.write(`PRAGMA journal_mode=WAL;
        CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT);
        INSERT INTO threads VALUES ('wal-name', 'WAL-only name', 'Generated title');
.output ${JSON.stringify(ready)}
SELECT 'fixture-ready';
.output stdout
`);
    });
    fs.copyFileSync(original, database);
    fs.copyFileSync(`${original}-wal`, `${database}-wal`);
    writer.stdin.end('.quit\n');
    await closed;
    fs.mkdirSync(path.join(provider, 'unrelated'));
    fs.writeFileSync(path.join(provider, 'unrelated', 'preserve.txt'), 'provider fixture');
    const capture = directory => Object.fromEntries(fs.readdirSync(directory, { recursive: true }).sort().map(name => {
      const file = path.join(directory, name);
      return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file)];
    }));
    const before = capture(provider);
    assert.equal(fs.existsSync(`${database}-shm`), false);
    const copyFile = fs.copyFileSync;
    let copies = 0;
    try {
      fs.copyFileSync = (...args) => { copies++; return copyFile(...args); };
      assert.equal(codexThreadName('wal-name', index), 'WAL-only name');
      assert.equal(codexThreadName('wal-name', index), 'WAL-only name');
      assert.equal(copies, 2, 'Stable metadata should copy DB and WAL once across repeated parses');
    } finally { fs.copyFileSync = copyFile; }
    assert.deepEqual(capture(provider), before, 'Lookup must not create SHM or change any provider file');
    fs.writeFileSync(index, JSON.stringify({ id: 'wal-name', thread_name: 'Newest indexed rename' }) + '\n');
    assert.equal(codexThreadName('wal-name', index), 'Newest indexed rename', 'Index changes override a cached DB title');
    fs.rmSync(index);
    const stamp = fs.statSync(database).mtimeMs;
    fs.utimesSync(database, new Date(stamp + 1000), new Date(stamp + 1000));
    try {
      fs.copyFileSync = (...args) => {
        const result = copyFile(...args);
        if (args[0] === database) fs.utimesSync(database, new Date(stamp + 2000), new Date(stamp + 2000));
        return result;
      };
      assert.equal(codexThreadName('wal-name', index), null, 'Reject metadata changed while copying instead of querying a torn snapshot');
    } finally { fs.copyFileSync = copyFile; }
    assert.equal(codexThreadName('wal-name', index), 'WAL-only name', 'A rejected copy must not poison the cache');
    assert.deepEqual(capture(provider), before);
  } finally {
    if (!writer.stdin.destroyed) writer.stdin.end('.quit\n');
    await closed;
  }
});
