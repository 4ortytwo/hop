import fs from 'node:fs';
import path from 'node:path';
import { HOME, readFirstLine } from './util.mjs';
import { parseCodex } from './codex.mjs';
import { readTranscript } from './subagents.mjs';
import { assignmentReadability } from './assignment-input.mjs';

const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const METHODS = new Set(['spawn_agent', 'send_message', 'send_input', 'followup_task', 'wait_agent', 'wait', 'list_agents', 'close_agent', 'interrupt_agent', 'resume_agent']);
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(v => v?.text ?? '').filter(Boolean).join('\n') : '';
const identifier = value => typeof value === 'string' && value.length > 0 && value.length < 1000 ? value : null;
const sourceOf = (rec, file, extra = {}) => ({ file, ts: rec.timestamp ?? null, ordinal: rec.ordinal ?? null, callId: rec.payload?.call_id, itemId: rec.payload?.id, ...extra });

function metadataIndex(warnings) {
  const index = new Map();
  const walk = (directory, depth = 0) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) { walk(file, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const first = JSON.parse(readFirstLine(file));
        if (first?.type !== 'session_meta' || !first.payload || typeof first.payload !== 'object') continue;
        const meta = first.payload, id = identifier(meta.id || meta.session_id);
        if (!id) continue;
        const item = { file, meta, mtime: fs.statSync(file).mtimeMs };
        const previous = index.get(id);
        if (previous && previous.file !== file) item.duplicates = (previous.duplicates || 0) + 1;
        if (!previous || item.mtime > previous.mtime) index.set(id, item);
        else if (item.duplicates) previous.duplicates = item.duplicates;
      } catch { /* Unrelated unreadable metadata cannot establish a child link. */ }
    }
  };
  walk(path.join(CODEX_HOME, 'sessions'));
  walk(path.join(CODEX_HOME, 'archived_sessions'));
  return index;
}

function childIdentity(meta) {
  const spawn = meta?.source?.subagent?.thread_spawn;
  // guardian/approval agents are not delegated work. A user fork's
  // forked_from_id is context provenance, never evidence of a child.
  if (!spawn || typeof spawn !== 'object') return null;
  const parentId = identifier(spawn.parent_thread_id) || identifier(meta.parent_thread_id);
  if (!parentId) return null;
  return {
    parentId, name: identifier(spawn.agent_path || meta.agent_path) || identifier(spawn.agent_nickname || meta.agent_nickname),
    agentPath: identifier(spawn.agent_path || meta.agent_path),
    role: identifier(spawn.agent_role || meta.agent_role), depth: spawn.depth,
  };
}

function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function outputObjects(value, out = []) {
  const parsed = decode(value);
  if (parsed && typeof parsed === 'object') {
    if (!Array.isArray(parsed)) out.push(parsed);
    for (const v of Object.values(parsed)) if (v && typeof v === 'object' || typeof v === 'string') outputObjects(v, out);
  }
  return out;
}

function toolMethod(payload, args) {
  const raw = payload.name || '';
  // Names may be bare with a namespace, dotted legacy functions names,
  // or normalized double-underscore names inside functions.exec.
  const method = [...METHODS].find(m => raw === m || raw.endsWith(`.${m}`) || raw.endsWith(`__${m}`));
  if (!method) return null;
  if (method === 'wait' && !/agent|collaboration/.test(`${payload.namespace || ''} ${raw}`) && !args?.ids && !args?.targets) return null;
  if (payload.namespace && !/agent|collaboration|functions/.test(payload.namespace)) return null;
  return method;
}

// Parse only literal arguments; never evaluate JavaScript from a transcript.
// Expressions, variables, template substitutions and executable values remain
// in the raw snapshot and produce an explicit interpretation warning.
function literal(code, start) {
  let i = start;
  const ws = () => { while (/\s/.test(code[i] || '') && i < code.length) i++; };
  const value = () => {
    ws();
    const quote = code[i];
    if (quote === '"' || quote === "'") {
      let result = ''; i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          i++; const c = code[i++];
          if (c === 'u') { const hex = code.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error(); result += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else if (c === 'x') { const hex = code.slice(i, i + 2); if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error(); result += String.fromCharCode(parseInt(hex, 16)); i += 2; }
          else {
            const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '/': '/' };
            if (!Object.hasOwn(escapes, c) || c === '0' && /\d/.test(code[i] || '')) throw new Error();
            result += escapes[c];
          }
        } else { if (code[i] === '\n' || code[i] === '\r') throw new Error(); result += code[i++]; }
      }
      if (code[i++] !== quote) throw new Error();
      return result;
    }
    if (quote === '{') {
      const object = {}; i++; ws();
      while (code[i] !== '}') {
        ws();
        const key = code[i] === '"' || code[i] === "'" ? value() : code.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
        if (key === undefined) throw new Error();
        if (code[i] !== '"' && code[i] !== "'" && code[i - 1] !== '"' && code[i - 1] !== "'") i += key.length;
        ws(); if (code[i++] !== ':') throw new Error();
        Object.defineProperty(object, key, { value: value(), enumerable: true });
        ws(); if (code[i] === '}') break;
        if (code[i++] !== ',') throw new Error(); ws();
      }
      if (code[i++] !== '}') throw new Error();
      return object;
    }
    if (quote === '[') {
      const array = []; i++; ws();
      while (code[i] !== ']') { array.push(value()); ws(); if (code[i] === ']') break; if (code[i++] !== ',') throw new Error(); ws(); }
      i++; return array;
    }
    const token = code.slice(i).match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$])/);
    if (!token) throw new Error();
    i += token[0].length; return JSON.parse(token[0]);
  };
  try { return { args: value(), end: i }; } catch { return null; }
}

