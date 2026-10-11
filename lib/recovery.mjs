import path from 'node:path';
import { assignmentReadability } from './assignment-input.mjs';

// This assesses the evidence available for reconstruction, not whether work
// should be restarted. Recorded lifecycle and current task relevance are
// independent: a stopped agent may have finished, and a historical one may not.
export function assessRecovery(agent, { files, workspace, parent, children, collectionWarnings = 0 }) {
  const inputs = (agent.assignments || []).map((assignment, i) => ({
    pointer: `/assignments/${i}`, kind: assignment.kind,
    readability: assignment.readability === 'opaque' ? 'opaque' : assignmentReadability(assignment.text),
    currentBranch: assignment.source?.currentBranch ?? null,
  }));
  const sessionInputs = (agent.session?.turns || []).flatMap((turn, i) =>
    typeof turn.user === 'string' && turn.user.trim()
      ? [{ pointer: `/session/turns/${i}/user`, readability: assignmentReadability(turn.user) }] : []);
  const checks = [];
  const allInputs = [...inputs, ...sessionInputs];
  const hasAssignment = allInputs.some(input => input.readability === 'readable');
  if (!hasAssignment) checks.push('missing-assignment');
  // Readable older work does not establish the scope of an opaque correction.
  if (allInputs.some(input => input.readability === 'opaque')) checks.push('opaque-assignment');
  if (!files.transcript) checks.push('missing-progress-transcript');
  if (!workspace?.cwd || !path.isAbsolute(workspace.cwd) || workspace.exists !== true) checks.push('workspace-unavailable');
  if (agent.relation !== 'confirmed') checks.push('verify-task-relevance');
  if (!['completed', 'failed', 'running', 'closed', 'interrupted'].includes(agent.status)) checks.push('unresolved-lifecycle');
  if (!parent?.data) checks.push('missing-parent-context');
  if (agent.pendingAssignmentEvidence || agent.statusEvidence?.type === 'assignment_pending' || agent.statusEvidence?.ambiguousRun) checks.push('unresolved-assignment');
  if (agent.warnings?.length || collectionWarnings) checks.push('inspect-evidence-warnings');
  if (['closed', 'interrupted'].includes(agent.status)) checks.push('check-results-before-restarting');
  const disposition = checks.length ? 'review-required'
    : agent.status === 'completed' ? 'reuse-results' : 'reconstruction-candidate';
  return {
    disposition, checks,
    // These are relative bundle files and JSON pointers into this agent's data
    // file. Source coordinates remain unchanged; manifest maps them to snapshots.
    context: files.context, data: files.data, transcript: files.transcript || null,
    inputs, sessionInputs, events: '/events', statusEvidence: agent.statusEvidence ? '/statusEvidence' : null,
    pendingAssignmentEvidence: agent.pendingAssignmentEvidence ? '/pendingAssignmentEvidence' : null,
    sourceContext: 'source-context.json', sourceLookup: 'manifest.json#/evidenceSources',
    parent, children,
    continuationVerified: false,
  };
}

export function summarizeRecovery(agents) {
  const recordedStatuses = {};
  for (const agent of agents) recordedStatuses[agent.status || 'unknown'] = (recordedStatuses[agent.status || 'unknown'] || 0) + 1;
  return {
    recordedStatuses,
    recordedNoncompleted: agents.filter(a => a.status !== 'completed').length,
    reviewRequired: agents.filter(a => a.recovery.disposition === 'review-required').length,
    reconstructionCandidates: agents.filter(a => a.recovery.disposition === 'reconstruction-candidate').length,
    reusableResults: agents.filter(a => a.recovery.disposition === 'reuse-results').length,
    contextsWithWarnings: agents.filter(a => a.warnings.length).length,
    missingTranscripts: agents.filter(a => !a.files.transcript).length,
  };
}
