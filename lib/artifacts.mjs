import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { HOP_DIR } from './util.mjs';
import { LANG } from './i18n.mjs';

const COPY = {
  en: {
    unsafe: (file, why) => `Unsafe artifact ${file}: ${why}`,
    unreadable: (file, why) => `Could not inspect ${file}: ${why}`,
    malformed: line => `Malformed capture metadata at links.jsonl line ${line}`,
    missing: file => `Missing registered artifact: ${file}`,
    lock: (file, owner, state) => `Artifact operations are locked at ${file} (${owner}; ${state}). On the recorded host, verify that PID is no longer running before manually removing this regular lock file. Never remove a lock owned by an active process.`,
    unknownOwner: 'owner unavailable', live: 'process is running or its state is unknown', stale: 'recorded local PID is no longer running', remote: 'owner is on another host',
    notFound: selector => `No registered capture matches ${JSON.stringify(selector)}; use a capture ID or stem, not a source session ID`,
    ambiguous: (selector, ids) => `Capture selector ${JSON.stringify(selector)} is ambiguous: ${ids.join(', ')}`,
    blocked: 'Cleanup blocked by retained references or unsafe/incomplete managed evidence',
    partial: why => `Cleanup stopped: ${why}. Some files may have been deleted; inspect the remaining paths and retry this capture.`,
    changed: file => `Artifact changed during inspection: ${file}`,
    duplicate: stem => `Conflicting or duplicate capture metadata: ${stem}`,
    overwritten: count => `${count} older capture(s) at this legacy path were overwritten; only the latest registered metadata describes the remaining file.`,
    limitation: 'Reference checks cover this Hop directory only. Active chats, provider logs, and other Hop directories may still refer to these files.',
    legacyScript: 'Unregistered legacy launch scripts and unindexed artifacts are left untouched.',
    incomplete: file => `Retained capture has incomplete evidence: ${file}`,
    integrity: (file, field) => `Retained evidence ${field} does not match its capture manifest: ${file}`,
  },
  zh: {
    unsafe: (file, why) => `不安全的交接文件 ${file}：${why}`,
    unreadable: (file, why) => `无法检查 ${file}：${why}`,
    malformed: line => `links.jsonl 第 ${line} 行的交接元数据损坏`,
    missing: file => `已登记的交接文件不存在：${file}`,
    lock: (file, owner, state) => `交接文件操作已锁定：${file}（${owner}；${state}）。请在记录的主机上确认该 PID 已停止后，手动删除这个普通锁文件。不要删除仍在运行的进程持有的锁。`,
    unknownOwner: '锁的所有者未知', live: '进程仍在运行或状态未知', stale: '记录的本机 PID 已停止', remote: '锁的所有者在另一台主机上',
    notFound: selector => `没有交接文件匹配 ${JSON.stringify(selector)}；请使用交接 ID 或文件名，不要使用源会话 ID`,
    ambiguous: (selector, ids) => `交接选择 ${JSON.stringify(selector)} 不唯一：${ids.join(', ')}`,
    blocked: '保留的交接文件仍有引用，或托管文件不安全、不完整，无法清理',
    partial: why => `清理已停止：${why}。部分文件可能已删除；请检查剩余路径后重试这个交接。`,
    changed: file => `检查期间交接文件发生变化：${file}`,
    duplicate: stem => `重复或冲突的交接元数据：${stem}`,
    overwritten: count => `这个旧版路径的 ${count} 个早期交接已被覆盖；剩余文件使用最后登记的元数据。`,
    limitation: '引用检查仅覆盖这个 Hop 目录。活跃聊天、源工具日志和其他 Hop 目录仍可能引用这些文件。',
    legacyScript: '未登记的旧启动脚本和交接文件不会被删除。',
    incomplete: file => `保留的交接证据不完整：${file}`,
    integrity: (file, field) => `保留的证据 ${field} 与交接清单不一致：${file}`,
  },
};
const m = COPY[LANG];
const LEGACY_STEM = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(codex|claude)-to-(codex|claude)$/;
const STEM = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(codex|claude)-to-(codex|claude)(?:-[a-f0-9]{8})?$/;
const FLAT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|json|jsonl)$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAX_METADATA = 16 * 1024 * 1024;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const existsStat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const fingerprint = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });

