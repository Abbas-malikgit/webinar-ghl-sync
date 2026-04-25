// ═══════════════════════════════════════════════════════════════
// Durable webhook queue — jobs persist on disk (queue.jsonl on the
// Railway volume) so nothing is lost across restarts.
//
// Strategy:
//   1. Webhook arrives → enqueue(job) appends to queue.jsonl → returns fast.
//   2. Worker loop drains the queue, respecting per-client concurrency.
//   3. Success → persist event with status=ok, remove job from queue.
//   4. Failure → bump attempts, schedule retry with exponential backoff.
//      After MAX_ATTEMPTS, mark event status=error (user can retry from UI).
//
// The queue.jsonl file is rewritten on each dequeue/update. For our scale
// (max a few thousand pending at once) this is trivial. We use atomic
// rename to avoid corruption on interrupted writes.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import * as store from './clients.js';
import * as events from './events.js';

import { handleRegistration } from './handlers/registration.js';
import { handleAttendance } from './handlers/attendance.js';
import { handleNoShow, handleReplayWatched } from './handlers/noShow.js';

// ─── Tuning ──────────────────────────────────────────────────
const MAX_ATTEMPTS            = 3;
const PER_CLIENT_CONCURRENCY  = 5;
const BACKOFF_MS              = [30_000, 120_000, 600_000];  // 30s, 2m, 10m
const LOOP_INTERVAL_MS        = 500;

const queuePath = () => path.join(config.dataDir, 'queue.jsonl');

// ─── Runtime state ───────────────────────────────────────────
let queue = [];                  // in-memory mirror of queue.jsonl
const inFlightByClient = {};     // { slug: count }
const inFlightIds = new Set();   // job ids currently being processed (prevents double-dispatch)
let loopTimer = null;
let saveInFlight = false;
let savePending = false;

// ─── Disk I/O ────────────────────────────────────────────────
function ensureFile() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(queuePath())) fs.writeFileSync(queuePath(), '', 'utf8');
}

function loadQueue() {
  ensureFile();
  const raw = fs.readFileSync(queuePath(), 'utf8');
  const jobs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { jobs.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return jobs;
}

// Coalesced save — we call saveQueue often; batch consecutive calls.
async function saveQueue() {
  if (saveInFlight) { savePending = true; return; }
  saveInFlight = true;
  try {
    ensureFile();
    const tmp = queuePath() + '.tmp';
    const payload = queue.map(j => JSON.stringify(j)).join('\n') + (queue.length ? '\n' : '');
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, queuePath());
  } catch (e) {
    console.error('queue.saveQueue failed:', e.message);
  } finally {
    saveInFlight = false;
    if (savePending) { savePending = false; setImmediate(saveQueue); }
  }
}

// ─── Public: enqueue a webhook ───────────────────────────────
export function enqueue({ client, payload, kind, trigger, email, name }) {
  const job = {
    id:         randomUUID(),
    clientSlug: client.slug,
    clientName: client.name,
    kind,
    trigger,
    email,
    name,
    webinarName: payload?.webinar?.name || null,
    webinarId:   payload?.webinar?.id   || null,
    payload,
    attempts:    0,
    nextAttempt: Date.now(),
    enqueuedAt:  new Date().toISOString(),
    lastError:   null,
  };
  queue.push(job);
  // Log as "queued" so it shows up immediately in dashboard history
  events.appendEvent({
    id: job.id,
    clientSlug: job.clientSlug,
    clientName: job.clientName,
    kind:       job.kind,
    trigger:    job.trigger,
    email:      job.email,
    name:       job.name,
    webinarName: job.webinarName,
    webinarId:   job.webinarId,
    status:     'queued',
    message:    '',
    attempts:   0,
    payload:    job.payload,
  });
  saveQueue();
  return job;
}

// ─── Public: retry a previously-failed event ─────────────────
// Reuses the SAME event id so the dashboard shows one row per
// registration. The attempts counter on that row reflects the
// total number of tries across all retry cycles.
export async function retryEvent(eventId) {
  const all = await events.readAllEvents();
  const evt = all.find(e => e.id === eventId);
  if (!evt) return { ok: false, error: 'event not found' };
  if (evt.status !== 'error') return { ok: false, error: 'only failed events can be retried' };

  const client = store.getClient(evt.clientSlug);
  if (!client) return { ok: false, error: 'client no longer exists' };

  // Guard against double-clicks: if there's already a job in the queue
  // with this id, the previous retry is still working — don't add another.
  if (queue.some(j => j.id === evt.id)) {
    return { ok: false, error: 'retry already in progress' };
  }

  const priorAttempts = evt.attempts || 0;

  // Same event id — reuses the existing dashboard row.
  // attempts continues counting from where the original failure left off
  // (so retries show "try 4", "try 5", etc., not resetting to "try 1").
  const job = {
    id:          evt.id,                              // ← same id, same row
    clientSlug:  evt.clientSlug,
    clientName:  evt.clientName,
    kind:        evt.kind,
    trigger:     evt.trigger,
    email:       evt.email,
    name:        evt.name,
    webinarName: evt.webinarName,
    webinarId:   evt.webinarId,
    payload:     evt.payload,
    attempts:    priorAttempts,                       // continue counting
    maxAttempts: priorAttempts + MAX_ATTEMPTS,        // allow another 3 tries per retry click
    nextAttempt: Date.now(),
    enqueuedAt:  new Date().toISOString(),
    lastError:   null,
  };
  queue.push(job);

  // Flip the existing row back to "queued" so dashboard reflects re-enqueue
  await events.updateEvent(evt.id, {
    status:  'queued',
    message: `Manual retry requested (was failed after ${priorAttempts} attempts)`,
  });

  saveQueue();
  return { ok: true, jobId: job.id };
}

