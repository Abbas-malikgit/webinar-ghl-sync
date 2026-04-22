import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { config } from './config.js';

const filePath = () => path.join(config.dataDir, config.clientsFile);

function ensureFile() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(filePath())) fs.writeFileSync(filePath(), '[]', 'utf8');
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Failed to read clients.json:', e.message);
    return [];
  }
}

function save(clients) {
  ensureFile();
  fs.writeFileSync(filePath(), JSON.stringify(clients, null, 2), 'utf8');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function genToken() {
  return randomBytes(16).toString('hex'); // 32 chars
}

// ─── Public API ──────────────────────────────────────────────

export function listClients() {
  return load();
}

export function getClient(slug) {
  const clients = load();
  return clients.find(c => c.slug === slug) || null;
}

export function getClientByToken(slug, token) {
  const c = getClient(slug);
  if (!c) return null;
  if (c.webhookToken !== token) return null;
  return c;
}

export function createClient(data) {
  const clients = load();

  let slug = slugify(data.slug || data.name);
  if (!slug) throw new Error('name or slug is required');

  // Ensure unique slug
  const existing = new Set(clients.map(c => c.slug));
  let finalSlug = slug;
  let n = 2;
  while (existing.has(finalSlug)) {
    finalSlug = `${slug}-${n++}`;
  }

  const now = new Date().toISOString();
  const client = {
    slug:                 finalSlug,
    name:                 data.name,
    ghlApiKey:            data.ghlApiKey,
    ghlLocationId:        data.ghlLocationId,
    workflowRegistration: data.workflowRegistration || null,
    workflowAttended:     data.workflowAttended     || null,
    workflowNoShow:       data.workflowNoShow       || null,
    workflowReplay:       data.workflowReplay       || null,
    webinarJamApiKey:     data.webinarJamApiKey     || null,
    webhookToken:         genToken(),
    createdAt:            now,
    updatedAt:            now,
  };

  clients.push(client);
  save(clients);
  return client;
}

export function updateClient(slug, patch) {
  const clients = load();
  const idx = clients.findIndex(c => c.slug === slug);
  if (idx === -1) return null;

  // Don't allow slug or token overwrite unless explicit
  const { slug: _s, webhookToken: _t, createdAt: _c, ...safe } = patch;

  clients[idx] = {
    ...clients[idx],
    ...safe,
    updatedAt: new Date().toISOString(),
  };
  save(clients);
  return clients[idx];
}

export function deleteClient(slug) {
  const clients = load();
  const next = clients.filter(c => c.slug !== slug);
  if (next.length === clients.length) return false;
  save(next);
  return true;
}

export function rotateToken(slug) {
  const clients = load();
  const idx = clients.findIndex(c => c.slug === slug);
  if (idx === -1) return null;
  clients[idx].webhookToken = genToken();
  clients[idx].updatedAt    = new Date().toISOString();
  save(clients);
  return clients[idx];
}

// Strip secrets for dashboard responses
export function redactClient(c) {
  if (!c) return null;
  const mask = s => {
    if (!s) return null;
    const str = String(s);
    if (str.length < 8) return '•'.repeat(str.length);
    return '•'.repeat(Math.max(0, str.length - 4)) + str.slice(-4);
  };
  return {
    ...c,
    ghlApiKey:        mask(c.ghlApiKey),
    webinarJamApiKey: c.webinarJamApiKey ? mask(c.webinarJamApiKey) : null,
    // webhookToken stays visible — user needs it
  };
}