// The root may have canonical OS aliases in its ancestors (for example /tmp),
// but the root itself and managed child directories must never be symlinks.
function location(root, { create = false } = {}) {
  const resolved = path.resolve(root);
  if (create && !existsStat(resolved)) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = existsStat(resolved);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw fail('UNSAFE_ARTIFACT', m.unsafe(resolved, 'root must be a non-symlink directory'));
  return { root: resolved, canonical: stat ? fs.realpathSync(resolved) : null };
}
function managedDir(loc, name) {
  const file = path.join(loc.root, name), stat = existsStat(file);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.join(loc.canonical, name)) {
    throw fail('UNSAFE_ARTIFACT', m.unsafe(file, 'managed directory must be canonical and non-symlink'));
  }
  return stat;
}
function regular(file) {
  const stat = existsStat(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('UNSAFE_ARTIFACT', m.unsafe(file, 'expected a regular non-symlink file'));
  return stat;
}
function openRegular(file) {
  const before = regular(file);
  if (!before) throw fail('INCOMPLETE_ARTIFACT', m.incomplete(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || !same(before, current)) throw fail('CHANGED_ARTIFACT', m.changed(file));
    return { fd, stat: current };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function readMetadata(file, limit = MAX_METADATA) {
  const { fd, stat } = openRegular(file);
  try {
    if (stat.size > limit) throw fail('UNSAFE_ARTIFACT', m.unsafe(file, `metadata exceeds ${limit} bytes`));
    const data = Buffer.alloc(stat.size);
    let pos = 0;
    while (pos < data.length) {
      const count = fs.readSync(fd, data, pos, data.length - pos, pos);
      if (!count) throw fail('INCOMPLETE_ARTIFACT', m.incomplete(file));
      pos += count;
    }
    if (!same(stat, fs.fstatSync(fd)) || !same(stat, regular(file))) throw fail('CHANGED_ARTIFACT', m.changed(file));
    return data.toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function captureIdentity({ session, from, to, title, root = HOP_DIR, now = new Date() }) {
  if (!['codex', 'claude'].includes(from) || !['codex', 'claude'].includes(to)) throw fail('BAD_CAPTURE', 'Unsupported capture direction');
  const loc = location(root);
  for (const name of ['handoffs', 'run']) managedDir(loc, name);
  const log = path.join(loc.root, 'links.jsonl');
  const logStat = regular(log), reservedIds = new Set(), reservedStems = new Set();
  if (logStat) for (const line of readMetadata(log).split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.captureId === 'string') reservedIds.add(row.captureId);
    if (typeof row?.handoff === 'string') reservedStems.add(path.basename(row.handoff, '.md'));
  }
  const task = typeof title === 'string' && title.trim() ? title.trim()
    : typeof session?.title === 'string' && session.title.trim() ? session.title.trim()
      : session?.turns?.find(turn => typeof turn.user === 'string' && turn.user.trim())?.user.trim().split('\n')[0] || null;
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomBytes(4).toString('hex'), stem = `${stamp}-${from}-to-${to}-${id}`;
    const handoff = path.join(loc.root, 'handoffs', `${stem}.md`), bundle = path.join(loc.root, 'handoffs', `${stem}.agents`), script = path.join(loc.root, 'run', `${stem}.sh`);
    if (!reservedIds.has(id) && !reservedStems.has(stem) && ![handoff, bundle, script].some(file => existsStat(file))) return { id, stem, handoff, bundle, script, title: task };
  }
  throw fail('CAPTURE_COLLISION', 'Could not allocate a unique capture identity');
}

// Synchronous callers hold this lock across capture, publication, or deletion.
// A stale lock is never stolen: another host or a reused PID cannot be verified
// reliably. Recovery instructions preserve that uncertainty explicitly.
export function withArtifactLock(callback, { root = HOP_DIR } = {}) {
  const loc = location(root, { create: true }), file = path.join(loc.root, '.artifacts.lock');
  for (const name of ['handoffs', 'run']) managedDir(loc, name);
  regular(path.join(loc.root, 'links.jsonl'));
  const token = randomBytes(16).toString('hex');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner, state = m.live;
    try { owner = JSON.parse(readMetadata(file, 64 * 1024)); } catch { /* unsafe/unreadable lock is not removable */ }
    if (owner?.host !== os.hostname()) state = owner?.host ? m.remote : m.live;
    else if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (check) { if (check.code === 'ESRCH') state = m.stale; }
    }
    throw fail('ARTIFACT_LOCKED', m.lock(file, owner?.host && owner?.pid ? `${owner.host} PID ${owner.pid}` : m.unknownOwner, state), { lock: owner, lockPath: file });
  }
  let stat = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ host: os.hostname(), pid: process.pid, token, createdAt: new Date().toISOString() }) + '\n');
    stat = fs.fstatSync(fd);
    const result = callback();
    if (result && typeof result.then === 'function') throw fail('ASYNC_ARTIFACT_LOCK', 'Artifact lock callbacks must be synchronous');
    return result;
  } finally {
    fs.closeSync(fd);
    // Release only our own inode; never unlink a replacement lock.
    const current = existsStat(file);
    if (stat && current?.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) fs.unlinkSync(file);
  }
}

