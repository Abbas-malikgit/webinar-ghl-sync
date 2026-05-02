// ═══════════════════════════════════════════════════════════════
// Persistent event log — append-only JSONL on the data volume.
// One line = one JSON event. Never overwrites, only appends + prunes.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomUUID } from 'crypto';
import { config } from './config.js';

const RETENTION_DAYS   = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;  // once per day
const RECENT_CACHE_SIZE = 5000;                 // in-memory recent for instant dashboard reads

const eventsPath = () => path.join(config.dataDir, 'events.jsonl');

// ─── In-memory recent cache ──────────────────────────────────
// Populated on boot by scanning the tail of events.jsonl, then
// updated live on every append. Keeps dashboard instant.
const recentCache = [];

function ensureFile() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(eventsPath())) fs.writeFileSync(eventsPath(), '', 'utf8');
}

// ─── Append one event ────────────────────────────────────────
export function appendEvent(evt) {
  ensureFile();
  const full = {
    id:        evt.id || randomUUID(),
    timestamp: evt.timestamp || new Date().toISOString(),
    ...evt,
  };
  try {
    fs.appendFileSync(eventsPath(), JSON.stringify(full) + '\n', 'utf8');
  } catch (e) {
    console.error('events.appendEvent failed:', e.message);
  }
  // Update in-memory cache (unshift = newest first)
  recentCache.unshift(full);
  if (recentCache.length > RECENT_CACHE_SIZE) recentCache.length = RECENT_CACHE_SIZE;
  return full;
}

// ─── Update an existing event in place (for retries) ─────────
// Rewrites the file with the updated event. Cheap at our scale
// (≤a few hundred MB). For higher scale we'd use a tombstone log.
//
// IMPORTANT: serialized via updateChain so concurrent updates don't
// race (read → modify → write is not atomic; without serialization
// two near-simultaneous updates can lose each other's changes).
let updateChain = Promise.resolve();
export function updateEvent(id, patch) {
  const run = async () => {
    ensureFile();
    const all = await readAllEvents();
    const idx = all.findIndex(e => e.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...patch };
    // readAllEvents returns newest-first; rewrite in chronological order
    const chronological = all.slice().reverse();
    const tmp = eventsPath() + '.tmp';
    fs.writeFileSync(tmp, chronological.map(e => JSON.stringify(e)).join('\n') + (chronological.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, eventsPath());
    // Refresh cache
    const cacheIdx = recentCache.findIndex(e => e.id === id);
    if (cacheIdx !== -1) recentCache[cacheIdx] = all[idx];
    return all[idx];
  };
  // Chain so only one updateEvent runs at a time
  const next = updateChain.then(run, run);
  updateChain = next.catch(() => {});  // swallow errors in the chain itself, caller sees them
  return next;
}

// ─── Read all events (streamed, newest-first) ────────────────
export async function readAllEvents() {
  ensureFile();
  return new Promise((resolve, reject) => {
    const events = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(eventsPath(), 'utf8'),
      crlfDelay: Infinity,
    });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { events.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    });
    rl.on('close', () => resolve(events.reverse()));   // newest first
    rl.on('error', reject);
  });
}

// ─── Query with filters, pagination ──────────────────────────
export async function queryEvents({
  clientSlug, status, kind, search, since, until, limit = 200, offset = 0,
} = {}) {
  const all = await readAllEvents();
  let out = all;
  if (clientSlug) out = out.filter(e => e.clientSlug === clientSlug);
  if (status)     out = out.filter(e => (e.status || 'ok') === status);
  if (kind && kind !== 'all') out = out.filter(e => (e.kind || '').toLowerCase() === kind);
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(e =>
      (e.email || '').toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q) ||
      (e.webinarName || '').toLowerCase().includes(q) ||
      (e.message || '').toLowerCase().includes(q)
    );
  }
  if (since) out = out.filter(e => e.timestamp >= since);
  if (until) out = out.filter(e => e.timestamp <= until);

  const total = out.length;
  const rows  = out.slice(offset, offset + limit);
  return { rows, total };
}

