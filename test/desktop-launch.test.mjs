import './helpers/provider-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { desktopUrl } from '../lib/launch.mjs';
import { resumeCmd, cliResumeCmd } from '../lib/render.mjs';
import { M } from '../lib/i18n.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-desktop-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const bin = path.resolve('bin/hop.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], {
  env: { ...process.env, HOP_DIR: path.join(tmp, 'hop'), HOP_LANG: 'en', CODEX_HOME: tmp, CLAUDE_CONFIG_DIR: tmp, HOP_CLAUDE_DESKTOP_DIR: tmp, ...env },
  encoding: 'utf8',
});

test('desktop launch: URLs preserve prompt and exact worktree paths with spaces, Unicode, and shell characters', () => {
  const cwd = path.join(tmp, "work tree & ' $() # հայերեն");
  const handoff = path.join(tmp, "handoff ' &.md");
  const task = 'Continue "login" & settings';
  for (const to of ['codex', 'claude']) {
    const url = new URL(desktopUrl({ to, cwd, handoff, task }));
    assert.equal(url.protocol, to === 'codex' ? 'codex:' : 'claude:');
    assert.equal(url.host, to === 'codex' ? 'threads' : 'code');
    assert.equal(url.pathname, '/new');
    assert.equal(url.searchParams.get(to === 'codex' ? 'path' : 'folder'), cwd);
    assert.equal(url.searchParams.get(to === 'codex' ? 'prompt' : 'q'), `${M.prompt(handoff, task)}\n\n${M.desktopPrompt(cwd)}`);
    assert.equal([...url.searchParams].length, 2);
  }
});

test('desktop return: native source links retain a separate CLI fallback', () => {
  const codex = { tool: 'codex', client: 'desktop', id: 'cx-id' };
  const claude = { tool: 'claude', client: 'desktop', id: 'cc-id', desktopId: 'local-desktop-id' };
  assert.equal(resumeCmd(codex), "open 'codex://threads/cx-id'");
  assert.equal(resumeCmd(claude), "open 'claude://code/continue?session=local-desktop-id'");
  assert.equal(cliResumeCmd(claude), 'claude --resume cc-id');
  assert.equal(resumeCmd({ ...claude, desktopId: undefined }), 'claude --resume cc-id');
  assert.equal(resumeCmd({ ...codex, client: 'cli' }), 'codex resume cx-id');
});

test('CLI: invalid desktop combinations and missing option values fail before writing a handoff', () => {
  for (const args of [
    ['cc', '--desktop', '--here'], ['cc', '--desktop', '--', '--model', 'opus'],
    ['cc', '--source', 'sdk'], ['cc', '--session'], ['cc', '--days', 'Infinity'],
    ['cc', '--budget', 'NaN'], ['cc', '--session', '--desktop'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /hop:/);
  }
  assert.equal(fs.existsSync(path.join(tmp, 'hop')), false);
});

test('CLI: desktop captures preserve launch metadata and cleanup removes only the selected capture', () => {
  const file = path.join(tmp, 'source.jsonl');
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'desktop-source', source: 'vscode', originator: 'Codex Desktop', cwd: tmp } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the login fix' }] } },
  ].map(r => JSON.stringify(r)).join('\n'));
  const args = ['cc', '--session', file, '--source', 'desktop', '--desktop', '--dry-run'];
  for (let i = 0; i < 2; i++) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[desktop\]/);
    assert.match(result.stdout, /codex:\/\/threads\/desktop-source/);
    assert.match(result.stdout, /claude:\/\/code\/new\?/);
  }
  const records = fs.readFileSync(path.join(tmp, 'hop', 'links.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].handoff, records[1].handoff);
  assert.equal(records[0].fromClient, 'desktop');
  assert.equal(records[0].toClient, 'desktop');
  const doc = fs.readFileSync(records[0].handoff, 'utf8');
  assert.match(doc, /Continue the login fix/);
  assert.match(doc, /Claude Code \(desktop\)/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(records[0].handoff).mode & 0o777, 0o600);
  const mismatch = run(['cc', '--session', file, '--source', 'cli', '--dry-run']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match/);
  const history = path.join(tmp, 'hop', 'links.jsonl');
  const source = path.join(tmp, 'source.jsonl');
  const originalSource = fs.readFileSync(source);
  const originalHistory = fs.readFileSync(history);
  const [selected, retained] = records;
  assert.notEqual(selected.captureId, retained.captureId);
  const listing = run(['clean', '--list']);
  assert.equal(listing.status, 0, listing.stderr);
  for (const value of [selected.captureId, retained.captureId, 'Continue the login fix', 'desktop-source', tmp]) {
    assert.ok(listing.stdout.includes(value), value);
  }
  const preview = run(['clean', selected.captureId]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /nothing deleted/);
  assert.ok(fs.existsSync(selected.handoff));
  assert.ok(fs.existsSync(selected.agentIndex));
  const retainedDocument = fs.readFileSync(retained.handoff);
  fs.appendFileSync(retained.handoff, `\nPrevious context: ${selected.handoff}\n`);
  const blocked = run(['clean', selected.captureId, '--yes']);
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stdout.includes(retained.captureId));
  assert.match(blocked.stdout, /Cleanup is blocked; nothing deleted/);
  assert.ok(fs.existsSync(selected.handoff));
  fs.writeFileSync(retained.handoff, retainedDocument);
  const deleted = run(['clean', selected.captureId, '--yes']);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.match(deleted.stdout, /Selected generated files deleted/);
  assert.equal(fs.existsSync(selected.handoff), false);
  assert.equal(fs.existsSync(path.dirname(selected.agentIndex)), false);
  assert.ok(fs.existsSync(retained.handoff));
  assert.ok(fs.existsSync(retained.agentIndex));
  assert.deepEqual(fs.readFileSync(source), originalSource);
  assert.deepEqual(fs.readFileSync(history), originalHistory);
  const remaining = run(['clean', '--list']);
  assert.equal(remaining.status, 0, remaining.stderr);
  assert.ok(!remaining.stdout.includes(selected.captureId));
  assert.ok(remaining.stdout.includes(retained.captureId));
});

test('CLI: --no-git avoids all Git commands during capture and marks the uninspected state', () => {
  const source = path.join(tmp, 'no-git-source.jsonl');
  fs.writeFileSync(source, [
    { type: 'session_meta', payload: { id: 'no-git-source', source: 'vscode', originator: 'Codex Desktop', cwd: tmp } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue without Git' }] } },
  ].map(r => JSON.stringify(r)).join('\n'));
  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const called = path.join(tmp, 'git-was-called');
  fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nprintf called > "$HOP_TEST_GIT_CALLED"\nexit 1\n', { mode: 0o700 });
  const root = path.join(tmp, 'no-git-hop');
  const result = run(['cc', '--session', source, '--desktop', '--dry-run', '--no-git'], {
    HOP_DIR: root, HOP_TEST_GIT_CALLED: called, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(called), false);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'links.jsonl'), 'utf8'));
  assert.match(fs.readFileSync(record.handoff, 'utf8'), /Git inspection was skipped by request/);
});