function inspectBundle(bundle) {
  const stat = existsStat(bundle);
  if (!stat) return { files: [], stat: null };
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSAFE_ARTIFACT', m.unsafe(bundle, 'bundle must be a non-symlink directory'));
  const files = fs.readdirSync(bundle).sort().map(name => {
    const file = path.join(bundle, name);
    if (!FLAT.test(name)) throw fail('UNSAFE_ARTIFACT', m.unsafe(file, 'unexpected bundle filename or nested content'));
    const info = regular(file);
    if (!info) throw fail('CHANGED_ARTIFACT', m.changed(file));
    return { path: file, type: 'file', bytes: info.size, fingerprint: fingerprint(info) };
  });
  return { files, stat };
}
function trustedPath(value, expected, label) {
  if (value !== undefined && value !== null && value !== expected) throw fail('UNSAFE_ARTIFACT', m.unsafe(String(value), `${label} does not match its owned capture path`));
}
function declaredEvidence(manifest, directory) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !Array.isArray(manifest.agents || []) || !Array.isArray(manifest.evidenceSources || []) || !Array.isArray(manifest.sources || [])) {
    throw fail('MALFORMED_METADATA', m.unsafe(directory, 'invalid manifest'));
  }
  const declared = new Set();
  for (const source of [...(manifest.evidenceSources || []), ...(manifest.sources || [])]) if (source?.file) declared.add(source.file);
  for (const agent of manifest.agents || []) {
    if (!agent || typeof agent !== 'object' || !Array.isArray(agent.sources || []) ||
        (agent.files && (typeof agent.files !== 'object' || Array.isArray(agent.files)))) throw fail('MALFORMED_METADATA', m.unsafe(directory, 'invalid manifest agent'));
    for (const file of Object.values(agent.files || {})) if (file) declared.add(file);
    for (const source of agent.sources || []) if (source?.file) declared.add(source.file);
  }
  for (const name of declared) if (typeof name !== 'string' || !FLAT.test(name)) throw fail('UNSAFE_ARTIFACT', m.unsafe(directory, 'manifest contains an unsafe evidence filename'));
  return declared;
}
function missingEvidence(manifest, fileNames, directory) {
  const expected = new Set(['source.jsonl', 'source-context.json', 'manifest.json', 'index.md']);
  if (manifest.version >= 2) expected.add('recovery.md');
  for (const name of declaredEvidence(manifest, directory)) expected.add(name);
  return [...expected].filter(name => !fileNames.has(name)).map(name => path.join(directory, name));
}
function evidenceIntegrity(manifest, directory) {
  const expectations = {};
  const add = (name, byteLength, sha256) => {
    if (byteLength === undefined && sha256 === undefined) return;
    if (typeof name !== 'string' || !FLAT.test(name) ||
        (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) ||
        (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)))) {
      throw fail('MALFORMED_METADATA', m.unsafe(directory, 'invalid evidence integrity metadata'));
    }
    const prior = expectations[name] || {};
    const next = { ...(byteLength !== undefined ? { byteLength } : {}), ...(sha256 !== undefined ? { sha256: sha256.toLowerCase() } : {}) };
    for (const field of Object.keys(next)) if (prior[field] !== undefined && prior[field] !== next[field]) throw fail('MALFORMED_METADATA', m.unsafe(directory, `conflicting evidence ${field}: ${name}`));
    expectations[name] = { ...prior, ...next };
  };
  for (const source of [...(manifest.evidenceSources || []), ...(manifest.sources || []), ...(manifest.agents || []).flatMap(agent => agent.sources || [])]) {
    if (source?.file) add(source.file, source.byteLength, source.sha256);
  }
  const source = expectations['source.jsonl'] || {};
  add('source.jsonl', source.byteLength === undefined ? manifest.sourceByteLength : undefined,
    source.sha256 === undefined ? manifest.sourceSha256 : undefined);
  return expectations;
}
function recordArtifact(row, line, loc) {
  const warnings = [], incomplete = [];
  const base = { id: `invalid-line-${line}`, stem: null, title: null, cwd: row?.cwd ?? null,
    from: row?.from ?? null, fromId: row?.fromId ?? null, fromDesktopId: row?.fromDesktopId ?? null,
    to: row?.to ?? null, ts: row?.ts ?? null, handoff: null, bundle: null, script: null,
    bytes: 0, warnings, incomplete, safe: false, status: 'unsafe', line, files: [], integrity: {} };
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.handoff !== 'string') throw fail('MALFORMED_METADATA', m.malformed(line));
    const basename = path.basename(row.handoff), stem = basename.slice(0, -3);
    if (!basename.endsWith('.md') || !STEM.test(stem)) throw fail('UNSAFE_ARTIFACT', m.unsafe(row.handoff, 'unrecognized capture basename'));
    const handoff = path.join(loc.root, 'handoffs', `${stem}.md`), bundle = path.join(loc.root, 'handoffs', `${stem}.agents`), script = path.join(loc.root, 'run', `${stem}.sh`);
    trustedPath(row.handoff, handoff, 'handoff');
    trustedPath(row.bundle, bundle, 'bundle');
    trustedPath(row.agentIndex, path.join(bundle, 'index.md'), 'agent index');
    trustedPath(row.script, script, 'launch script');
    const captureId = row.captureId ?? row.id;
    if (captureId !== undefined && (typeof captureId !== 'string' || !/^[a-f0-9]{8}$/.test(captureId) || !stem.endsWith(`-${captureId}`))) throw fail('UNSAFE_ARTIFACT', m.unsafe(handoff, 'capture ID does not match basename'));
    const bundleRegistered = Boolean(row.agentIndex || row.bundle);
    Object.assign(base, { id: captureId || stem, stem, handoff, bundle: bundleRegistered ? bundle : null, bundleRegistered,
      script: row.script ? script : null, title: typeof row.title === 'string' ? row.title : null,
      legacy: captureId === undefined && LEGACY_STEM.test(stem) });
    managedDir(loc, 'handoffs');
    if (row.script) managedDir(loc, 'run');
    const h = regular(handoff), b = bundleRegistered ? inspectBundle(bundle) : { files: [], stat: null }, s = row.script ? regular(script) : null;
    if (!h && !b.stat && !s) { base.safe = true; base.status = 'removed'; return base; }
    if (!h) incomplete.push(handoff);
    if (bundleRegistered && !b.stat) incomplete.push(bundle);
    if (row.script && !s) warnings.push(m.missing(script));
    const fileNames = new Set(b.files.map(file => path.basename(file.path)));
    let context, manifest;
    if (fileNames.has('source-context.json')) {
      const contextFile = path.join(bundle, 'source-context.json');
      // Large source context remains fully scanned as dependency evidence. Its
      // display metadata need not be loaded once recorded directly in v2 rows.
      const info = regular(contextFile);
      if (info.size <= MAX_METADATA) context = JSON.parse(readMetadata(contextFile));
      else if (!base.title || !base.cwd) warnings.push(m.unreadable(contextFile, 'display metadata exceeds bounded read size; title/cwd may be unavailable'));
    }
    if (fileNames.has('manifest.json')) {
      manifest = JSON.parse(readMetadata(path.join(bundle, 'manifest.json')));
      const owned = new Set(['source.jsonl', 'source-context.json', 'manifest.json', 'index.md', 'recovery.md', ...declaredEvidence(manifest, bundle)]);
      for (const name of fileNames) if (!owned.has(name)) throw fail('UNSAFE_ARTIFACT', m.unsafe(path.join(bundle, name), 'file is not declared as generated bundle evidence'));
      incomplete.push(...missingEvidence(manifest, fileNames, bundle));
      base.integrity = evidenceIntegrity(manifest, bundle);
    } else if (b.stat) {
      // The manifest remains until all other children are gone. Without it,
      // ownership cannot be established for any remaining nonempty bundle.
      if (b.files.length) throw fail('UNSAFE_ARTIFACT', m.unsafe(bundle, 'nonempty registered bundle is missing its ownership manifest'));
      incomplete.push(path.join(bundle, 'manifest.json'));
    }
    if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context))) throw fail('MALFORMED_METADATA', m.unsafe(bundle, 'invalid source context'));
    if (!base.title) base.title = [context?.title, context?.task, manifest?.title, manifest?.task].find(value => typeof value === 'string' && value.trim()) || null;
    if (!base.title && Array.isArray(context?.turns)) base.title = context.turns.find(turn => typeof turn?.user === 'string' && turn.user.trim())?.user.trim().split('\n')[0] || null;
    if (!base.cwd) base.cwd = typeof context?.cwd === 'string' ? context.cwd : null;
    for (const file of new Set(incomplete)) warnings.push(m.missing(file));
    if (!row.script) warnings.push(m.legacyScript);
    const files = [...(h ? [{ path: handoff, type: 'file', bytes: h.size, fingerprint: fingerprint(h) }] : []), ...b.files,
      ...(s ? [{ path: script, type: 'file', bytes: s.size, fingerprint: fingerprint(s) }] : []),
      ...(b.stat ? [{ path: bundle, type: 'directory', bytes: 0, fingerprint: fingerprint(b.stat) }] : [])];
    Object.assign(base, { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), safe: true, status: 'present' });
    return base;
  } catch (error) {
    base.safe = false; base.status = 'unsafe'; warnings.push(error.message);
    return base;
  }
}