// ─── Tally counts across the full event log ──────────────────
// Used by dashboard stat cards (Registrations / Attended / Errors / etc.).
// Streams the full jsonl once and returns a complete tally — never sliced.
// If clientSlug is provided, counts only events for that client.
export async function countByKind({ clientSlug } = {}) {
  const tally = { registrations: 0, attended: 0, noShows: 0, replays: 0, unhandled: 0, errors: 0 };
  const all = await readAllEvents();
  for (const e of all) {
    if (clientSlug && e.clientSlug !== clientSlug) continue;
    if (e.status === 'error') tally.errors++;
    if (e.status === 'ok') {
      if (e.kind === 'registration') tally.registrations++;
      else if (e.kind === 'attended') tally.attended++;
      else if (e.kind === 'no_show')  tally.noShows++;
      else if (e.kind === 'replay')   tally.replays++;
    }
    if (e.kind === 'unhandled') tally.unhandled++;
  }
  return tally;
}

// ─── Fast path: get recent events from in-memory cache ───────
// Used by dashboard polling. Auto-hydrates cache on first call after boot.
let cacheHydrated = false;
async function hydrateCache() {
  const all = await readAllEvents();
  recentCache.length = 0;
  for (const e of all.slice(0, RECENT_CACHE_SIZE)) recentCache.push(e);
  cacheHydrated = true;
}
export async function getRecent({ clientSlug, status, kind, limit = 200 } = {}) {
  if (!cacheHydrated) await hydrateCache();
  let out = recentCache;
  if (clientSlug) out = out.filter(e => e.clientSlug === clientSlug);
  if (status)     out = out.filter(e => (e.status || 'ok') === status);
  if (kind && kind !== 'all') out = out.filter(e => (e.kind || '').toLowerCase() === kind);
  return out.slice(0, limit);
}

// ─── CSV export ──────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Pull a value from the raw webhook payload using a dotted path.
// Tries lead.* first, then top-level, then webinar.*.
function pullPayload(payload, path) {
  if (!payload) return '';
  // Direct path (e.g. "lead.first_name", "webinar.id")
  const parts = path.split('.');
  let cur = payload;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return '';
  }
  return cur ?? '';
}

