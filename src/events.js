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
const RECENT_CACHE_SIZE = 500;                  // in-memory recent for instant dashboard reads

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

// ─── Fast path: get recent events from in-memory cache ───────
// Used by dashboard polling. Auto-hydrates cache on first call after boot.
let cacheHydrated = false;
async function hydrateCache() {
  const all = await readAllEvents();
  recentCache.length = 0;
  for (const e of all.slice(0, RECENT_CACHE_SIZE)) recentCache.push(e);
  cacheHydrated = true;
}
export async function getRecent({ clientSlug, status, kind } = {}) {
  if (!cacheHydrated) await hydrateCache();
  let out = recentCache;
  if (clientSlug) out = out.filter(e => e.clientSlug === clientSlug);
  if (status)     out = out.filter(e => (e.status || 'ok') === status);
  if (kind && kind !== 'all') out = out.filter(e => (e.kind || '').toLowerCase() === kind);
  return out.slice(0, 200);
}

// ─── CSV export ──────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
export async function exportCsv({ clientSlug } = {}) {
  const { rows } = await queryEvents({ clientSlug, limit: 1_000_000, offset: 0 });
  const headers = [
    'timestamp', 'clientSlug', 'clientName', 'kind', 'trigger',
    'email', 'name', 'webinarName', 'webinarId',
    'status', 'attempts', 'message',
  ];
  const lines = [headers.join(',')];
  for (const e of rows) {
    lines.push(headers.map(h => csvEscape(e[h])).join(','));
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