export function listArtifacts({ root = HOP_DIR } = {}) {
  const loc = location(root);
  if (!loc.canonical) return [];
  const log = path.join(loc.root, 'links.jsonl');
  if (!existsStat(log)) return [];
  const lines = readMetadata(log).split('\n'), artifacts = [];
  for (const [index, text] of lines.entries()) {
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); } catch { /* retained as visible unsafe row */ }
    artifacts.push(recordArtifact(row, index + 1, loc));
  }
  const groups = new Map();
  for (const artifact of artifacts) if (artifact.stem) {
    const duplicates = groups.get(artifact.stem) || [];
    duplicates.push(artifact); groups.set(artifact.stem, duplicates);
  }
  const superseded = new Set();
  for (const [stem, group] of groups) if (group.length > 1) {
    // Original Hop wrote the same path again within one second. Its append-only
    // rows describe an overwrite, not independent files that can be deleted.
    // Never use this compatibility rule to hide an unsafe or modern duplicate.
    const latest = group.at(-1);
    if (group.every(artifact => artifact.legacy && artifact.safe && artifact.script === latest.script && artifact.bundle === latest.bundle)) {
      for (const artifact of group.slice(0, -1)) superseded.add(artifact);
      latest.warnings.push(m.overwritten(group.length - 1));
    } else for (const artifact of group) {
      artifact.safe = false; artifact.status = 'unsafe'; artifact.warnings.push(m.duplicate(stem));
    }
  }
  const retained = artifacts.filter(artifact => !superseded.has(artifact)), ids = new Map();
  for (const artifact of retained) if (/^[a-f0-9]{8}$/.test(artifact.id)) {
    const group = ids.get(artifact.id) || [];
    group.push(artifact); ids.set(artifact.id, group);
  }
  for (const [id, group] of ids) if (group.length > 1) for (const artifact of group) {
    artifact.safe = false; artifact.status = 'unsafe'; artifact.warnings.push(m.duplicate(id));
  }
  return retained;
}