export async function exportCsv({ clientSlug } = {}) {
  const { rows } = await queryEvents({ clientSlug, limit: 1_000_000, offset: 0 });

  // Column groups:
  //  1. Event metadata (when, what, status)
  //  2. Webhook lead data — every field WebinarJam sends
  //  3. Webhook webinar data
  //  4. API enrichment placeholders (filled when WebinarJam API key is set)
  const headers = [
    // Event metadata
    'timestamp', 'clientSlug', 'clientName', 'kind', 'trigger',
    'status', 'attempts', 'message',

    // Lead data (from webhook payload.lead.*)
    'first_name', 'last_name', 'email',
    'phone_country_code', 'phone_number',
    'ip_address', 'country', 'timezone', 'language',

    // Webinar data (from webhook payload.webinar.*)
    'webinar_id', 'webinar_name', 'webinar_type', 'webinar_url',
    'schedule_id', 'schedule_date', 'schedule_time',

    // Source / attribution (sometimes in payload, otherwise from API)
    'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',

    // API enrichment fields (empty until WebinarJam API key is added per-client)
    'api_attended_live', 'api_time_watched_mins',
    'api_attended_replay', 'api_time_replay_mins',
    'api_date_live', 'api_date_replay', 'api_entered_live', 'api_signup_date',
  ];

  const lines = [headers.join(',')];

  for (const e of rows) {
    const p = e.payload || {};
    const row = {
      // Event metadata
      timestamp:   e.timestamp,
      clientSlug:  e.clientSlug,
      clientName:  e.clientName,
      kind:        e.kind,
      trigger:     e.trigger,
      status:      e.status,
      attempts:    e.attempts,
      message:     e.message,

      // Lead data — try lead.* first, fall back to top-level
      first_name:         pullPayload(p, 'lead.first_name')         || pullPayload(p, 'first_name'),
      last_name:          pullPayload(p, 'lead.last_name')          || pullPayload(p, 'last_name'),
      email:              pullPayload(p, 'lead.email')              || pullPayload(p, 'email') || e.email,
      phone_country_code: pullPayload(p, 'lead.phone_country_code'),
      phone_number:       pullPayload(p, 'lead.phone_number')       || pullPayload(p, 'phone'),
      ip_address:         pullPayload(p, 'lead.ip_address')         || pullPayload(p, 'ip'),
      country:            pullPayload(p, 'lead.country'),
      timezone:           pullPayload(p, 'lead.timezone')           || pullPayload(p, 'lead.time_zone'),
      language:           pullPayload(p, 'lead.language'),

      // Webinar data
      webinar_id:    pullPayload(p, 'webinar.id')         || pullPayload(p, 'webinar_id') || e.webinarId,
      webinar_name:  pullPayload(p, 'webinar.name')       || pullPayload(p, 'webinar_name') || e.webinarName,
      webinar_type:  pullPayload(p, 'webinar.type'),
      webinar_url:   pullPayload(p, 'webinar.url')        || pullPayload(p, 'webinar.live_room_url'),
      schedule_id:   pullPayload(p, 'webinar.schedule_id')|| pullPayload(p, 'schedule_id'),
      schedule_date: pullPayload(p, 'webinar.date')       || pullPayload(p, 'webinar.schedule_date'),
      schedule_time: pullPayload(p, 'webinar.time')       || pullPayload(p, 'webinar.schedule_time'),

      // Source / attribution
      source:       pullPayload(p, 'source')       || 'WebinarJam',
      utm_source:   pullPayload(p, 'utm_source')   || pullPayload(p, 'lead.utm_source'),
      utm_medium:   pullPayload(p, 'utm_medium')   || pullPayload(p, 'lead.utm_medium'),
      utm_campaign: pullPayload(p, 'utm_campaign') || pullPayload(p, 'lead.utm_campaign'),
      utm_content:  pullPayload(p, 'utm_content')  || pullPayload(p, 'lead.utm_content'),
      utm_term:     pullPayload(p, 'utm_term')     || pullPayload(p, 'lead.utm_term'),

      // API enrichment — only present when api enrichment ran successfully
      api_attended_live:    e.apiAttendedLive,
      api_time_watched_mins: e.apiTimeWatchedMins,
      api_attended_replay:  e.apiAttendedReplay,
      api_time_replay_mins: e.apiTimeReplayMins,
      api_date_live:        e.apiDateLive,
      api_date_replay:      e.apiDateReplay,
      api_entered_live:     e.apiEnteredLive,
      api_signup_date:      e.apiSignupDate,
    };

    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }

  return lines.join('\n') + '\n';
}

// ─── Daily prune of events older than RETENTION_DAYS ─────────
export async function pruneOldEvents() {
  ensureFile();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const all = await readAllEvents();   // newest-first
  const kept = all.filter(e => e.timestamp >= cutoff);
  if (kept.length === all.length) {
    console.log(`🧹 prune: nothing to remove (${all.length} events, retention ${RETENTION_DAYS}d)`);
    return { removed: 0, kept: kept.length };
  }
  // Rewrite in chronological order (oldest first), preserving append semantics going forward
  const chronological = kept.slice().reverse();
  const tmp = eventsPath() + '.tmp';
  fs.writeFileSync(tmp, chronological.map(e => JSON.stringify(e)).join('\n') + (chronological.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, eventsPath());
  const removed = all.length - kept.length;
  console.log(`🧹 prune: removed ${removed} old events, kept ${kept.length}`);
  // Refresh cache
  recentCache.length = 0;
  for (const e of kept.slice(0, RECENT_CACHE_SIZE)) recentCache.push(e);
  return { removed, kept: kept.length };
}

// Start background prune timer (once per 24h)
let pruneTimer = null;
export function startPruneTimer() {
  if (pruneTimer) return;
  // Run once shortly after boot, then daily
  setTimeout(() => pruneOldEvents().catch(e => console.error('prune failed:', e.message)), 60 * 1000);
  pruneTimer = setInterval(
    () => pruneOldEvents().catch(e => console.error('prune failed:', e.message)),
    PRUNE_INTERVAL_MS
  );
}