function wrappedCalls(code) {
  const found = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (code[i] === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (`'"\``.includes(code[i])) {
      const q = code[i++];
      while (i < code.length && code[i] !== q) { if (code[i] === '\\') i++; i++; }
      continue;
    }
    const match = code.slice(i).match(/^tools\.([A-Za-z0-9_]+)\s*\(/);
    if (!match) continue;
    const parsed = literal(code, i + match[0].length);
    const method = toolMethod({ name: match[1] }, parsed?.args);
    if (method) found.push({ method, args: parsed?.args, interpreted: !!parsed });
    i += match[0].length - 1;
  }
  return found;
}

function observedStatus(value) {
  if (typeof value === 'string') {
    const status = { completed: 'completed', failed: 'failed', errored: 'failed', interrupted: 'interrupted', shutdown: 'closed', closed: 'closed', running: 'running', pending_init: 'unknown' }[value.toLowerCase()];
    return status ? { status } : null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const key of ['completed', 'failed', 'errored', 'interrupted', 'shutdown', 'closed', 'running']) {
    if (Object.hasOwn(value, key)) return { status: observedStatus(key).status, text: textOf(value[key]) };
  }
  return null;
}

function agentMessage(payload) {
  const text = textOf(payload.content);
  const match = text.match(/^Message Type: ([A-Z_]+)\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:\r?\n([\s\S]*)$/);
  const encrypted = Array.isArray(payload.content) ? payload.content.flatMap((part, contentIndex) =>
    part?.type === 'encrypted_content' ? [{ text: typeof part.encrypted_content === 'string' ? part.encrypted_content : null, contentIndex }] : []) : [];
  return match ? { kind: match[1], task: match[2], sender: match[3], text: match[4], encrypted } : { kind: 'unknown', text, encrypted };
}

export function collectCodexAgents(session, records) {
  const warnings = [], index = metadataIndex(warnings), nodes = new Map(), snapshots = new Map(), sources = [];
  const rootMeta = records.find(r => r.type === 'session_meta')?.payload || session.metadata || {};
  const root = { id: session.id, file: session.file, meta: rootMeta, records, node: null };
  const documents = new Map([[session.id, root]]);
  const provenanceDocuments = new Map(), interpretedRecords = new Map();
  const assignmentProgress = new Map(), latestNativeStarts = new Map();
  const allowedRoots = ['sessions', 'archived_sessions'].map(name => {
    try { return fs.realpathSync(path.join(CODEX_HOME, name)); } catch { return null; }
  }).filter(Boolean);
  let sequence = 0, unresolved = 0;

  const nodeFor = (id, parentId = session.id, relation = 'confirmed', hint = {}) => {
    if (id === session.id) return null;
    if (nodes.has(id)) return nodes.get(id);
    const item = index.get(id), identity = item && childIdentity(item.meta);
    const node = {
      id, parentId: identity?.parentId || parentId, name: identity?.name || hint.name,
      role: identity?.role || hint.role, relation, status: 'unknown', assignments: [], events: [], warnings: [],
      session: null, transcript: null, metadata: item?.meta || {}, ...hint,
    };
    nodes.set(id, node);
    return node;
  };
  const snapshot = item => {
    if (!snapshots.has(item.file)) {
      const real = fs.realpathSync(item.file);
      if (!fs.lstatSync(item.file).isFile() || !allowedRoots.some(directory => real.startsWith(directory + path.sep))) throw new Error('Transcript is not a regular file within the Codex session directories.');
      snapshots.set(item.file, readTranscript(item.file));
    }
    return snapshots.get(item.file);
  };
  const load = node => {
    if (documents.has(node.id)) return documents.get(node.id);
    const item = index.get(node.id);
    if (!item || !childIdentity(item.meta)) {
      node.warnings.push('No validated local child transcript was found for this referenced agent.');
      return null;
    }
    try {
      const capture = snapshot(item);
      // Validate again against the captured first record; the source can move
      // or change between indexing and reading.
      const meta = capture.records[0]?.type === 'session_meta' ? capture.records[0].payload : null;
      if ((meta?.id || meta?.session_id) !== node.id || childIdentity(meta)?.parentId !== node.parentId) throw new Error('Child metadata changed before capture.');
      node.transcript = { ...capture };
      node.warnings.push(...capture.warnings);
      if (item.duplicates) node.warnings.push('Multiple local transcripts have this child ID; the newest metadata file was selected.');
      node.metadata = meta;
      node.session = parseCodex(item.file, { records: capture.records });
      node.cwd = node.session.cwd; node.model = node.session.model;
      const doc = { id: node.id, file: item.file, meta, records: capture.records, node };
      documents.set(node.id, doc);
      return doc;
    } catch (error) { node.warnings.push(`Child transcript could not be captured: ${error.message}`); return null; }
  };

  // Parent links, not cwd/filename similarity or fork metadata, establish the
  // complete descendant tree, including archived and never-awaited children.
  const queue = [session.id], visited = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const [id, item] of index) {
      const identity = childIdentity(item.meta);
      if (!identity || identity.parentId !== parent || id === parent || id === session.id) continue;
      const node = nodeFor(id, parent);
      if (item.meta.parent_thread_id && item.meta.parent_thread_id !== identity.parentId) node.warnings.push('Top-level and source parent IDs disagree; the source thread_spawn parent was used.');
      load(node); queue.push(id);
    }
  }

  const status = (node, value, evidence) => {
    if (!node || !value) return;
    const nextTime = Date.parse(evidence.ts), oldTime = Date.parse(node.statusEvidence?.ts);
    const order = ++sequence;
    if (!node.statusEvidence || !Number.isFinite(oldTime) || !Number.isFinite(nextTime) || nextTime >= oldTime) {
      node.status = value;
      node.statusEvidence = { ...evidence, order, lastKnown: true };
    }
  };
  const event = (node, type, rec, doc, extra = {}, statusRec = rec) => {
    if (!node) return;
    // An observation of completion can still describe the preceding turn.
    // Until the newer assignment is tied to child lifecycle evidence, retain
    // the observation without treating the submitted work as finished.
    if (extra.status === 'completed' && node.pendingAssignmentEvidence) extra = { ...extra, observedStatus: extra.observedStatus || extra.status, status: 'unknown' };
    const evidence = sourceOf(rec, doc.file, { sessionId: doc.id, copiedFrom: doc.inlineCopiedFrom, originalFile: doc.originalFile });
    node.events.push({ type, ts: rec.timestamp ?? null, source: evidence, ...extra });
    if (extra.status) status(node, extra.status, { ...sourceOf(statusRec, doc.file, { sessionId: doc.id, copiedFrom: doc.inlineCopiedFrom, originalFile: doc.originalFile }), type });
  };
  const assignment = (node, text, kind, rec, doc, extra = {}) => {
    if (!node || !text && extra.readability !== 'opaque') return;
    const readability = extra.readability || assignmentReadability(text);
    node.assignments.push({ text, kind, readability, ts: rec.timestamp ?? null, source: sourceOf(rec, doc.file, { sessionId: doc.id, copiedFrom: doc.inlineCopiedFrom, originalFile: doc.originalFile, ...(extra.contentIndex === undefined ? {} : { contentIndex: extra.contentIndex }) }) });
    const warning = 'An opaque assignment was retained as evidence; its instruction text is not readable. Verify a complete readable brief before recreating this work.';
    if (readability === 'opaque' && !node.warnings.includes(warning)) node.warnings.push(warning);
  };
  const atOrAfter = (evidence, reference) => {
    const current = Date.parse(evidence?.ts), previous = Date.parse(reference?.ts);
    if (Number.isFinite(current) && Number.isFinite(previous)) return current >= previous;
    return evidence?.file === reference?.file && Number.isInteger(evidence?.ordinal) && Number.isInteger(reference?.ordinal) && evidence.ordinal >= reference.ordinal;
  };
  const pendingAssignment = (node, evidence, warning) => {
    const previous = assignmentProgress.get(node.id);
    // Documents are visited separately; an earlier delivered message must not
    // replace a later parent follow-up, even after that follow-up was matched.
    if (previous && atOrAfter(previous.evidence, evidence) && !atOrAfter(evidence, previous.evidence)) return;
    assignmentProgress.set(node.id, { evidence, warning, pending: true });
    node.pendingAssignmentEvidence = evidence;
    // A sibling's call may be visited after the recipient's transcript.
    const started = latestNativeStarts.get(node.id);
    if (started) acknowledgeAssignment(node, started);
  };
  const acknowledgeAssignment = (node, evidence) => {
    const progress = assignmentProgress.get(node.id);
    if (!progress?.pending || !atOrAfter(evidence, progress.evidence)) return;
    progress.pending = false;
    delete node.pendingAssignmentEvidence;
  };
  const lineageRoot = id => {
    const seen = new Set();
    while (identifier(id) && !seen.has(id)) {
      seen.add(id);
      const meta = documents.get(id)?.meta || provenanceDocuments.get(id)?.meta || index.get(id)?.meta;
      const identity = childIdentity(meta);
      if (!identity) return id;
      id = identity.parentId;
    }
    return null;
  };
  const resolve = (reference, doc, { stub = true } = {}) => {
    if (!identifier(reference)) return null;
    const selectedPath = rootMeta.agent_path || '/root';
    if (reference === '/root' || reference === selectedPath || reference.startsWith('/root/') && selectedPath.startsWith(reference + '/')) return null;
    if (nodes.has(reference)) return nodes.get(reference);
    if (reference === session.id) return null;
    if (reference === doc.id || reference === (doc.meta.agent_path || '/root')) return doc.node;
    const parentPath = doc.meta.agent_path || '/root';
    const full = reference.startsWith('/') ? reference : `${parentPath}/${reference}`;
    const tree = lineageRoot(doc.id);
    const explicit = index.get(reference), explicitIdentity = explicit && childIdentity(explicit.meta);
    if (explicitIdentity) {
      const relation = doc.forkProvenanceMissing && lineageRoot(reference) === doc.meta.forked_from_id ? 'historical' : 'unlinked';
      const node = nodeFor(reference, explicitIdentity.parentId, relation);
      node.warnings.push('This agent was explicitly referenced but is outside the confirmed descendant tree.');
      load(node); return node;
    }
    if (doc.forkProvenanceMissing) {
      if (!stub) return null;
      const node = nodeFor(`unresolved-fork:${doc.id}:${reference}`, doc.id, 'unlinked', { name: reference });
      if (!node.warnings.length) node.warnings.push('Inline fork ancestry is unavailable; this path-only reference could describe an inherited or current agent and was not attributed to either.');
      return node;
    }
    const choices = [...nodes.values()].filter(n => tree && lineageRoot(n.id) === tree &&
      (n.metadata?.agent_path === full || n.name === full || n.parentId === doc.id && n.name === reference));
    if (choices.length === 1) return choices[0];
    if (choices.length > 1) warnings.push(`Agent reference ${reference} is ambiguous; it was retained as an unresolved reference.`);
    const indexedPaths = [...index].filter(([, item]) => {
      const identity = childIdentity(item.meta);
      return identity && tree && lineageRoot(item.meta.id || item.meta.session_id) === tree &&
        (identity.agentPath === full || identity.parentId === doc.id && identity.name === reference);
    });
    if (indexedPaths.length === 1) {
      const [id, item] = indexedPaths[0], identity = childIdentity(item.meta);
      const relation = doc.historical ? 'historical' : documents.has(identity.parentId) ? 'confirmed' : 'unlinked';
      const node = nodeFor(id, identity.parentId, relation);
      if (relation === 'unlinked') node.warnings.push('This agent was explicitly referenced but is outside the confirmed descendant tree.');
      load(node); return node;
    }
    if (!stub) return null;
    const key = `unresolved:${doc.id}:${reference}`;
    const node = nodeFor(key, doc.id, 'unlinked', { name: reference });
    if (!node.warnings.length) node.warnings.push('Agent reference could not be linked to validated local metadata.');
    return node;
  };

  const histories = new Set();
  const historyOf = doc => {
    const ref = doc.meta.history_base;
    if (!ref?.thread_id || !Number.isInteger(ref.end_ordinal_exclusive) || ref.end_ordinal_exclusive < 0) return [];
    if (ref.thread_id === doc.id || histories.has(`${doc.id}:${ref.thread_id}`)) {
      (doc.node?.warnings || warnings).push('Cyclic or repeated history_base reference could not be materialized.'); return [];
    }
    histories.add(`${doc.id}:${ref.thread_id}`);
    const item = index.get(ref.thread_id);
    if (!item) { (doc.node?.warnings || warnings).push(`Missing history_base transcript ${ref.thread_id}; only the locally recorded context is available.`); return []; }
    try {
      const capture = snapshot(item);
      const capturedMeta = capture.records[0]?.type === 'session_meta' ? capture.records[0].payload : null;
      if ((capturedMeta?.id || capturedMeta?.session_id) !== ref.thread_id) throw new Error('History metadata changed before capture.');
      const raw = capture.raw || Buffer.from(capture.content);
      let boundary = raw.length, offset = 0, hasBoundary = false;
      while (offset < raw.length) {
        const newline = raw.indexOf(10, offset), end = newline < 0 ? raw.length : newline + 1;
        try {
          const rec = JSON.parse(raw.subarray(offset, end).toString('utf8'));
          if (rec.type !== 'session_meta' && (!Number.isInteger(rec.ordinal) || rec.ordinal >= ref.end_ordinal_exclusive)) {
            boundary = offset; hasBoundary = true; break;
          }
        } catch { boundary = offset; hasBoundary = true; break; }
        offset = end;
      }
      if (Number.isInteger(ref.end_byte_offset) && ref.end_byte_offset >= 0) {
        boundary = Math.min(boundary, ref.end_byte_offset); hasBoundary = true;
      }
      if (!hasBoundary) (doc.node?.warnings || warnings).push('history_base byte boundary was unavailable; only records before the recorded ordinal cutoff were retained.');
      const prefixRaw = raw.subarray(0, boundary), prefixContent = prefixRaw.toString('utf8');
      const prefix = [];
      for (const line of prefixContent.split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.type !== 'session_meta' && Number.isInteger(r.ordinal) && r.ordinal < ref.end_ordinal_exclusive) prefix.push(r);
        } catch { /* A byte cutoff can end inside a record; never cross it. */ }
      }
      const base = { id: ref.thread_id, file: item.file, meta: capturedMeta, records: prefix, node: null };
      const previous = provenanceDocuments.get(base.id);
      if (!previous || previous.records.length < prefix.length) provenanceDocuments.set(base.id, base);
      if (!documents.has(ref.thread_id) && !sources.some(s => s.file === capture.file && s.endOrdinalExclusive === ref.end_ordinal_exclusive)) {
        sources.push({ ...capture, records: prefix, raw: prefixRaw, content: prefixContent, kind: 'history-base-prefix', endOrdinalExclusive: ref.end_ordinal_exclusive, endByteOffset: boundary });
      }
      (doc.node?.warnings || warnings).push(...capture.warnings);
      return [...historyOf(base), { ...base, records: prefix, historical: true }];
    } catch (error) { (doc.node?.warnings || warnings).push(`history_base could not be captured: ${error.message}`); return []; }
  };

  const inherited = (doc, rec) => {
    if (rec.metadata?.inherited_user_message) return true;
    if (!doc.meta.forked_from_id) return false;
    const parent = documents.get(doc.meta.forked_from_id) || provenanceDocuments.get(doc.meta.forked_from_id);
    if (!parent) return false;
    parent.identity ||= {
      ids: new Set(parent.records.map(r => r.payload?.id).filter(Boolean)),
      calls: new Set(parent.records.map(r => r.payload?.call_id).filter(Boolean)),
      turns: new Set(parent.records.filter(r => r.type === 'event_msg').map(r => r.payload?.turn_id).filter(Boolean)),
    };
    const p = rec.payload || {};
    return !!(p.id && parent.identity.ids.has(p.id) || p.call_id && parent.identity.calls.has(p.call_id) || rec.type === 'event_msg' && p.turn_id && parent.identity.turns.has(p.turn_id));
  };

  const inlineHistoryOf = (doc, seen = new Set()) => {
    const id = identifier(doc.meta.forked_from_id);
    if (!id) return [];
    if (id === doc.id || seen.has(id)) {
      doc.forkProvenanceMissing = true;
      (doc.node?.warnings || warnings).push('Cyclic inline fork provenance could not be interpreted.'); return [];
    }
    seen.add(id);
    let ancestor = documents.get(id) || provenanceDocuments.get(id);
    if (!ancestor) {
      const item = index.get(id);
      if (!item) {
        doc.forkProvenanceMissing = true;
        (doc.node?.warnings || warnings).push(`Missing inline fork ancestor ${id}; copied collaboration records cannot be safely attributed.`);
        return [];
      }
      try {
        const capture = snapshot(item), meta = capture.records[0]?.type === 'session_meta' ? capture.records[0].payload : null;
        if ((meta?.id || meta?.session_id) !== id) throw new Error('Fork ancestor metadata changed before capture.');
        ancestor = { id, file: item.file, meta, records: capture.records, node: null };
        provenanceDocuments.set(id, ancestor);
        (doc.node?.warnings || warnings).push(...capture.warnings);
      } catch (error) {
        doc.forkProvenanceMissing = true;
        (doc.node?.warnings || warnings).push(`Inline fork ancestor could not be captured: ${error.message}`); return [];
      }
    }
    const copied = doc.records.filter(rec => rec.type !== 'session_meta' && inherited(doc, rec));
    if (!copied.length) return [];
    // Only records actually present in the selected transcript are dispatched.
    // Reading ancestor identity never exports or replays its unrelated suffix.
    const source = { ...ancestor, file: doc.file, originalFile: ancestor.file, records: copied, node: null, historical: !documents.has(id), inlineCopiedFrom: id };
    return [...inlineHistoryOf(source, seen), source];
  };

  const runTool = (call, result, rec, outputRec, doc, wrapped = false) => {
    const { method, args } = call;
    const output = decode(result), objects = outputObjects(result);
    const evidenceRec = outputRec || rec;
    const failure = !!(output && typeof output === 'object' && !Array.isArray(output) && (output.error || output.isError === true)) || /^\s*(Error\b|Failed to\b)/i.test(textOf(result));
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      (doc.node?.warnings || warnings).push(`Arguments of ${method}${wrapped ? ' inside functions.exec' : ''} were not interpretable; the raw call is retained.`);
      if (doc.node) event(doc.node, 'uninterpreted-collaboration-call', rec, doc, { raw: rec.payload });
      return;
    }
    if (method === 'spawn_agent') {
      const identity = objects.find(o => identifier(o.agent_id || o.thread_id || o.task_name));
      const ref = failure ? null : identity?.agent_id || identity?.thread_id || identity?.task_name || args.task_name;
      let node = ref && resolve(ref, doc, { stub: false });
      if (!node) {
        const id = !failure && identifier(identity?.agent_id || identity?.thread_id) || `unresolved-spawn:${doc.id}:${rec.payload?.call_id || ++unresolved}${wrapped ? `:${++unresolved}` : ''}`;
        node = nodeFor(id, doc.id, doc.historical ? 'historical' : 'unlinked', { name: args.task_name || identity?.nickname, role: args.agent_type });
        node.warnings.push(failure ? 'Spawn failed; no child transcript was established.' : outputRec ? 'Spawn result could not be linked to a child transcript.' : 'Spawn had no recorded result; the child may never have started.');
      }
      if (doc.historical && node.relation !== 'confirmed') node.relation = 'historical';
      assignment(node, textOf(args.message || args.prompt), 'spawn', rec, doc);
      event(node, 'spawn', evidenceRec, doc, { status: failure ? 'failed' : outputRec && identity ? 'running' : undefined, raw: output }, failure ? evidenceRec : rec);
      return;
    }
    if (method === 'list_agents') {
      const list = objects.find(o => Array.isArray(o.agents))?.agents;
      if (!list) { warnings.push('Unrecognized list_agents result; the source snapshot retains it.'); return; }
      for (const entry of list) {
        const node = resolve(entry.agent_id || entry.agent_name || entry.id, doc);
        const observation = observedStatus(entry.agent_status ?? entry.status);
        event(node, 'status-observation', evidenceRec, doc, { ...observation, raw: entry });
        if (!observation && node) node.warnings.push('Unrecognized agent status was retained without inferring a lifecycle state.');
      }
      return;
    }
    if (method === 'wait_agent' || method === 'wait') {
      const statuses = objects.find(o => o.status && typeof o.status === 'object')?.status;
      if (statuses) for (const [id, value] of Object.entries(statuses)) {
        const node = resolve(id, doc), observation = observedStatus(value);
        event(node, 'wait-result', evidenceRec, doc, { ...observation, raw: value });
        if (!observation && node) node.warnings.push('Unrecognized wait status was retained without inferring a lifecycle state.');
      }
      for (const ref of args.targets || args.ids || []) resolve(ref, doc);
      return;
    }
    const reference = args.target || args.id || args.agent_id;
    const node = resolve(reference, doc);
    if (!node) {
      if (doc.node && ['send_message', 'send_input', 'followup_task'].includes(method)) {
        event(doc.node, 'outgoing-message', evidenceRec, doc, { text: textOf(args.message || args.prompt), recipient: reference, raw: output });
        if (failure) doc.node.warnings.push(`A ${method} delivery from this agent failed; review the recorded context before relying on it having reached the recipient.`);
      }
      return;
    }
    if (method === 'send_message' || method === 'send_input' || method === 'followup_task') {
      assignment(node, textOf(args.message || args.prompt), method === 'followup_task' ? 'followup' : 'message', rec, doc);
      const resumes = method === 'followup_task' || method === 'send_input';
      // Submission acknowledges the request, not activity at ACK arrival time.
      event(node, method, evidenceRec, doc, { status: resumes && !failure ? outputRec ? 'running' : 'unknown' : undefined, raw: output }, rec);
      if (failure) node.warnings.push(resumes
        ? `A ${method} delivery failed; the newer request needs review even if previously delivered work completed.`
        : 'A send_message delivery failed; review whether the intended context reached this agent.');
      if (resumes && !failure) {
        // A successful submission does not identify the receiving turn. The
        // input can be delivered to a running turn after its pending tool call.
        pendingAssignment(node, sourceOf(rec, doc.file, { sessionId: doc.id }), outputRec
          ? 'A newer follow-up was acknowledged, but has no matching recorded child lifecycle acknowledgement; an earlier completion does not cover it.'
          : 'A newer follow-up has no recorded acknowledgement; the earlier completion does not establish the state of this assignment.');
      }
    } else {
      const lifecycle = { close_agent: 'closed', interrupt_agent: 'interrupted', resume_agent: 'running' }[method];
      const reported = method === 'resume_agent' ? observedStatus(output?.status) : null;
      event(node, method, evidenceRec, doc, { status: outputRec && !failure ? reported?.status || lifecycle : undefined, raw: output });
    }
  };

  const processDocument = doc => {
    if (doc.node?.relation === 'historical') {
      doc.historical = true;
      const warning = 'This historical child transcript was captured in full and may contain activity after the source fork; check record timestamps before reusing later assignments or state.';
      if (!doc.node.warnings.includes(warning)) doc.node.warnings.push(warning);
    }
    const own = doc.records.filter(rec => !inherited(doc, rec));
    const outputs = new Map(own.filter(r => r.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(r.payload?.type)).map(r => [r.payload.call_id, r]));
    const nativeTurns = new Map();
    const nativeStarts = new Map();
    for (const r of own) if (r.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(r.payload?.type)) {
      if (r.payload.turn_id) {
        nativeTurns.set(r.payload.turn_id, r);
        if (r.payload.type === 'task_started') nativeStarts.set(r.payload.turn_id, r);
      }
    }
    let triggerTurn = false;
    if (!interpretedRecords.has(doc.id)) interpretedRecords.set(doc.id, new Set());
    const seen = interpretedRecords.get(doc.id);
    for (const rec of own) {
      const p = rec.payload || {};
      const key = p.id ? `item:${p.id}` : p.call_id ? `${p.type}:${p.call_id}`
        : rec.type === 'event_msg' && p.turn_id ? `${p.type}:${p.turn_id}`
          : Number.isInteger(rec.ordinal) ? `ordinal:${rec.ordinal}` : JSON.stringify(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      if (rec.type === 'inter_agent_communication_metadata') triggerTurn = rec.payload?.trigger_turn === true;
      if (rec.type === 'event_msg' && /^collab_/.test(p.type || '')) {
        const statusMap = p.agent_statuses || p.statuses;
        if (statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)) {
          for (const [id, value] of Object.entries(statusMap)) event(resolve(id, doc), p.type, rec, doc, { ...observedStatus(value), raw: p });
        }
        const refs = p.receiver_thread_ids || [p.receiver_thread_id || p.agent_id || p.new_agent_id].filter(Boolean);
        for (const ref of refs) {
          const node = resolve(ref, doc);
          if (/spawn|send|interaction/.test(p.type)) assignment(node, textOf(p.prompt || p.message), /spawn/.test(p.type) ? 'spawn' : 'message', rec, doc);
          const observation = observedStatus(p.agent_status || p.status);
          const lifecycle = /(?:close|shutdown).*end$/.test(p.type) && p.success !== false ? 'closed' : /spawn.*end$/.test(p.type) && p.success !== false ? observation?.status || 'running' : undefined;
          event(node, p.type, rec, doc, { ...observation, status: lifecycle || observation?.status, raw: p });
        }
        if (!refs.length && !statusMap) (doc.node?.warnings || warnings).push(`Unrecognized ${p.type} routing; the raw collaboration event is retained in the source snapshot.`);
      }
      if (rec.type === 'event_msg' && doc.node) {
        const lifecycle = { task_started: 'running', task_complete: 'completed', turn_aborted: 'interrupted' }[p.type];
        if (lifecycle) {
          const started = p.type === 'task_started' ? rec : nativeStarts.get(p.turn_id);
          const startEvidence = started && sourceOf(started, doc.file, { turnId: started.payload.turn_id });
          const latestStart = latestNativeStarts.get(doc.id);
          // Completion delivery time cannot supersede a newer known turn.
          const differentTurn = p.type !== 'task_started' && p.turn_id && latestStart?.turnId && p.turn_id !== latestStart.turnId;
          const oldTurn = differentTurn && startEvidence && atOrAfter(latestStart, startEvidence);
          const unmatchedTurn = differentTurn && !startEvidence;
          if (unmatchedTurn) doc.node.warnings.push('A child terminal record names a different turn from the latest recorded start, but its own start is missing; that record does not establish the state of the latest started turn.');
          if (p.type === 'task_started' && (!latestStart || atOrAfter(startEvidence, latestStart))) latestNativeStarts.set(doc.id, startEvidence);
          if (!oldTurn && startEvidence) acknowledgeAssignment(doc.node, startEvidence);
          const pending = doc.node.pendingAssignmentEvidence;
          const unmatchedTerminal = pending && p.type !== 'task_started' && atOrAfter(sourceOf(rec, doc.file), pending);
          const lifecycleStatus = unmatchedTurn ? 'unknown' : oldTurn ? undefined : pending ? unmatchedTerminal ? 'unknown' : undefined : lifecycle;
          event(doc.node, p.type, rec, doc, { status: lifecycleStatus, observedStatus: lifecycle, text: p.last_agent_message || p.reason, raw: p });
          const previous = Date.parse(doc.node.lastNativeStatus?.ts), current = Date.parse(rec.timestamp);
          if (!Number.isFinite(previous) || !Number.isFinite(current) || current >= previous) doc.node.lastNativeStatus = { status: lifecycle, ...sourceOf(rec, doc.file, { sessionId: doc.id, turnId: p.turn_id }) };
        }
        else if (/collab|agent|abort|error/.test(p.type || '')) event(doc.node, p.type, rec, doc, { raw: p });
      }
      if (rec.type !== 'response_item') continue;
      if (p.type === 'agent_message') {
        const message = agentMessage(p);
        if (p.recipient === (doc.meta.agent_path || '/root') && p.author !== (doc.meta.agent_path || '/root') && message.kind === 'MESSAGE' && !doc.node) {
          event(resolve(p.author || message.sender, doc), 'message', rec, doc, { text: message.text, raw: p });
          continue;
        }
        const isAssignment = ['NEW_TASK', 'MESSAGE'].includes(message.kind);
        const reference = isAssignment ? p.recipient || message.task : p.author || message.sender;
        const node = reference === (doc.meta.agent_path || '/root') ? doc.node : resolve(reference, doc);
        if (isAssignment) {
          assignment(node, message.text, message.kind === 'NEW_TASK' ? 'assignment' : 'message', rec, doc);
          for (const part of message.encrypted) assignment(node, part.text, message.kind === 'NEW_TASK' ? 'assignment' : 'message', rec, doc,
            { readability: 'opaque', contentIndex: part.contentIndex });
          if (node && (message.kind === 'NEW_TASK' || triggerTurn)) {
            const turnId = p.internal_chat_message_metadata_passthrough?.turn_id;
            const lifecycle = node === doc.node && turnId && nativeTurns.get(turnId);
            const accountedFor = lifecycle && (lifecycle.payload.type === 'task_started' || Date.parse(lifecycle.timestamp) >= Date.parse(rec.timestamp));
            const evidence = sourceOf(rec, doc.file, { sessionId: doc.id, kind: 'delivered-assignment' });
            pendingAssignment(node, evidence, 'A newer delivered assignment has no matching recorded child lifecycle acknowledgement; an earlier completion does not cover it.');
            if (!accountedFor) {
              event(node, 'pending-assignment', rec, doc, { status: 'unknown', text: message.text });
            }
            if (accountedFor) acknowledgeAssignment(node, evidence);
          }
        }
        // A final report can arrive after a newer follow-up has started. Its
        // delivery timestamp does not identify the sender's completed turn.
        // Child lifecycle records and explicit status observations determine
        // last-known state; the report is retained independently.
        else event(node, message.kind === 'FINAL_ANSWER' ? 'report' : 'agent-message', rec, doc, { text: message.text, raw: p });
        triggerTurn = false;
      }
      if (!['function_call', 'custom_tool_call'].includes(p.type)) continue;
      const args = decode(p.arguments ?? p.input), method = toolMethod(p, args), resultRec = outputs.get(p.call_id);
      if (method) runTool({ method, args }, resultRec?.payload.output, rec, resultRec, doc);
      else if ((p.name === 'exec' || /[._]exec$/.test(p.name || '')) && typeof args === 'string') {
        const calls = wrappedCalls(args), objects = outputObjects(resultRec?.payload.output);
        const identities = objects.filter(o => identifier(o.agent_id || o.thread_id || o.task_name));
        for (const call of calls) {
          const matching = identities.filter(o => o.task_name === call.args?.task_name || identities.length === 1 && calls.length === 1);
          const output = matching.length === 1 ? matching[0] : calls.length === 1 ? resultRec?.payload.output : undefined;
          if (calls.length > 1 && !output) (doc.node?.warnings || warnings).push(`A wrapped ${call.method} result could not be paired unambiguously; the raw functions.exec result is retained.`);
          runTool(call, output, rec, output !== undefined ? resultRec : undefined, doc, true);
        }
      }
    }
  };

  const processed = new Set();
  for (const doc of documents.values()) {
    if (processed.has(doc.id)) continue;
    processed.add(doc.id);
    for (const base of historyOf(doc)) processDocument(base);
    for (const base of inlineHistoryOf(doc)) processDocument(base);
    processDocument(doc);
  }
  for (const node of nodes.values()) {
    if (!node.transcript && !node.warnings.length) node.warnings.push('No local transcript was recovered.');
    const progress = assignmentProgress.get(node.id);
    if (progress?.pending) {
      node.warnings.push(progress.warning);
      // Lifecycle may have been visited before a sibling's newer assignment.
      // An unmatched completed observation cannot establish its completion.
      if (node.status === 'completed') {
        node.status = 'unknown';
        node.statusEvidence = { ...progress.evidence, type: 'pending-assignment', order: ++sequence, lastKnown: true };
      }
    }
    node.assignments.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    node.events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  }
  return { agents: [...nodes.values()], warnings, sources };
}