function selectArtifact(artifacts, selector) {
  if (typeof selector !== 'string' || !selector.trim()) throw fail('CAPTURE_NOT_FOUND', m.notFound(selector));
  const matching = artifacts.filter(artifact => artifact.id === selector || artifact.stem === selector);
  if (!matching.length) throw fail('CAPTURE_NOT_FOUND', m.notFound(selector));
  if (matching.length > 1) throw fail('AMBIGUOUS_CAPTURE', m.ambiguous(selector, matching.map(artifact => artifact.id)));
  return matching[0];
}

// Scan immutable-size snapshots in bounded chunks, retaining only the suffix
// needed for a stem split across chunks. No JSON interpretation can hide a raw
// transcript reference, including malformed or incomplete JSONL text.
function containsStem(file, stem, integrity = {}) {
  const needle = Buffer.from(stem, 'ascii'), { fd, stat } = openRegular(file);
  try {
    if (integrity.byteLength !== undefined && stat.size !== integrity.byteLength) throw fail('INCOMPLETE_ARTIFACT', m.integrity(file, 'byteLength'));
    const hash = integrity.sha256 ? createHash('sha256') : null;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0, suffix = Buffer.alloc(0), found = false;
    while (position < stat.size) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!length) throw fail('INCOMPLETE_ARTIFACT', m.incomplete(file));
      hash?.update(buffer.subarray(0, length));
      const joined = Buffer.concat([suffix, buffer.subarray(0, length)]);
      let offset = 0, match;
      while ((match = joined.indexOf(needle, offset)) !== -1) {
        const end = match + needle.length, next = joined[end];
        const hasBoundary = next === undefined ? position + length === stat.size
          : !((next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 45 || next === 95);
        if (hasBoundary) found = true;
        offset = match + 1;
      }
      suffix = joined.subarray(Math.max(0, joined.length - needle.length));
      position += length;
    }
    if (!same(stat, fs.fstatSync(fd)) || !same(stat, regular(file))) throw fail('CHANGED_ARTIFACT', m.changed(file));
    if (hash && hash.digest('hex') !== integrity.sha256) throw fail('INCOMPLETE_ARTIFACT', m.integrity(file, 'sha256'));
    return found;
  } finally { fs.closeSync(fd); }
}
function scanRetained(loc, artifact, inventory, blockers) {
  const dependents = [], byStem = new Map(inventory.filter(item => item.stem).map(item => [item.stem, item]));
  if (!managedDir(loc, 'handoffs')) return dependents;
  for (const name of fs.readdirSync(path.join(loc.root, 'handoffs')).sort()) {
    if (name.startsWith('.capture-')) continue; // staging is never owned by cleanup
    const extension = name.endsWith('.agents') ? '.agents' : name.endsWith('.md') ? '.md' : null;
    const stem = extension ? name.slice(0, -extension.length) : null;
    const file = path.join(loc.root, 'handoffs', name);
    if (!stem || !STEM.test(stem)) { blockers.push(m.unsafe(file, 'unrecognized retained content')); continue; }
    if (stem === artifact.stem && (extension === '.md' || artifact.bundleRegistered)) continue;
    let files, integrity = byStem.get(stem)?.bundleRegistered ? byStem.get(stem).integrity : {};
    try {
      files = extension === '.agents' ? inspectBundle(file).files : [{ path: file }];
      if (extension === '.agents' && !byStem.get(stem)?.bundleRegistered) {
        const names = new Set(files.map(item => path.basename(item.path)));
        if (!names.has('manifest.json')) throw fail('INCOMPLETE_ARTIFACT', m.incomplete(path.join(file, 'manifest.json')));
        const manifest = JSON.parse(readMetadata(path.join(file, 'manifest.json')));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw fail('MALFORMED_METADATA', m.unsafe(file, 'invalid retained manifest'));
        for (const missing of missingEvidence(manifest, names, file)) blockers.push(m.incomplete(missing));
        integrity = evidenceIntegrity(manifest, file);
      }
      const hits = [];
      for (const item of files) {
        try { if (containsStem(item.path, artifact.stem, extension === '.agents' ? integrity[path.basename(item.path)] : undefined)) hits.push(item.path); }
        catch (error) { blockers.push(m.unreadable(item.path, error.message)); }
      }
      if (hits.length) {
        let dependent = dependents.find(item => item.stem === stem);
        if (!dependent) { dependent = { id: byStem.get(stem)?.id || stem, stem, files: [] }; dependents.push(dependent); }
        dependent.files.push(...hits);
      }
    } catch (error) { blockers.push(m.unreadable(file, error.message)); }
  }
  return dependents;
}
export function planCleanup(selector, { root = HOP_DIR } = {}) {
  const loc = location(root), artifacts = listArtifacts({ root: loc.root });
  const artifact = selectArtifact(artifacts, selector), blockers = [];
  const warnings = [...artifact.warnings, m.limitation, m.legacyScript];
  for (const item of artifacts) {
    if (!item.safe) blockers.push(...item.warnings);
    if (item.stem !== artifact.stem && item.status !== 'removed') for (const file of item.incomplete) blockers.push(m.incomplete(file));
  }
  let dependents = [];
  try { dependents = scanRetained(loc, artifact, artifacts, blockers); }
  catch (error) { blockers.push(error.message); }
  return { artifact, files: artifact.files, totalBytes: artifact.bytes, dependents, warnings: [...new Set(warnings)], blockers: [...new Set(blockers)],
    safe: artifact.safe && blockers.length === 0, canClean: artifact.safe && blockers.length === 0 && dependents.length === 0 };
}

