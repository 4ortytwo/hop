import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the distributable archive through its installed command, using only
// synthetic provider data. No registry access, app launch, or agent execution.
const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-package-'));
const fixtureBin = path.join(temporary, 'fixture-bin');
const env = {
  ...process.env,
  CODEX_HOME: path.join(temporary, 'codex'),
  CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
  HOP_CLAUDE_DESKTOP_DIR: path.join(temporary, 'claude-desktop'),
  HOP_DIR: path.join(temporary, 'captures'),
  HOP_LANG: 'en',
  HOP_PACKAGE_LSOF_LOG: path.join(temporary, 'fixture-lsof.log'),
  PATH: [fixtureBin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
};

function run(command, args, cwd = temporary) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr}`);
  return result.stdout;
}

function npm(args, cwd) {
  const config = ['--offline', '--cache', path.join(temporary, 'npm-cache'),
    '--userconfig', path.join(temporary, 'npm-user-config'),
    '--globalconfig', path.join(temporary, 'npm-global-config')];
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args, ...config], cwd)
    : run('npm', [...args, ...config], cwd);
}

function modules(directory) {
  return fs.readdirSync(path.join(repository, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return modules(relative);
    assert.ok(entry.isFile() && entry.name.endsWith('.mjs'), `Review unexpected runtime file: ${relative}`);
    return [relative];
  });
}

try {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'Package check requires macOS or Linux.');
  fs.mkdirSync(fixtureBin);
  // --no-git still collects listener metadata. Intercept lsof so the package
  // smoke check cannot enumerate real processes before filtering by cwd.
  fs.writeFileSync(path.join(fixtureBin, 'lsof'),
    '#!/bin/sh\nprintf "fixture\\n" >> "$HOP_PACKAGE_LSOF_LOG"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(temporary, 'npm-user-config'), '');
  fs.writeFileSync(path.join(temporary, 'npm-global-config'), '');
  const [archive] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], repository));
  const expected = ['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md',
    ...modules('bin'), ...modules('lib')].sort();
  assert.deepEqual(archive.files.map(file => file.path).sort(), expected,
    'Package must contain exactly the reviewed runtime, metadata, and user documentation.');

  const prefix = path.join(temporary, 'installed');
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', path.join(temporary, archive.filename)]);
  const command = path.join(prefix, 'bin', 'hop');
  assert.match(run(command, ['--help']), /hop/);
  assert.equal(fs.existsSync(env.HOP_DIR), false, 'Help must not create captures.');

  const fixtures = [
    { to: 'cc', protocol: 'claude:', file: 'codex-source.jsonl', records: [
      { type: 'session_meta', payload: { id: 'package-codex-source', source: 'vscode', originator: 'Codex Desktop', cwd: temporary } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic package handoff' }] } },
    ] },
    { to: 'codex', protocol: 'codex:', file: 'claude-source.jsonl', records: [
      { type: 'user', uuid: 'package-user', parentUuid: null, cwd: temporary,
        entrypoint: 'claude-desktop', message: { role: 'user', content: 'Synthetic package handoff' } },
    ] },
  ];
  for (const fixture of fixtures) {
    const source = path.join(temporary, fixture.file);
    fs.writeFileSync(source, fixture.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const before = fs.readFileSync(source);
    const output = run(command, [fixture.to, '--session', source, '--source', 'desktop',
      '--desktop', '--dry-run', '--no-git']);
    assert.ok(output.includes(`${fixture.protocol}//`), 'Installed command must produce the destination draft URL.');
    assert.deepEqual(fs.readFileSync(source), before, 'Capture must preserve its synthetic source.');
    const records = fs.readFileSync(path.join(env.HOP_DIR, 'links.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const capture = records.at(-1);
    assert.equal(capture.fromClient, 'desktop');
    assert.equal(capture.toClient, 'desktop');
    assert.match(fs.readFileSync(capture.handoff, 'utf8'), /Synthetic package handoff/);
    assert.ok(fs.existsSync(capture.agentIndex), 'Installed runtime must write its evidence bundle.');
    run(command, ['clean', capture.captureId, '--yes']);
    assert.equal(fs.existsSync(capture.handoff), false);
    assert.equal(fs.existsSync(source), true);
  }
  assert.equal(fs.readFileSync(env.HOP_PACKAGE_LSOF_LOG, 'utf8'), 'fixture\n'.repeat(fixtures.length),
    'Listener enrichment must use only the synthetic executable.');
  console.log(`Package check passed: ${archive.files.length} reviewed files; isolated global install; both desktop draft directions; capture cleanup.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
