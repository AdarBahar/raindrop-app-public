// The bulk jobs of all users, in memory. A server restart ends them. See src/bulk.js.
import { randomUUID } from 'node:crypto';
import { titleOf } from './util.js';

const KEEP_MS = 60 * 60 * 1000; // finished jobs stay visible for one hour

// A new running job. `extra` holds the fields of one kind of job.
export function newJob(userId, action, total, extra) {
  return {
    id: randomUUID(),
    userId,
    action,
    status: 'running',
    done: 0,
    unchanged: 0, // done, but already in the target state: no Raindrop call
    total,
    failed: [],
    warnings: [],
    changes: [], // the state before and after each change, for undo
    ...extra,
    cancelled: false,
    finishedAt: 0,
  };
}

// The end of a job that ran to its last step, or that stopped after a cancel.
export function finishJob(job) {
  job.status = job.cancelled ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
}

// The end of a job that stopped with an error.
export function failJob(job, err) {
  job.status = 'failed';
  job.error = err.message;
  job.finishedAt = Date.now();
}

export function fail(job, item, reason) {
  job.failed.push({ id: item._id, title: titleOf(item), reason });
  job.done += 1;
}

export function jobs(svc) {
  if (!svc.jobs) svc.jobs = new Map();
  return svc.jobs;
}

export function pruneJobs(svc) {
  const now = Date.now();
  for (const [id, job] of jobs(svc)) {
    if (job.finishedAt && now - job.finishedAt > KEEP_MS) jobs(svc).delete(id);
  }
}

// True while a job is still kept. A job that was deleted (for delete-my-data) must not write logs.
export function kept(svc, job) {
  return jobs(svc).get(job.id) === job;
}

// The job of one user. Another user's job is not found.
export function getJob(svc, userId, jobId) {
  const job = jobs(svc).get(jobId);
  return job && job.userId === userId ? job : null;
}

// Ask a running job to stop. Items already changed stay changed.
export function cancelJob(svc, userId, jobId) {
  const job = getJob(svc, userId, jobId);
  if (job && job.status === 'running') job.cancelled = true;
  return job;
}

// Remove every job of one user, for delete-my-data. Running jobs are cancelled, and their later steps
// see that they are no longer kept, so they write no change-log row.
export function forgetJobs(svc, userId) {
  for (const [id, job] of jobs(svc)) {
    if (job.userId !== userId) continue;
    job.cancelled = true;
    jobs(svc).delete(id);
  }
}

// True when the user has a suggest job that is still running and not cancelled.
export function runningSuggest(svc, userId) {
  for (const job of jobs(svc).values()) {
    if (job.userId === userId && job.action === 'suggest' && job.status === 'running' && !job.cancelled) return true;
  }
  return false;
}

// A job can be undone once, after it finishes, when it changed at least one bookmark.
// The changes that were not restored yet. A failed or cancelled undo leaves its unfinished changes here.
export function pendingOf(job) {
  return job.changes.filter((change) => !job.restored.has(change.id));
}

export function undoable(job) {
  return !job.isUndo && !job.undoing && (job.status === 'done' || job.status === 'cancelled') && pendingOf(job).length > 0;
}

// The part of a job that the browser sees.
export function jobView(job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    done: job.done,
    unchanged: job.unchanged ?? 0,
    total: job.total,
    failed: job.failed,
    warnings: job.warnings,
    undoable: undoable(job),
    error: job.error ?? null,
    suggestions: job.suggestions,
  };
}
