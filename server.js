import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './src/config.js';
import { basicAuth } from './src/middleware/auth.js';
import * as store from './src/clients.js';
import * as events from './src/events.js';
import * as queue from './src/queue.js';
import { getLocation, listWorkflows } from './src/ghl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const serverStart = Date.now();

// ═══════════════════════════════════════════════════════════════
// WEBHOOK — public, authed by client slug + token in URL
// Enqueues the job and responds 200 in milliseconds. Worker drains
// the queue with retries, so WebinarJam never waits on GHL.
// ═══════════════════════════════════════════════════════════════
app.post('/webhook/:slug/:token', (req, res) => {
  const { slug, token } = req.params;
  const client = store.getClientByToken(slug, token);
  if (!client) {
    console.warn(`❌ Webhook rejected — invalid slug/token: ${slug}/${token.slice(0,6)}…`);
    return res.status(404).send('Not found');
  }

  // Respond immediately — this is the whole point of the queue.
  res.sendStatus(200);

  const payload = req.body;
  console.log(`📥 [${client.slug}] webhook received`);

  const rawTrigger = payload.trigger || payload.event || payload.type || '';
  const trigger = rawTrigger.toLowerCase();
  const email   = payload?.lead?.email || 'unknown';
  const name    = `${payload?.lead?.first_name || ''} ${payload?.lead?.last_name || ''}`.trim() || 'unknown';

  let kind = null;
  switch (trigger) {
    case 'register': case 'registration': case 'registrant':
      kind = 'registration'; break;
    case 'attendlive': case 'attended': case 'attended_live': case 'attendedlive':
      kind = 'attended'; break;
    case 'misswebinar': case 'misslive': case 'no_show': case 'noshow':
    case 'missed': case 'not_attended':
      kind = 'no_show'; break;
    case 'attendreplay': case 'replay': case 'attended_replay': case 'replay_watched':
      kind = 'replay'; break;
    default:
      // Unhandled — log to events with status=warn, don't enqueue
      events.appendEvent({
        clientSlug: client.slug,
        clientName: client.name,
        kind:       'unhandled',
        trigger:    rawTrigger,
        email,
        name,
        webinarName: payload?.webinar?.name || null,
        webinarId:   payload?.webinar?.id || null,
        status:     'warn',
        message:    `Unhandled trigger: "${rawTrigger}"`,
        attempts:   0,
        payload,
      });
      console.warn(`⚠️  [${client.slug}] unhandled trigger "${rawTrigger}"`);
      return;
  }

  queue.enqueue({ client, payload, kind, trigger: rawTrigger, email, name });
});

// Public health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeMs: Date.now() - serverStart });
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD (protected)
// ═══════════════════════════════════════════════════════════════
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ─── Status ─────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const clients = store.listClients();
  // Counters are maintained live and don't depend on the 200-row cache, so this
  // is accurate across all 30 days of history.
  const overall = await events.getStats();
  res.json({
    status:      'running',
    uptimeMs:    Date.now() - serverStart,
    startedAt:   new Date(serverStart).toISOString(),
    clientCount: clients.length,
    stats:       overall,
    queue:       queue.queueSummary(),
  });
});

// ─── Clients ────────────────────────────────────────────────────
async function statsForSlug(slug) {
  return await events.getStats(slug);
}

app.get('/api/clients', async (req, res) => {
  const clients = store.listClients();
  const out = [];
  for (const c of clients) {
    out.push({ ...store.redactClient(c), stats: await statsForSlug(c.slug) });
  }
  res.json(out);
});

app.get('/api/clients/:slug', async (req, res) => {
  const c = store.getClient(req.params.slug);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ...store.redactClient(c), stats: await statsForSlug(c.slug) });
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
    res.json({ ...store.redactClient(client), stats: { registrations: 0, attended: 0, noShows: 0, replays: 0, unhandled: 0, errors: 0 } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/clients/:slug', async (req, res) => {
  const patch = { ...req.body };
  if (patch.ghlApiKey && /•/.test(patch.ghlApiKey)) delete patch.ghlApiKey;
  if (patch.webinarJamApiKey && /•/.test(patch.webinarJamApiKey)) delete patch.webinarJamApiKey;
  for (const f of ['workflowRegistration', 'workflowAttended', 'workflowNoShow', 'workflowReplay']) {
    if (f in patch) patch[f] = patch[f] || null;
  }
  const updated = store.updateClient(req.params.slug, patch);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ ...store.redactClient(updated), stats: await statsForSlug(updated.slug) });
});

app.delete('/api/clients/:slug', (req, res) => {
  const ok = store.deleteClient(req.params.slug);
  if (!ok) return res.status(404).json({ error: 'not found' });
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
      workflows: workflows.map(w => ({ id: w.id, name: w.name, status: w.status })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Events ─────────────────────────────────────────────────────
// Recent (fast, in-memory cache) — used by dashboard live refresh
app.get('/api/events', async (req, res) => {
  try {
    const { clientSlug, status, filter } = req.query;
    const out = await events.getRecent({
      clientSlug,
      status,
      kind: filter,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full history with pagination (slower, reads full file)
app.get('/api/events/history', async (req, res) => {
  try {
    const {
      clientSlug, status, kind, search, since, until,
      limit = 200, offset = 0,
    } = req.query;
    const result = await events.queryEvents({
      clientSlug, status, kind, search, since, until,
      limit:  Math.min(parseInt(limit) || 200, 1000),
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CSV export, per-client if ?clientSlug= provided, else all
app.get('/api/events/export', async (req, res) => {
  try {
    const { clientSlug } = req.query;
    const csv = await events.exportCsv({ clientSlug });
    const name = clientSlug
      ? `events-${clientSlug}-${new Date().toISOString().slice(0,10)}.csv`
      : `events-all-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retry a failed event
app.post('/api/events/:id/retry', async (req, res) => {
  const result = await queue.retryEvent(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// Queue status
app.get('/api/queue', (req, res) => {
  res.json(queue.queueSummary());
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
app.listen(config.port, () => {
  // Kick off background services
  queue.startWorker();
  events.startPruneTimer();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Webinar → GHL Sync (multi-tenant)`);
  console.log(`   Dashboard : http://localhost:${config.port}`);
  console.log(`   Data dir  : ${config.dataDir}`);
  console.log(`   Auth      : ${config.auth.user && config.auth.pass ? 'enabled' : '⚠️  OPEN (set DASHBOARD_USER/PASS)'}`);
  console.log(`   Clients   : ${store.listClients().length}`);
  console.log(`   Queue     : ${queue.queueDepth()} pending`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