// ─── Stats for dashboard ─────────────────────────────────────
export function queueDepth(clientSlug) {
  if (clientSlug) return queue.filter(j => j.clientSlug === clientSlug).length;
  return queue.length;
}

export function queueSummary() {
  const now = Date.now();
  const bySlug = {};
  let waiting = 0;
  let scheduled = 0;
  for (const j of queue) {
    if (!bySlug[j.clientSlug]) bySlug[j.clientSlug] = 0;
    bySlug[j.clientSlug]++;
    if (j.nextAttempt <= now) waiting++; else scheduled++;
  }
  return { total: queue.length, waiting, scheduled, bySlug, inFlight: { ...inFlightByClient } };
}

// ─── Worker loop ─────────────────────────────────────────────
function pickReadyJob(now) {
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    if (inFlightIds.has(j.id)) continue;         // already being processed
    if (j.nextAttempt > now) continue;
    const used = inFlightByClient[j.clientSlug] || 0;
    if (used >= PER_CLIENT_CONCURRENCY) continue;
    return i;
  }
  return -1;
}

async function runJob(job) {
  // NOTE: inFlightByClient and inFlightIds are incremented synchronously
  // in loopTick() before dispatch, not here. This prevents the same job
  // being picked up multiple times before its first await resolves.
  const client = store.getClient(job.clientSlug);
  try {
    if (!client) throw new Error(`client "${job.clientSlug}" no longer exists`);

    switch (job.kind) {
      case 'registration': await handleRegistration(client, job.payload); break;
      case 'attended':     await handleAttendance(client, job.payload);   break;
      case 'no_show':      await handleNoShow(client, job.payload);       break;
      case 'replay':       await handleReplayWatched(client, job.payload); break;
      default:
        // Unhandled triggers never enqueue, so this shouldn't happen.
        // Mark OK and move on if it does.
        break;
    }

    // Success — remove from queue, update event to status=ok
    queue = queue.filter(j => j.id !== job.id);
    saveQueue();
    await events.updateEvent(job.id, {
      status:   'ok',
      attempts: job.attempts + 1,
      message:  job.attempts > 0 ? `Succeeded on attempt ${job.attempts + 1}` : '',
    });
  } catch (err) {
    const attempts = job.attempts + 1;
    const errMsg = err?.message || String(err);
    console.error(`❌ [${job.clientSlug}] job ${job.id.slice(0,8)} attempt ${attempts} failed:`, errMsg);

    // Each retry click extends the cap by MAX_ATTEMPTS; first run uses MAX_ATTEMPTS itself.
    const cap = job.maxAttempts || MAX_ATTEMPTS;

    if (attempts >= cap) {
      // Give up — leave event in history with status=error
      queue = queue.filter(j => j.id !== job.id);
      saveQueue();
      await events.updateEvent(job.id, {
        status:   'error',
        attempts,
        message:  `Failed after ${attempts} attempts. Last error: ${errMsg}`,
      });
    } else {
      // Schedule retry with backoff. Use position within current burst, not absolute attempt number.
      const burstAttempt = attempts - (cap - MAX_ATTEMPTS);  // 1, 2, 3 within this batch
      const delay = BACKOFF_MS[Math.min(burstAttempt - 1, BACKOFF_MS.length - 1)];
      const j = queue.find(x => x.id === job.id);
      if (j) {
        j.attempts    = attempts;
        j.nextAttempt = Date.now() + delay;
        j.lastError   = errMsg;
      }
      saveQueue();
      await events.updateEvent(job.id, {
        status:   'retrying',
        attempts,
        message:  `Attempt ${attempts} failed: ${errMsg}. Next retry in ${Math.round(delay/1000)}s.`,
      });
    }
  } finally {
    inFlightByClient[job.clientSlug] = Math.max(0, (inFlightByClient[job.clientSlug] || 1) - 1);
    inFlightIds.delete(job.id);
  }
}

async function loopTick() {
  try {
    const now = Date.now();
    // Fire as many ready jobs as concurrency allows this tick
    let launched = 0;
    while (launched < 50) {   // safety cap per tick
      const idx = pickReadyJob(now);
      if (idx === -1) break;
      const job = queue[idx];
      // Synchronously mark in-flight BEFORE dispatching, so the next
      // iteration of pickReadyJob() sees this job as taken.
      inFlightIds.add(job.id);
      inFlightByClient[job.clientSlug] = (inFlightByClient[job.clientSlug] || 0) + 1;
      runJob(job);  // fire-and-forget
      launched++;
    }
  } catch (e) {
    console.error('queue loop tick error:', e.message);
  }
}

export function startWorker() {
  if (loopTimer) return;
  // Resume queue from disk on boot
  queue = loadQueue();
  console.log(`🔧 queue: resumed ${queue.length} pending job(s) from disk`);
  loopTimer = setInterval(loopTick, LOOP_INTERVAL_MS);
}
