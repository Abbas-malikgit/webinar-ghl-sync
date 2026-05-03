// ═══════════════════════════════════════════════════════════════
// Durable webhook queue — jobs persist on disk (queue.jsonl on the
// Railway volume) so nothing is lost across restarts.
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

let queue = [];
const inFlightByClient = {};
const inFlightIds = new Set();
let loopTimer = null;
let saveInFlight = false;
let savePending = false;

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

// Flatten the pipeline's apiEnrichment into the dotted-name fields
// the CSV exporter reads (e.apiAttendedLive, e.apiTimeWatchedMins, ...).
function flattenApiFields(pipeline) {
  const reg = pipeline?.apiEnrichment;
  if (!reg) return {};
  return {
    apiPlatform:         reg.platform,
    apiAttendedLive:     reg.attendedLive === 1 ? 'Yes' : reg.attendedLive === 2 ? 'No' : '',
    apiTimeWatchedMins:  reg.timeWatchedMins ?? '',
    apiAttendedReplay:   reg.attendedReplay === 1 ? 'Yes' : '',
    apiTimeReplayMins:   reg.timeReplayMins ?? '',
    apiDateLive:         reg.dateLive || '',
    apiDateReplay:       reg.dateReplay || '',
    apiEnteredLive:      reg.enteredLive || '',
    apiSignupDate:       reg.registeredAt || '',
    apiUtmSource:        reg.utmSource || '',
    apiUtmMedium:        reg.utmMedium || '',
    apiUtmCampaign:      reg.utmCampaign || '',
  };
}

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

export async function retryEvent(eventId) {
  const all = await events.readAllEvents();
  const evt = all.find(e => e.id === eventId);
  if (!evt) return { ok: false, error: 'event not found' };
  if (evt.status !== 'error') return { ok: false, error: 'only failed events can be retried' };

  const client = store.getClient(evt.clientSlug);
  if (!client) return { ok: false, error: 'client no longer exists' };

  if (queue.some(j => j.id === evt.id)) {
    return { ok: false, error: 'retry already in progress' };
  }

  const priorAttempts = evt.attempts || 0;

  const job = {
    id:          evt.id,
    clientSlug:  evt.clientSlug,
    clientName:  evt.clientName,
    kind:        evt.kind,
    trigger:     evt.trigger,
    email:       evt.email,
    name:        evt.name,
    webinarName: evt.webinarName,
    webinarId:   evt.webinarId,
    payload:     evt.payload,
    attempts:    priorAttempts,
    maxAttempts: priorAttempts + MAX_ATTEMPTS,
    nextAttempt: Date.now(),
    enqueuedAt:  new Date().toISOString(),
    lastError:   null,
  };
  queue.push(job);

  await events.updateEvent(evt.id, {
    status:  'queued',
    message: `Manual retry requested (was failed after ${priorAttempts} attempts)`,
  });

  saveQueue();
  return { ok: true, jobId: job.id };
}

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

function pickReadyJob(now) {
  for (let i = 0; i < queue.length; i++) {
    const j = queue[i];
    if (inFlightIds.has(j.id)) continue;
    if (j.nextAttempt > now) continue;
    const used = inFlightByClient[j.clientSlug] || 0;
    if (used >= PER_CLIENT_CONCURRENCY) continue;
    return i;
  }
  return -1;
}

async function runJob(job) {
  const client = store.getClient(job.clientSlug);
  let pipeline = null;

  try {
    if (!client) throw new Error(`client "${job.clientSlug}" no longer exists`);

    switch (job.kind) {
      case 'registration': pipeline = await handleRegistration(client, job.payload); break;
      case 'attended':     pipeline = await handleAttendance(client, job.payload);   break;
      case 'no_show':      pipeline = await handleNoShow(client, job.payload);       break;
      case 'replay':       pipeline = await handleReplayWatched(client, job.payload); break;
      default: break;
    }

    queue = queue.filter(j => j.id !== job.id);
    saveQueue();
    await events.updateEvent(job.id, {
      status:   'ok',
      attempts: job.attempts + 1,
      message:  job.attempts > 0 ? `Succeeded on attempt ${job.attempts + 1}` : '',
      pipeline,
      ...flattenApiFields(pipeline),
    });
  } catch (err) {
    const attempts = job.attempts + 1;
    const errMsg = err?.message || String(err);
    console.error(`❌ [${job.clientSlug}] job ${job.id.slice(0,8)} attempt ${attempts} failed:`, errMsg);

    const cap = job.maxAttempts || MAX_ATTEMPTS;

    // Pipeline may be partial — capture what we have so the user can
    // see how far it got before failing.
    const partialPipeline = pipeline;

    if (attempts >= cap) {
      queue = queue.filter(j => j.id !== job.id);
      saveQueue();
      await events.updateEvent(job.id, {
        status:   'error',
        attempts,
        message:  `Failed after ${attempts} attempts. Last error: ${errMsg}`,
        pipeline: partialPipeline,
        ...flattenApiFields(partialPipeline),
      });
    } else {
      const burstAttempt = attempts - (cap - MAX_ATTEMPTS);
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
        pipeline: partialPipeline,
        ...flattenApiFields(partialPipeline),
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
    let launched = 0;
    while (launched < 50) {
      const idx = pickReadyJob(now);
      if (idx === -1) break;
      const job = queue[idx];
      inFlightIds.add(job.id);
      inFlightByClient[job.clientSlug] = (inFlightByClient[job.clientSlug] || 0) + 1;
      runJob(job);
      launched++;
    }
  } catch (e) {
    console.error('queue loop tick error:', e.message);
  }
}

export function startWorker() {
  if (loopTimer) return;
  queue = loadQueue();
  console.log(`🔧 queue: resumed ${queue.length} pending job(s) from disk`);
  loopTimer = setInterval(loopTick, LOOP_INTERVAL_MS);
}
