import fs from 'node:fs';
import path from 'node:path';
import { parseClaude, claudeActiveRecords, claudeFileById } from './claude.mjs';
import { readTranscript } from './subagents.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length ? value : null;
const safeId = value => string(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const blocks = rec => Array.isArray(rec.message?.content) ? rec.message.content.filter(object) : [];
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(b => b?.text || '').filter(Boolean).join('\n') : value == null ? '' : JSON.stringify(value);
const toolInput = (rec, block) => object(rec.wireToolInputs?.[block.id]) ? rec.wireToolInputs[block.id] : block.input || {};
const spawnNames = new Set(['Agent', 'Task', 'mcp__ccd_session__spawn_task']);
const collaborationNames = new Set([...spawnNames, 'SendMessage', 'SubagentHandback',
  'StructuredOutput', 'ListAgents', 'TaskStop', 'mcp__ccd_session__dismiss_task']);
const statusFor = value => ({ completed: 'completed', failed: 'failed', stopped: 'interrupted',
  interrupted: 'interrupted', closed: 'closed', running: 'running', async_launched: 'running',
  in_progress: 'running' })[value] || 'unknown';

// Walk only schema-owned directories. Neither outputFile nor transcriptDir from
// a tool result is a file-reading instruction, and symlinks are not followed.
function regular(file, directory = false) {
  try {
    const stat = fs.lstatSync(file);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  } catch { return false; }
}
function entries(dir) {
  if (!regular(dir, true)) return [];
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function resultData(rec, block) {
  if (object(rec.toolUseResult)) return rec.toolUseResult;
  try { const parsed = JSON.parse(text(block.content)); return object(parsed) ? parsed : {}; } catch { return {}; }
}
function agentIdFor(rec, block) {
  return string(resultData(rec, block).agentId) || text(block.content).match(/(?:^|\n)agentId:\s*([A-Za-z0-9_-]+)/)?.[1];
}

// Retain the collaboration evidence needed to recover delegated work, while
// leaving ordinary tool output and conversation in the captured raw file.
// Tool identities remain available because a workflow can be launched by an
// otherwise unrelated tool (for example Bash).
function collaborationRecords(records, active, ordinals) {
  const relevantTools = new Set();
  for (const rec of records) for (const block of blocks(rec)) {
    if (block.type === 'tool_use' && collaborationNames.has(block.name)) relevantTools.add(block.id);
  }
  const projected = [], projectedActive = new Set();
  for (const [index, rec] of records.entries()) {
    const value = Object.fromEntries(['type', 'uuid', 'parentUuid', 'promptId', 'timestamp', 'cwd',
      'isMeta', 'isCompactSummary', 'isSidechain'].filter(key => rec[key] !== undefined).map(key => [key, rec[key]]));
    const content = rec.message?.content;
    // Claude can mark lifecycle notices as metadata. They remain status
    // evidence even though ordinary metadata text is not a new assignment.
    const keepUserText = rec.type === 'user' && ((!rec.isMeta && !rec.isCompactSummary) ||
      text(content).trimStart().startsWith('<task-notification'));
    if (typeof content === 'string' && keepUserText) {
      value.message = { content };
    } else if (Array.isArray(content)) {
      const kept = [];
      for (const block of content) {
        if (!object(block)) {
          if (keepUserText) kept.push({ type: 'unparsed_content' });
          continue;
        }
        if (block.type === 'tool_use') {
          kept.push({ type: 'tool_use', id: block.id, name: block.name,
            ...(relevantTools.has(block.id) ? { input: toolInput(rec, block) } : {}) });
        } else if (block.type === 'tool_result') {
          const data = resultData(rec, block);
          const relevant = relevantTools.has(block.tool_use_id) || data.taskType === 'local_workflow';
          // Even an unrelated result must retain its type: a mixed text/result
          // message is not a new child assignment.
          kept.push(relevant ? block : { type: 'tool_result', tool_use_id: block.tool_use_id });
          if (relevant && rec.toolUseResult !== undefined) value.toolUseResult = rec.toolUseResult;
          if (relevant && rec.toolEndsTurn !== undefined) value.toolEndsTurn = rec.toolEndsTurn;
        } else if (keepUserText && block.type === 'text') {
          kept.push(block);
        } else if (keepUserText) {
          // Preserve mixed-message shape without keeping image/other payloads;
          // dropping them could turn quoted input into a native lifecycle notice.
          kept.push({ type: block.type });
        }
      }
      if (kept.length) value.message = { content: kept };
    }
    if (rec.type === 'attachment' && ['queued_command', 'task_status', 'structured_output'].includes(rec.attachment?.type)) {
      value.attachment = rec.attachment;
    }
    if (rec.type === 'system' && rec.subtype === 'api_error') {
      value.subtype = rec.subtype;
      value.error = rec.error;
      value.content = rec.content;
    }
    if (!value.message && !value.attachment && value.subtype !== 'api_error') continue;
    ordinals.set(value, index + 1);
    projected.push(value);
    if (active.has(rec)) projectedActive.add(value);
  }
  return { records: projected, active: projectedActive };
}

const snapshotDescriptor = snapshot => {
  const { records, raw, content, ...descriptor } = snapshot;
  return descriptor;
};

function latestRecordedTimestamp(records) {
  let latest = null, time = -Infinity;
  for (const rec of records) {
    const value = string(rec.timestamp), parsed = value && Date.parse(value);
    if (Number.isFinite(parsed) && parsed > time) { latest = value; time = parsed; }
  }
  return latest;
}

function primaryTranscript(current, candidate) {
  const previous = Date.parse(current.latestRecordedTimestamp), next = Date.parse(candidate.latestRecordedTimestamp);
  if (Number.isFinite(previous) && Number.isFinite(next) && previous !== next) {
    return { replace: next > previous, basis: 'latest recorded timestamp', ambiguous: false };
  }
  if (Number.isFinite(current.sourceMtimeMs) && Number.isFinite(candidate.sourceMtimeMs) && current.sourceMtimeMs !== candidate.sourceMtimeMs) {
    return { replace: candidate.sourceMtimeMs > current.sourceMtimeMs, basis: 'captured source modification time', ambiguous: true };
  }
  if (Number.isFinite(previous) !== Number.isFinite(next)) {
    return { replace: Number.isFinite(next), basis: 'the available recorded timestamp', ambiguous: true };
  }
  return { replace: candidate.file < current.file, basis: 'stable filename order', ambiguous: true };
}

export function collectClaudeAgents(session, records, { capture = readTranscript, compact = false } = {}) {
  const nodes = new Map(), warnings = [], documents = [], snapshots = new Map(), indexedScopes = new Set();
  const byTool = new Map(), workflowNodes = new Map(), relationFacts = new Map(), lifecycleCandidates = new Map();
  const ordinals = new WeakMap(), metadataByFile = new Map();
  const sourceAt = (rec, file, index, active, extra = {}) => ({ file,
    record: ordinals.get(rec) || index + 1, uuid: rec.uuid || null, currentBranch: active.has(rec), ...extra });
  const ensure = (id, parentId = session.id) => {
    if (!nodes.has(id)) nodes.set(id, { id, parentId, relation: 'unlinked', status: 'unknown',
      assignments: [], events: [], warnings: [], sources: [], session: null, transcript: null });
    return nodes.get(id);
  };
  const warn = (node, message) => { if (!node.warnings.includes(message)) node.warnings.push(message); };
  const event = (node, type, rec, file, index, active, data = {}) => {
    const value = { type, ts: rec.timestamp || null, source: sourceAt(rec, file, index, active), ...data };
    node.events.push(value);
    return value;
  };
  const observed = (node, status, evidence) => {
    if (status === 'unknown') return;
    const candidates = lifecycleCandidates.get(node.id) || [];
    candidates.push({ status, evidence });
    lifecycleCandidates.set(node.id, candidates);
    if (evidence.source?.currentBranch === false && evidence.source?.provenance !== 'workflow-journal') return;
    // Timestamped observations from separate files may arrive out of order.
    // Journal records have no timestamps; their order is retained separately.
    if (evidence.ts && node.statusEvidence?.ts && evidence.ts < node.statusEvidence.ts) return;
    node.status = status;
    node.statusEvidence = evidence;
  };
  const relation = (node, active, owner = null) => {
    const facts = relationFacts.get(node.id) || [];
    facts.push({ active, ownerId: owner?.id || session.id });
    relationFacts.set(node.id, facts);
    const value = active ? (owner && owner.relation !== 'confirmed' ? owner.relation : 'confirmed') : 'historical';
    if (node.relation === 'unlinked' || value === 'confirmed') node.relation = value;
  };
  const recordRun = (node, call, item) => {
    if (!call || !call.doc.active.has(call.rec)) return false;
    const source = sourceAt(call.rec, call.doc.file, call.index, call.doc.active);
    const start = call.rec.timestamp || null;
    const previous = node.runs?.at(-1);
    if (previous && previous.toolId !== call.block.id) {
      if (start && previous.ts && start < previous.ts) return false;
      if ((!start || !previous.ts) && source.file === previous.source.file && source.record < previous.source.record) return false;
    }
    if (!previous || previous.toolId !== call.block.id) {
      node.runs ||= [];
      node.runs.push({ toolId: call.block.id, ts: start, kind: call.block.name,
        isResume: call.block.name === 'SendMessage' || !!safeId(call.input?.resume), source });
    }
    item.runToolId = call.block.id;
    return true;
  };
  const promoteLifecycle = (node, status, item, toolId = null) => {
    if (item.source.currentBranch === false) return;
    const run = node.runs?.at(-1);
    if (run && toolId && run.toolId !== toolId) {
      item.supersededRun = true;
      item.runToolId = toolId;
      return;
    }
    if ((node.runs?.length > 1 || run?.isResume) && !toolId && ['completed', 'failed', 'interrupted', 'closed'].includes(status)) {
      item.ambiguousRun = true;
      warn(node, 'A lifecycle update after a resume has no dispatch/run ID; it cannot establish that the newest assignment ended.');
      if (item.source.currentBranch && (!item.ts || !node.statusEvidence?.ts || item.ts >= node.statusEvidence.ts)) {
        node.status = 'unknown';
        node.statusEvidence = item;
      }
      return;
    }
    if (toolId) item.runToolId = toolId;
    observed(node, status, item);
  };
  const assignment = (node, value, kind, rec, file, index, active, input, toolId = null) => {
    if (!string(value)) return;
    node.assignments.push({ text: value, ts: rec.timestamp || null, kind,
      source: sourceAt(rec, file, index, active), ...(input ? { input } : {}), ...(toolId ? { requestToolId: toolId } : {}) });
  };
  const snapshot = file => {
    if (snapshots.has(file)) return snapshots.get(file);
    if (!regular(file)) return null;
    try {
      const value = capture(file);
      if (compact && !string(value.snapshotFile)) throw new Error('Compact capture requires a preserved snapshotFile; the live transcript cannot replace captured evidence.');
      snapshots.set(file, compact ? snapshotDescriptor(value) : value);
      return value;
    }
    catch (error) { warnings.push(`Could not capture Claude transcript ${file}: ${error.message}`); return null; }
  };
  const applyMetadata = (node, meta, file) => {
    node.metadata = meta;
    node.metadataSource = file;
    node.name = string(meta.description) || node.name;
    node.role = string(meta.agentType) || node.role;
    node.model = string(meta.model) || node.model;
    if (safeId(meta.parentAgentId)) node.parentId = meta.parentAgentId;
  };
  const addDocument = (file, recs, ownerId, child, snap = null, metadata = null) => {
    if (documents.some(d => d.file === file)) return;
    const active = new Set(claudeActiveRecords(recs, { child }));
    const evidence = compact ? collaborationRecords(recs, active, ordinals) : { records: recs, active };
    documents.push({ file, ...evidence, ownerId, child });
    if (snap) {
      const node = ensure(ownerId);
      const candidate = { ...(compact ? snapshotDescriptor(snap) : snap), latestRecordedTimestamp: latestRecordedTimestamp(recs) };
      let primary = true;
      if (node.transcript) {
        const choice = primaryTranscript(node.transcript, candidate);
        primary = choice.replace;
        const history = primary ? node.transcript : candidate;
        node.sources.push({ ...history, kind: 'agent-history' });
        warn(node, `Multiple local transcripts share agent ID ${node.id}; all snapshots are retained. The primary transcript is selected by ${choice.basis}${choice.ambiguous ? '; chronology is ambiguous.' : '.'}`);
      }
      if (primary) node.transcript = candidate;
      if (recs.some(r => Array.isArray(r.message?.content) && r.message.content.some(b => !object(b) || (b.type === 'text' && typeof b.text !== 'string')))) {
        warn(node, 'Malformed message content blocks could not be normalized; the raw child transcript is retained.');
      }
      if (primary) {
        node.session = null;
        node.cwd = null;
        node.model = string(metadata?.model);
        if (metadata) applyMetadata(node, metadata, file.replace(/\.jsonl$/, '.meta.json'));
        try {
          node.session = parseClaude(file, { records: recs, child });
          if (compact) delete node.session.turns;
          node.sessionId = node.session.sessionId || node.session.id;
          node.cwd = node.session.cwd;
          node.model ||= node.session.model;
        } catch (error) {
          warn(node, `Could not normalize child transcript ${file}: ${error.message}; the raw snapshot is retained.`);
        }
      }
      for (const message of snap.warnings) warn(node, message);
    }
  };
  const readMetadata = (node, file) => {
    if (metadataByFile.has(file)) return metadataByFile.get(file);
    if (!regular(file)) return null;
    if (node.sources.some(source => source.file === file)) return null;
    try {
      const raw = fs.readFileSync(file), content = raw.toString('utf8');
      node.sources.push({ file, content, raw, kind: 'agent-metadata' });
      const meta = JSON.parse(content);
      if (!object(meta)) throw new Error('metadata is not an object');
      metadataByFile.set(file, meta);
      if (!node.transcript || node.transcript.file === file.replace(/\.meta\.json$/, '.jsonl')) applyMetadata(node, meta, file);
      if (safeId(meta.toolUseId)) byTool.set(meta.toolUseId, node);
      return meta;
    } catch (error) {
      metadataByFile.set(file, null);
      warn(node, `Could not interpret agent metadata ${file}: ${error.message}`);
      return null;
    }
  };
  const indexMetadata = (file, rootId, workflow = null) => {
    const id = path.basename(file, '.meta.json').replace(/^agent-/, '');
    if (!safeId(id)) return null;
    const node = ensure(id, rootId);
    readMetadata(node, file);
    if (workflow) { node.workflowId = workflow; node.kind = 'workflow-agent'; }
    return node;
  };
  const readChild = (file, rootId, workflow = null) => {
    const id = path.basename(file, '.jsonl').replace(/^agent-/, '');
    if (!safeId(id)) return;
    const node = ensure(id, rootId), snap = snapshot(file);
    if (!snap) return;
    // A previously captured descriptor has already been indexed (or rejected).
    // Never reread a live file to reconstruct its captured evidence.
    if (!snap.records) return;
    const identity = snap.records.filter(r => r.sessionId || r.agentId);
    if (identity.some(r => (r.sessionId && r.sessionId !== rootId) || (r.agentId && r.agentId !== id))) {
      warn(node, `Transcript identity does not match its scoped session/agent filename: ${file}`);
      node.sources.push({ ...(compact ? snapshotDescriptor(snap) : snap), kind: 'identity-mismatch' });
      return;
    }
    const metadata = readMetadata(node, file.replace(/\.jsonl$/, '.meta.json'));
    if (workflow) { node.workflowId = workflow; node.kind = 'workflow-agent'; }
    addDocument(file, snap.records, id, true, snap, metadata);
  };
  const indexScope = (file, rootId) => {
    if (!safeId(rootId)) { warnings.push(`Cannot safely locate child transcripts for session ${rootId}.`); return; }
    const scope = path.join(path.dirname(file), rootId, 'subagents');
    if (indexedScopes.has(scope)) return;
    indexedScopes.add(scope);
    // Check every directory below the known parent transcript directory.
    if (!regular(path.dirname(scope), true) || !regular(scope, true)) return;
    for (const entry of entries(scope)) {
      const target = path.join(scope, entry.name);
      if (entry.isSymbolicLink()) { warnings.push(`Skipped symlink in Claude child store: ${target}`); continue; }
      if (entry.isFile() && /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) readChild(target, rootId);
      if (entry.isFile() && /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(entry.name)) indexMetadata(target, rootId);
      if (entry.name !== 'workflows' || !entry.isDirectory()) continue;
      for (const workflow of entries(target)) {
        if (workflow.isSymbolicLink()) { warnings.push(`Skipped symlink in Claude workflow store: ${workflow.name}`); continue; }
        if (!workflow.isDirectory() || !/^wf_[A-Za-z0-9_-]+$/.test(workflow.name)) continue;
        const dir = path.join(target, workflow.name), journal = snapshot(path.join(dir, 'journal.jsonl'));
        const agents = [];
        for (const child of entries(dir)) {
          if (child.isSymbolicLink()) { warnings.push(`Skipped symlink in Claude workflow: ${path.join(dir, child.name)}`); continue; }
          if (child.isFile() && /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(child.name)) {
            readChild(path.join(dir, child.name), rootId, workflow.name);
            const node = ensure(child.name.slice(6, -6), rootId);
            if (!agents.includes(node)) agents.push(node);
          }
          if (child.isFile() && /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(child.name)) {
            const node = indexMetadata(path.join(dir, child.name), rootId, workflow.name);
            if (node && !agents.includes(node)) agents.push(node);
          }
        }
        if (journal) {
          for (const [i, rec] of journal.records.entries()) {
            if (!safeId(rec.agentId)) continue;
            const node = ensure(rec.agentId, rootId);
            node.workflowId = workflow.name;
            node.kind = 'workflow-agent';
            node.name ||= string(rec.label);
            if (!agents.includes(node)) agents.push(node);
            const item = event(node, `workflow_${rec.type}`, rec, journal.file, i, new Set(), {
              key: rec.key, phase: rec.phase, ...(rec.result !== undefined ? { result: rec.result } : {}) });
            item.source.provenance = 'workflow-journal';
            if (rec.type === 'result') observed(node, 'completed', item);
            else if (rec.type === 'failed') observed(node, 'failed', item);
            else if (rec.type === 'started') observed(node, 'running', item);
          }
          for (const node of agents) {
            node.sources.push({ ...(compact ? snapshotDescriptor(journal) : journal), kind: 'workflow-journal' });
            for (const message of journal.warnings) warn(node, message);
          }
        }
        workflowNodes.set(workflow.name, agents);
      }
    }
  };

  addDocument(session.file, records, session.id, false);
  indexScope(session.file, session.id);

  // Index all dispatches first. A metadata file can identify a launch whose
  // result was never written; a result can identify a launch without metadata.
  const calls = new Map();
  for (let d = 0; d < documents.length; d++) {
    const doc = documents[d];
    for (const [i, rec] of doc.records.entries()) {
      for (const block of blocks(rec)) {
        if (block.type !== 'tool_use' || !string(block.id)) continue;
        calls.set(block.id, { block, input: toolInput(rec, block), rec, index: i, doc });
      }
    }
    // Older Claude CLI versions stored agent logs beside the main transcript.
    // Read only IDs explicitly returned for this session, never every sibling.
    for (const rec of doc.records) for (const block of blocks(rec)) {
      if (block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id);
      if (!call || !spawnNames.has(call.block.name)) continue;
      const data = resultData(rec, block);
      const agentId = agentIdFor(rec, block);
      if (safeId(agentId) && !nodes.get(agentId)?.transcript) {
        const legacy = path.join(path.dirname(session.file), `agent-${agentId}.jsonl`);
        if (regular(legacy)) readChild(legacy, session.id);
      }
      // An independent desktop task is followed only when an explicit session
      // ID maps to an ordinary local Claude transcript in the known store.
      const linked = string(data.cliSessionId) || string(data.sessionId);
      if (call.block.name === 'mcp__ccd_session__spawn_task' && safeId(linked)) {
        const linkedFile = claudeFileById(linked);
        const snap = linkedFile && snapshot(linkedFile);
        if (snap) {
          const id = path.basename(linkedFile, '.jsonl'), node = ensure(id, doc.ownerId);
          node.kind = 'independent-session';
          byTool.set(block.tool_use_id, node);
          addDocument(linkedFile, snap.records, id, false, snap);
          indexScope(linkedFile, id);
        }
      }
    }
  }
  // A duplicate file is evidence of this owner's history, not a second
  // authority for its current branch. Discovery can change the selected
  // primary, so reconcile only after every linked scope has been captured.
  for (const doc of documents) {
    const primary = nodes.get(doc.ownerId)?.transcript?.file;
    if (primary && doc.file !== primary) doc.active.clear();
  }
  calls.clear();
  for (const doc of documents) for (const [i, rec] of doc.records.entries()) for (const block of blocks(rec)) {
    if (block.type !== 'tool_use' || !string(block.id)) continue;
    const previous = calls.get(block.id), primary = nodes.get(doc.ownerId)?.transcript?.file;
    if (previous?.doc.ownerId === doc.ownerId && previous.doc.file === primary && doc.file !== primary) continue;
    calls.set(block.id, { block, input: toolInput(rec, block), rec, index: i, doc });
  }
  for (const doc of documents) for (const rec of doc.records) for (const block of blocks(rec)) {
    if (block.type !== 'tool_result') continue;
    const call = calls.get(block.tool_use_id);
    if (!call || !spawnNames.has(call.block.name)) continue;
    const data = resultData(rec, block);
    const id = agentIdFor(rec, block);
    if (safeId(id)) byTool.set(block.tool_use_id, ensure(id, call.doc.ownerId));
    else if (call.block.name === 'mcp__ccd_session__spawn_task') {
      const taskId = string(data.taskId) || string(data.task_id) || text(block.content).match(/task_id:\s*(task_[A-Za-z0-9_-]+)/)?.[1];
      if (safeId(taskId) && !byTool.has(block.tool_use_id)) {
        const node = ensure(taskId, call.doc.ownerId);
        node.kind = 'queued-desktop-task';
        byTool.set(block.tool_use_id, node);
      }
    }
  }

  for (const [toolId, call] of calls) {
    if (!spawnNames.has(call.block.name)) continue;
    const { doc, rec, index, input } = call;
    const resume = safeId(input.resume) ? input.resume : null;
    const node = byTool.get(toolId) || (resume ? ensure(resume, doc.ownerId) : ensure(`dispatch:${doc.ownerId}:${toolId}`, doc.ownerId));
    byTool.set(toolId, node);
    if (!resume) {
      if (safeId(node.metadata?.parentAgentId) && node.metadata.parentAgentId !== doc.ownerId) {
        warn(node, `Recorded metadata parent ${node.metadata.parentAgentId} conflicts with dispatch owner ${doc.ownerId}; verify nesting manually.`);
      } else node.parentId = doc.ownerId;
    }
    node.name ||= string(input.description) || string(input.title) || string(input.subject);
    node.role ||= string(input.subagent_type);
    node.model ||= string(input.model);
    node.cwd ||= string(input.cwd) || string(rec.cwd);
    relation(node, doc.active.has(rec), nodes.get(doc.ownerId));
    assignment(node, input.prompt, resume ? 'resume' : 'dispatch', rec, doc.file, index, doc.active, input, toolId);
    event(node, resume ? 'resume_requested' : 'dispatch_requested', rec, doc.file, index, doc.active,
      { toolId, input, tool: call.block.name });
  }

  const messageTargets = new Map(), outgoingMessages = new Set();
  for (const doc of documents) for (const rec of doc.records) for (const block of blocks(rec)) {
    const call = calls.get(block.tool_use_id);
    if (block.type !== 'tool_result' || call?.block.name !== 'SendMessage') continue;
    const data = resultData(rec, block), id = string(data.resumedAgentId) || string(data.pin?.id);
    if (safeId(id)) messageTargets.set(block.tool_use_id, id);
    else if (call.doc.child && (string(call.input.to) || string(call.input.recipient)) === 'main' &&
      !nodes.has('main') && ![...nodes.values()].some(node => node.name === 'main') &&
      !block.is_error && data.success === true && data.message === "Message queued for the main conversation's next turn.") {
      // This native acknowledgement proves conversation routing. The alias by
      // itself is insufficient, and an explicitly identified agent wins.
      outgoingMessages.add(block.tool_use_id);
    }
  }
  // A later explicit recipient result overrides an earlier conversation-level
  // acknowledgement for the same request, regardless of file traversal order.
  for (const toolId of messageTargets.keys()) outgoingMessages.delete(toolId);
  for (const doc of documents) {
    const owner = nodes.get(doc.ownerId), childCalls = new Map();
    let childInputs = 0, firstChildInput = null, workStarted = false;
    for (const [i, rec] of doc.records.entries()) {
      if (rec.type === 'assistant' || blocks(rec).some(block => block.type === 'tool_result')) workStarted = true;
      for (const block of blocks(rec)) {
        if (block.type === 'tool_use') {
          childCalls.set(block.id, { block, rec, index: i });
          const input = toolInput(rec, block);
          if (block.name === 'SendMessage') {
            if (owner && outgoingMessages.has(block.id)) {
              event(owner, 'outgoing_message', rec, doc.file, i, doc.active, { input, toolId: block.id,
                text: string(input.message) || string(input.content), recipient: 'main', destination: 'main-conversation' });
              continue;
            }
            const recipient = messageTargets.get(block.id) || string(input.to) || string(input.recipient);
            let node = recipient && nodes.get(recipient);
            if (!node && recipient) node = [...nodes.values()].find(n => n.name === recipient);
            if (!node && recipient) {
              node = messageTargets.has(block.id) ? ensure(recipient, doc.ownerId) : ensure(`message:${doc.ownerId}:${block.id}`, doc.ownerId);
              if (!messageTargets.has(block.id)) warn(node, `The follow-up recipient ${recipient} could not be resolved to a recorded agent ID.`);
            }
            if (node) {
              relation(node, doc.active.has(rec), owner);
              assignment(node, string(input.message) || string(input.content), 'followup', rec, doc.file, i, doc.active, input, block.id);
              event(node, 'message_requested', rec, doc.file, i, doc.active, { input, toolId: block.id });
            }
          } else if (owner && block.name === 'SubagentHandback') {
            event(owner, 'handback_report', rec, doc.file, i, doc.active, { text: text(input.message), input, toolId: block.id });
          }
          continue;
        }
        if (block.type !== 'tool_result') continue;
        const data = resultData(rec, block), call = calls.get(block.tool_use_id), node = byTool.get(block.tool_use_id);
        if (node && call && spawnNames.has(call.block.name)) {
          const item = event(node, 'dispatch_result', rec, doc.file, i, doc.active,
            { text: text(block.content), result: rec.toolUseResult ?? data, isError: block.is_error === true, toolId: block.tool_use_id });
          assignment(node, data.prompt, 'recorded_prompt', rec, doc.file, i, doc.active);
          node.model ||= string(data.resolvedModel);
          if (recordRun(node, call, item)) observed(node, block.is_error ? 'failed' : statusFor(data.status), item);
          else item.supersededRun = true;
          if (data.handbackReport !== undefined) event(node, 'handback_report', rec, doc.file, i, doc.active, { result: data.handbackReport });
        }
        if (data.taskType === 'local_workflow' && safeId(data.runId)) {
          const launch = calls.get(block.tool_use_id);
          for (const agent of workflowNodes.get(data.runId) || []) {
            relation(agent, launch ? launch.doc.active.has(launch.rec) : doc.active.has(rec), owner);
            event(agent, 'workflow_launch', rec, doc.file, i, doc.active, { result: data, toolId: block.tool_use_id });
          }
          if (!workflowNodes.has(data.runId)) warnings.push(`Workflow ${data.runId} was referenced but its local child store is missing.`);
        }
        if (call?.block.name === 'ListAgents' && string(data.listing)) {
          for (const line of data.listing.split('\n')) {
            const row = line.match(/^\s*(a[0-9a-f]{16})\s*·\s*([^·]+)\s*·\s*(running|completed|failed|stopped|interrupted|closed|unknown)\s*·/);
            if (!row) continue;
            const target = ensure(row[1], doc.ownerId);
            target.name ||= row[2].trim();
            if (target.relation === 'unlinked') relation(target, doc.active.has(rec), owner);
            observed(target, statusFor(row[3]), event(target, 'agent_listing', rec, doc.file, i, doc.active, { text: line, status: row[3] }));
          }
        }
        if (call?.block.name === 'SendMessage') {
          if (owner && outgoingMessages.has(block.tool_use_id)) {
            event(owner, 'outgoing_message_result', rec, doc.file, i, doc.active, { result: rec.toolUseResult ?? data,
              text: text(block.content), toolId: block.tool_use_id, recipient: 'main', destination: 'main-conversation' });
            continue;
          }
          const recipient = messageTargets.get(block.tool_use_id) || string(data.resumedAgentId) || string(data.pin?.id);
          if (safeId(recipient)) {
            const target = ensure(recipient, doc.ownerId);
            const item = event(target, 'message_result', rec, doc.file, i, doc.active, { result: rec.toolUseResult ?? data, text: text(block.content) });
            if (data.success === true && data.resumedAgentId && recordRun(target, call, item)) observed(target, 'running', item);
            // Name/pin recipients can be resolved only after the tool responds.
            if (!(target.assignments.some(a => a.source?.uuid === call.rec.uuid && a.kind === 'followup'))) {
              assignment(target, string(call.input.message) || string(call.input.content), 'followup', call.rec,
                call.doc.file, call.index, call.doc.active, call.input, call.block.id);
              relation(target, call.doc.active.has(call.rec), nodes.get(call.doc.ownerId));
            }
          }
        }
        if (call?.block.name === 'TaskStop') {
          const targetId = string(call.input.task_id) || string(data.task_id);
          const target = nodes.get(targetId);
          if (target) {
            const item = event(target, 'stop_result', rec, doc.file, i, doc.active, { result: rec.toolUseResult ?? data, text: text(block.content), isError: !!block.is_error });
            if (!block.is_error) observed(target, 'interrupted', item);
          }
        }
        if (call?.block.name === 'mcp__ccd_session__dismiss_task') {
          const target = nodes.get(call.input.task_id);
          if (target) {
            const item = event(target, 'dismiss_result', rec, doc.file, i, doc.active, { text: text(block.content), result: rec.toolUseResult ?? data });
            if (!block.is_error) observed(target, 'closed', item);
          }
        }
        const ending = childCalls.get(block.tool_use_id);
        if (owner && rec.toolEndsTurn === true && !block.is_error && ['SubagentHandback', 'StructuredOutput'].includes(ending?.block.name)) {
          observed(owner, 'completed', event(owner, 'report_accepted', rec, doc.file, i, doc.active, {
            toolId: block.tool_use_id, tool: ending.block.name, text: text(block.content),
            invocation: { ts: ending.rec.timestamp || null, source: sourceAt(ending.rec, doc.file, ending.index, doc.active) } }));
        }
      }
      const attachment = rec.type === 'attachment' ? rec.attachment : null;
      if (owner && attachment?.type === 'structured_output') event(owner, 'structured_report', rec, doc.file, i, doc.active, { result: attachment.data, toolId: attachment.toolUseID });
      if (owner && attachment?.type === 'queued_command' && attachment.prompt) {
        const prompt = String(attachment.prompt);
        if (attachment.origin?.kind === 'task-notification' || prompt.trimStart().startsWith('<task-notification')) {
          event(owner, 'queued_task_notification', rec, doc.file, i, doc.active, { text: prompt,
            origin: attachment.origin, result: attachment });
          const tag = name => prompt.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
          const toolId = tag('tool-use-id'), target = nodes.get(tag('task-id')) || byTool.get(toolId);
          if (target) promoteLifecycle(target, statusFor(tag('status')), event(target, 'task_notification', rec,
            doc.file, i, doc.active, { text: prompt, status: tag('status'), origin: attachment.origin }), toolId);
        } else assignment(owner, prompt, 'queued_followup', rec, doc.file, i, doc.active);
      }
      if (attachment?.type === 'task_status' && attachment.taskType === 'local_agent' && safeId(attachment.taskId)) {
        const target = ensure(attachment.taskId, doc.ownerId);
        if (target.relation === 'unlinked') relation(target, doc.active.has(rec), owner);
        promoteLifecycle(target, statusFor(attachment.status), event(target, 'task_status', rec, doc.file, i, doc.active,
          { status: attachment.status, result: attachment }), string(attachment.toolUseId) || string(attachment.toolUseID));
      }
      const content = text(rec.message?.content);
      if (rec.type === 'user' && content.trimStart().startsWith('<task-notification')) {
        const tag = name => content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
        const taskId = tag('task-id'), toolId = tag('tool-use-id');
        const target = nodes.get(taskId) || byTool.get(toolId);
        if (target) promoteLifecycle(target, statusFor(tag('status')), event(target, 'task_notification', rec, doc.file, i, doc.active, { text: content, status: tag('status') }), toolId);
      }
      if (owner && rec.type === 'user' && !rec.isMeta && !rec.isCompactSummary && !blocks(rec).some(b => b.type === 'tool_result') && content && !content.trimStart().startsWith('<task-notification')) {
        // This native notice ends the child's current request. Quoted notices,
        // surrounding instructions and mixed content remain ordinary inputs.
        const nativeInterruption = content.trim() === '[Request interrupted by user]' &&
          (typeof rec.message?.content === 'string' || (rec.message?.content?.length === 1 && blocks(rec)[0]?.type === 'text'));
        if (nativeInterruption) {
          observed(owner, 'interrupted', event(owner, 'child_interrupted', rec, doc.file, i, doc.active, { text: content }));
          continue;
        }
        const ordinal = ordinals.get(rec) || i + 1;
        // The native workflow harness emits one initial assignment as two
        // adjacent messages. The same prompt ID survives serialization timing
        // drift; older records without IDs use the equal-timestamp fallback.
        const samePrompt = string(rec.promptId) && rec.promptId === firstChildInput?.promptId;
        const legacyPair = !string(rec.promptId) && !string(firstChildInput?.promptId) &&
          string(rec.timestamp) && rec.timestamp === firstChildInput?.ts;
        const harnessPair = owner.kind === 'workflow-agent' && !workStarted && childInputs === 1 &&
          (samePrompt || legacyPair) && ordinal === firstChildInput.ordinal + 1 &&
          rec.parentUuid === firstChildInput.uuid && firstChildInput.text.trimStart().startsWith('[Workflow harness — user request]') &&
          content.trimStart().startsWith('[Workflow harness — computed task]');
        assignment(owner, content, !childInputs || harnessPair ? 'initial_child_input' : 'child_input', rec, doc.file, i, doc.active);
        if (!childInputs) firstChildInput = { ts: rec.timestamp, uuid: rec.uuid, promptId: rec.promptId, text: content, ordinal };
        childInputs++;
      }
      if (owner && rec.type === 'system' && rec.subtype === 'api_error') event(owner, 'api_error', rec, doc.file, i, doc.active, { error: rec.error, text: rec.content });
    }
  }

  // Metadata establishes nesting, but not whether the parent's assignment is
  // still on the active branch. Resolve that only after every dispatch is read.
  for (const node of [...nodes.values()]) {
    if (safeId(node.metadata?.parentAgentId) && node.parentId !== session.id && !nodes.has(node.parentId)) {
      ensure(node.parentId);
      warn(node, 'The recorded parent-agent transcript is missing; nesting is retained from metadata.');
    }
  }
  // Directory order is unrelated to nesting. Resolve dispatch relationships
  // only after every owner's branch and workflow launch have been collected.
  for (const node of nodes.values()) node.relation = 'unlinked';
  const rank = { unlinked: 0, historical: 1, confirmed: 2 };
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false;
    for (const node of nodes.values()) {
      let resolved = node.relation;
      for (const fact of relationFacts.get(node.id) || []) {
        const owner = nodes.get(fact.ownerId);
        const value = fact.active ? (owner?.relation || 'confirmed') : 'historical';
        if (rank[value] > rank[resolved]) resolved = value;
      }
      if (!relationFacts.has(node.id) && safeId(node.metadata?.parentAgentId)) {
        const inherited = nodes.get(node.parentId)?.relation || 'unlinked';
        if (rank[inherited] > rank[resolved]) resolved = inherited;
      }
      if (resolved !== node.relation) { node.relation = resolved; changed = true; }
    }
    if (!changed) break;
  }
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    // A successful old run is not evidence that a later assignment is done.
    // Requests remain pending until an explicit result covers that request or
    // the child's own active transcript reports acceptance after its new input.
    const later = (a, b) => {
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts > b.ts;
      if (a.source.file === b.source.file) return a.source.record > b.source.record;
      return true;
    };
    const originalInputs = node.assignments.filter(a => a.kind === 'initial_child_input' &&
      !a.source.currentBranch && a.source.file !== node.transcript?.file);
    const distinctInitials = node.assignments.filter(a => a.kind === 'initial_child_input' && a.source.currentBranch &&
      originalInputs.some(original => {
        const copied = (a.source.uuid && a.source.uuid === original.source.uuid) ||
          (a.text === original.text && a.ts === original.ts);
        return !copied && (!a.ts || !original.ts || a.ts > original.ts);
      }));
    const changes = [...node.assignments.filter(a => a.source.currentBranch &&
      ['resume', 'followup', 'queued_followup', 'child_input'].includes(a.kind)), ...distinctInitials];
    const latest = changes.reduce((last, a) => !last || later(a, last) ? a : last, null);
    const latestRequest = changes.filter(a => a.requestToolId).reduce((last, a) => !last || later(a, last) ? a : last, null);
    const deliveredInputs = node.assignments.filter(a => a.source.currentBranch && a.source.file === node.transcript?.file &&
      ['initial_child_input', 'child_input', 'queued_followup'].includes(a.kind));
    const atOrAfter = (a, b) => {
      if (!a || !b) return false;
      if (a.source.file === b.source.file) return a.source.record >= b.source.record;
      const next = Date.parse(a.ts), previous = Date.parse(b.ts);
      // Separate files have no shared record order. Equal or missing times do
      // not establish that a parent request reached the child's current input.
      return Number.isFinite(next) && Number.isFinite(previous) && next > previous;
    };
    const inputBefore = evidence => deliveredInputs.filter(a => a.source.record < evidence.source.record).at(-1);
    if (latest) {
      const valid = (lifecycleCandidates.get(node.id) || []).filter(({ evidence }) => {
        if (evidence.source.currentBranch === false || evidence.supersededRun || evidence.ambiguousRun) return false;
        const after = (!latest.ts || !evidence.ts || evidence.ts >= latest.ts) &&
          (evidence.source.file !== latest.source.file || evidence.source.record >= latest.source.record);
        // Acceptance can arrive after a parent correction even though the
        // report was invoked for the old input. Both invocation and delivered
        // child input must cover the current request; result time alone cannot.
        const childReport = evidence.type === 'report_accepted' && evidence.source.file === node.transcript?.file;
        const directChildReport = childReport && evidence.invocation?.source.currentBranch && atOrAfter(evidence.invocation, latest) &&
          (!latestRequest || atOrAfter(inputBefore(evidence.invocation), latestRequest));
        const directChildInterruption = evidence.type === 'child_interrupted' && evidence.source.file === node.transcript?.file &&
          (!latestRequest || atOrAfter(inputBefore(evidence), latestRequest));
        if (after && childReport && !directChildReport) warn(node,
          'A child report acceptance cannot settle the newer assignment: its invocation or delivered input cannot be correlated with the latest request.');
        if (after && evidence.type === 'child_interrupted' && !directChildInterruption) warn(node,
          'A child interruption has no delivered input for the newer parent request; it cannot establish that the latest assignment ended.');
        const matchingResult = latestRequest && evidence.runToolId === latestRequest.requestToolId;
        const currentObservation = ['agent_listing', 'stop_result', 'dismiss_result'].includes(evidence.type);
        return after && (directChildReport || directChildInterruption || matchingResult || currentObservation);
      });
      const chosen = valid.reduce((last, candidate) => !last || later(candidate.evidence, last.evidence) ? candidate : last, null);
      const ambiguous = node.events.filter(e => e.source.currentBranch && e.ambiguousRun)
        .reduce((last, e) => !last || later(e, last) ? e : last, null);
      // An uncorrelated terminal notice invalidates an older running
      // observation. A causally valid terminal proof from the current run still
      // establishes its outcome even when an unrelated notice arrives later.
      if (chosen?.status === 'running' && ambiguous && later(ambiguous, chosen.evidence)) {
        node.status = 'unknown';
        node.statusEvidence = ambiguous;
      } else if (chosen) {
        node.status = chosen.status;
        node.statusEvidence = chosen.evidence;
      } else {
        node.status = 'unknown';
        node.statusEvidence = { type: 'assignment_pending', ts: latest.ts, source: latest.source,
          requestToolId: latestRequest?.requestToolId || null };
        warn(node, 'A newer assignment has no causally matching lifecycle result; an earlier completion does not establish that this work ended.');
      }
    } else if (node.statusEvidence?.type === 'child_interrupted') {
      // A native interruption ends one child request. An exact-ID journal
      // outcome closes the workflow invocation, which can recover and report
      // afterward. Untimestamped outcomes are not ordered by traversal time.
      const journal = (lifecycleCandidates.get(node.id) || []).filter(({ evidence }) =>
        evidence.source.provenance === 'workflow-journal' &&
        evidence.source.file === path.join(path.dirname(node.transcript.file), 'journal.jsonl'));
      const outcome = journal.at(-1);
      if (outcome && ['completed', 'failed'].includes(outcome.status)) {
        const repeated = journal.filter(({ evidence }) => evidence.type === 'workflow_started').length > 1 ||
          new Set(journal.map(({ evidence }) => evidence.key).filter(string)).size > 1;
        if (repeated) {
          node.status = 'unknown';
          warn(node, 'A child interruption and multiple untimestamped workflow invocations cannot be correlated; verify which assignment ended.');
        } else {
          node.status = outcome.status;
          node.statusEvidence = outcome.evidence;
        }
      }
    }
    if (node.relation === 'unlinked') warn(node, 'The child belongs to this local session store, but no current-branch dispatch link was recovered. Check relevance before restarting it.');
    if (!node.transcript) warn(node, `No local transcript was recovered for ${node.id}; assignments and recorded results are retained.`);
    if (node.kind === 'queued-desktop-task') warn(node, 'This desktop task was queued without a recorded local session/transcript link; its live execution state is unknown.');
    if (node.status === 'unknown') warn(node, 'No explicit lifecycle result was recovered; a reply alone does not establish completion.');
    // A malformed metadata cycle must not become a recursive recovery plan.
    const seen = new Set([node.id]);
    for (let ancestor = parent; ancestor; ancestor = nodes.get(ancestor.parentId)) {
      if (seen.has(ancestor.id)) { warn(node, 'A cycle exists in recorded parent-agent links; verify nesting manually.'); break; }
      seen.add(ancestor.id);
    }
  }
  return { agents: [...nodes.values()], warnings };
}
