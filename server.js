import 'dotenv/config';
import express from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import { config } from './src/config.js';
import { basicAuth } from './src/middleware/auth.js';
import * as store from './src/clients.js';
import { getLocation, listWorkflows } from './src/ghl.js';

import { handleRegistration } from './src/handlers/registration.js';
import { handleAttendance } from './src/handlers/attendance.js';
import { handleNoShow, handleReplayWatched } from './src/handlers/noShow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── In-memory event log + stats (per-client) ─────────────────
const MAX_EVENTS_PER_CLIENT = 100;
const events     = [];   // global ring buffer, each event has .clientSlug
const statsBySlug = {};  // { slug: { registrations, attended, noShows, replays, unhandled, errors } }
const serverStart = Date.now();

function emptyStats() {
  return { registrations: 0, attended: 0, noShows: 0, replays: 0, unhandled: 0, errors: 0 };
}
function statsFor(slug) {
  if (!statsBySlug[slug]) statsBySlug[slug] = emptyStats();
  return statsBySlug[slug];
}
function logEvent(evt) {
  events.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...evt,
  });
  // Trim globally — keep most recent MAX * estimated-client-count, but cap absolute
  const absoluteCap = 1000;
  if (events.length > absoluteCap) events.length = absoluteCap;
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK — public, authed by client slug + token in URL
// ═══════════════════════════════════════════════════════════════
app.post('/webhook/:slug/:token', async (req, res) => {
  const { slug, token } = req.params;
  const client = store.getClientByToken(slug, token);
  if (!client) {
    console.warn(`❌ Webhook rejected — invalid slug/token: ${slug}/${token.slice(0,6)}…`);
    return res.status(404).send('Not found');
  }

  res.sendStatus(200);

  const payload = req.body;
  const receivedAt = new Date().toISOString();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📥 [${client.slug}] webhook at ${receivedAt}`);
  console.log('   Raw payload:', JSON.stringify(payload, null, 2));

  const rawTrigger = payload.trigger || payload.event || payload.type || '';
  const trigger = rawTrigger.toLowerCase();
  const email   = payload?.lead?.email || 'unknown';
  const name    = `${payload?.lead?.first_name || ''} ${payload?.lead?.last_name || ''}`.trim() || 'unknown';

  let kind = 'unknown';
  let status = 'ok';
  let message = '';
  const stats = statsFor(client.slug);

  try {
    switch (trigger) {
      case 'register': case 'registration': case 'registrant':
        kind = 'registration';
        await handleRegistration(client, payload);
        stats.registrations++;
        break;

      case 'attendlive': case 'attended': case 'attended_live': case 'attendedlive':
        kind = 'attended';
        await handleAttendance(client, payload);
        stats.attended++;
        break;

      case 'misswebinar': case 'misslive': case 'no_show': case 'noshow':
      case 'missed': case 'not_attended':
        kind = 'no_show';
        await handleNoShow(client, payload);
        stats.noShows++;
        break;

      case 'attendreplay': case 'replay': case 'attended_replay': case 'replay_watched':
        kind = 'replay';
        await handleReplayWatched(client, payload);
        stats.replays++;
        break;

      default:
        kind    = 'unhandled';
        status  = 'warn';
        message = `Unhandled trigger: "${rawTrigger}"`;
        stats.unhandled++;
        console.warn(`⚠️  ${message}`);
    }
  } catch (err) {
    status  = 'error';
    message = err.message || 'handler threw';
    stats.errors++;
    console.error('❌ Handler error:', err.message);
    console.error(err.stack);
  }

  logEvent({
    clientSlug: client.slug,
    clientName: client.name,
    kind,
    trigger: rawTrigger,
    email,
    name,
    webinarName: payload?.webinar?.name || null,
    webinarId:   payload?.webinar?.id || null,
    status,
    message,
    payload,
  });
});

// Public health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeMs: Date.now() - serverStart });
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD (protected)
// ═══════════════════════════════════════════════════════════════

// Protect everything below this line
app.use(basicAuth);

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── Status ─────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const clients = store.listClients();
  const overall = emptyStats();
  for (const c of clients) {
    const s = statsFor(c.slug);
    overall.registrations += s.registrations;
    overall.attended      += s.attended;
    overall.noShows       += s.noShows;
    overall.replays       += s.replays;
    overall.unhandled     += s.unhandled;
    overall.errors        += s.errors;
  }
  res.json({
    status:     'running',
    uptimeMs:   Date.now() - serverStart,
    startedAt:  new Date(serverStart).toISOString(),
    clientCount: clients.length,
    stats:      overall,
    eventCount: events.length,
  });
});

// ─── Clients ────────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  const clients = store.listClients().map(c => ({
    ...store.redactClient(c),
    stats: statsFor(c.slug),
  }));
  res.json(clients);
});

app.get('/api/clients/:slug', (req, res) => {
  const c = store.getClient(req.params.slug);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ...store.redactClient(c), stats: statsFor(c.slug) });
});

app.post('/api/clients', (req, res) => {
  try {
    const {
      name, slug, ghlApiKey, ghlLocationId,
      workflowRegistration, workflowAttended, workflowNoShow, workflowReplay,
      webinarJamApiKey,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!ghlApiKey || !ghlLocationId) return res.status(400).json({ error: 'ghlApiKey and ghlLocationId are required' });

    const client = store.createClient({
      name, slug, ghlApiKey, ghlLocationId,
      workflowRegistration, workflowAttended, workflowNoShow, workflowReplay,
      webinarJamApiKey,
    });
    res.json({ ...store.redactClient(client), stats: emptyStats() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/clients/:slug', (req, res) => {
  const patch = { ...req.body };
  // If apiKey fields are masked (contain bullets), drop them to preserve existing
  if (patch.ghlApiKey && /•/.test(patch.ghlApiKey)) delete patch.ghlApiKey;
  if (patch.webinarJamApiKey && /•/.test(patch.webinarJamApiKey)) delete patch.webinarJamApiKey;
  // Normalize empty workflow strings to null
  for (const f of ['workflowRegistration', 'workflowAttended', 'workflowNoShow', 'workflowReplay']) {
    if (f in patch) patch[f] = patch[f] || null;
  }

  const updated = store.updateClient(req.params.slug, patch);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ ...store.redactClient(updated), stats: statsFor(updated.slug) });
});

app.delete('/api/clients/:slug', (req, res) => {
  const ok = store.deleteClient(req.params.slug);
  if (!ok) return res.status(404).json({ error: 'not found' });
  delete statsBySlug[req.params.slug];
  res.json({ ok: true });
});

app.post('/api/clients/:slug/rotate-token', (req, res) => {
  const updated = store.rotateToken(req.params.slug);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ webhookToken: updated.webhookToken });
});

// ─── GHL introspection (used by add-client wizard) ─────────────
app.post('/api/ghl/verify', async (req, res) => {
  const { apiKey, locationId } = req.body;
  if (!apiKey || !locationId) return res.status(400).json({ error: 'apiKey and locationId required' });

  try {
    const [location, workflows] = await Promise.all([
      getLocation(apiKey, locationId).catch(() => null),
      listWorkflows(apiKey, locationId),
    ]);

    res.json({
      location: location ? { id: location.id, name: location.name } : { id: locationId, name: null },
      workflows: workflows.map(w => ({
        id:     w.id,
        name:   w.name,
        status: w.status,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Events ─────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { clientSlug, filter } = req.query;

  let out = events;
  if (clientSlug) out = out.filter(e => e.clientSlug === clientSlug);
  if (filter && filter !== 'all') out = out.filter(e => (e.kind || '').toLowerCase() === filter);

  res.json(out.slice(0, limit));
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(config.port, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Webinar → GHL Sync (multi-tenant)`);
  console.log(`   Dashboard : http://localhost:${config.port}`);
  console.log(`   Data dir  : ${config.dataDir}`);
  console.log(`   Auth      : ${config.auth.user && config.auth.pass ? 'enabled' : '⚠️  OPEN (set DASHBOARD_USER/PASS)'}`);
  console.log(`   Clients   : ${store.listClients().length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