function revalidate(plan, root) {
  const loc = location(root);
  managedDir(loc, 'handoffs');
  if (plan.artifact.script) managedDir(loc, 'run');
  // Re-enumerate the entire flat bundle to catch new files before any unlink.
  if (plan.artifact.bundleRegistered) {
    const bundle = inspectBundle(plan.artifact.bundle);
    const planned = plan.files.filter(file => path.dirname(file.path) === plan.artifact.bundle).map(file => file.path).sort();
    if (JSON.stringify(bundle.files.map(file => file.path).sort()) !== JSON.stringify(planned)) throw fail('CHANGED_ARTIFACT', m.changed(plan.artifact.bundle));
  }
  for (const file of plan.files) {
    const stat = existsStat(file.path);
    if (!stat || stat.isSymbolicLink() || (file.type === 'file' ? !stat.isFile() : !stat.isDirectory()) || !same(file.fingerprint, stat)) throw fail('CHANGED_ARTIFACT', m.changed(file.path));
  }
}
export function cleanArtifact(selector, { root = HOP_DIR } = {}) {
  return withArtifactLock(() => {
    const plan = planCleanup(selector, { root });
    if (!plan.canClean) throw fail('CLEANUP_BLOCKED', m.blocked, { plan });
    revalidate(plan, root);
    const deletedPaths = [];
    const bundleIdentity = plan.files.find(file => file.type === 'directory' && file.path === plan.artifact.bundle)?.fingerprint;
    // Preserve identifying bundle metadata until last, so interruption remains
    // inspectable; missing selected files can be safely retried from log history.
    const order = [...plan.files].sort((a, b) => {
      const rank = file => file.type === 'directory' ? 5 : /\/manifest\.json$/.test(file.path) ? 3
        : /\/source-context\.json$/.test(file.path) ? 2 : file.path === plan.artifact.handoff ? 4 : 1;
      return rank(a) - rank(b) || a.path.localeCompare(b.path);
    });
    try {
      for (const file of order) {
        const loc = location(root);
        managedDir(loc, 'handoffs');
        if (file.path === plan.artifact.script) managedDir(loc, 'run');
        if (path.dirname(file.path) === plan.artifact.bundle) {
          const directory = existsStat(plan.artifact.bundle);
          if (!directory?.isDirectory() || directory.isSymbolicLink() || !bundleIdentity ||
              directory.dev !== bundleIdentity.dev || directory.ino !== bundleIdentity.ino) throw fail('CHANGED_ARTIFACT', m.changed(plan.artifact.bundle));
        }
        const current = existsStat(file.path);
        // Bundle mtime changes as its owned children are removed; its inode and
        // empty-directory check remain the guard at rmdir time.
        if (!current || current.isSymbolicLink() || current.dev !== file.fingerprint.dev || current.ino !== file.fingerprint.ino ||
            (file.type === 'file' && (!current.isFile() || !same(file.fingerprint, current))) ||
            (file.type === 'directory' && !current.isDirectory())) throw fail('CHANGED_ARTIFACT', m.changed(file.path));
        if (file.type === 'directory') fs.rmdirSync(file.path); else fs.unlinkSync(file.path);
        deletedPaths.push(file.path);
      }
    } catch (error) {
      throw fail('PARTIAL_CLEANUP', m.partial(error.message), { cause: error, plan, deletedPaths, remainingPaths: order.filter(file => !deletedPaths.includes(file.path)).map(file => file.path) });
    }
    return { ...plan, deletedPaths, removed: true };
  }, { root });
}
