import fetch from 'node-fetch';
import { config, FIELDS } from './config.js';

const BASE = process.env.GHL_BASE_URL || config.ghl.baseUrl;

function headers(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Version': config.ghl.apiVersion,
  };
}

// GHL's workflow endpoint rejects the "Z" suffix AND milliseconds.
// It wants the exact format from its own error message: 2021-06-23T03:30:00+00:00.
// Same instant, no fractional seconds, explicit +HH:MM offset.
function nowIsoWithOffset() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ─── Field helpers ───────────────────────────────────────────

function field(key, value) {
  if (value === undefined || value === null || value === '') return null;
  return { key, field_value: String(value) };
}

function dateField(key, value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return { key, field_value: d.toISOString().split('T')[0] };
}

function numField(key, value) {
  const n = parseFloat(value);
  if (isNaN(n)) return null;
  return { key, field_value: n };
}

function buildCustomFields(data) {
  const fields = [];
  const push = (item) => item && fields.push(item);

  // Date fields
  push(dateField(FIELDS.webinarRegisteredDate, data.registeredAt));
  push(dateField(FIELDS.webinarDate,           data.scheduledDate));

  // Text fields
  push(field(FIELDS.webinarTime, data.scheduledTime));
  push(field(FIELDS.webinarType, data.webinarType));   // "WebinarJam" | "EverWebinar" | "Unknown"

  // Attendance state — only push when handler has actual data
  if (data.attended !== undefined)
    push(field(FIELDS.webinarAttended, data.attended ? 'Yes' : 'No'));

  if (data.replayWatched !== undefined)
    push(field(FIELDS.replayWatched, data.replayWatched ? 'Yes' : 'No'));

  // Per-registrant join URLs (from webhook payload's `links` object)
  if (data.liveRoomLink)   push(field(FIELDS.liveRoomLink,   data.liveRoomLink));
  if (data.replayRoomLink) push(field(FIELDS.replayRoomLink, data.replayRoomLink));

  return fields.filter(Boolean);
}

// ─── Location / Workflow discovery (for client setup wizard) ─

export async function getLocation(apiKey, locationId) {
  const res = await fetch(`${BASE}/locations/${locationId}`, { headers: headers(apiKey) });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message || data?.error || `status ${res.status}`;
    throw new Error(`GHL getLocation failed: ${msg}`);
  }
  return data.location;
}

export async function listWorkflows(apiKey, locationId) {
  const url = `${BASE}/workflows/?locationId=${locationId}`;
  const res = await fetch(url, { headers: headers(apiKey) });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message || data?.error || `status ${res.status}`;
    throw new Error(`GHL listWorkflows failed: ${msg}`);
  }
  return data.workflows || [];
}

export async function enrollContactInWorkflow(client, contactId, workflowId) {
  if (!workflowId) return null;

  const res = await fetch(`${BASE}/contacts/${contactId}/workflow/${workflowId}`, {
    method: 'POST',
    headers: headers(client.ghlApiKey),
    body: JSON.stringify({ eventStartTime: nowIsoWithOffset() }),
  });

  // GHL returns 200, 201, or 204 on success — use res.ok to accept any 2xx
  if (res.ok) {
    console.log(`✅ Enrolled contact ${contactId} in workflow ${workflowId}`);
    return true;
  }

  let data = {};
  try { data = await res.json(); } catch {}
  throw new Error(`GHL enrollWorkflow failed (${res.status}): ${JSON.stringify(data)}`);
}

// ─── Contacts ────────────────────────────────────────────────

export async function findContactByEmail(client, email) {
  const url = `${BASE}/contacts/?locationId=${client.ghlLocationId}&query=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: headers(client.ghlApiKey) });
  const data = await res.json();

  if (!res.ok) {
    console.error('GHL search error:', data);
    return null;
  }

  const contacts = data?.contacts || [];
  return contacts.find(c => c.email?.toLowerCase() === email.toLowerCase()) || null;
}

// Search by phone — strips formatting and matches on digits only.
// Returns the first contact whose normalized phone matches, or null.
export async function findContactByPhone(client, phone) {
  if (!phone) return null;
  const norm = String(phone).replace(/\D/g, '');
  if (!norm) return null;

  // GHL's contacts search query accepts the phone as a free-text query.
  // Pass the raw phone (with +) so GHL's own normalization runs.
  const url = `${BASE}/contacts/?locationId=${client.ghlLocationId}&query=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: headers(client.ghlApiKey) });
  const data = await res.json();

  if (!res.ok) {
    console.error('GHL phone search error:', data);
    return null;
  }

  const contacts = data?.contacts || [];
  return contacts.find(c => (c.phone || '').replace(/\D/g, '') === norm) || null;
}

export async function createContact(client, contactData) {
  const body = {
    locationId: client.ghlLocationId,
    firstName:  contactData.firstName,
    lastName:   contactData.lastName,
    email:      contactData.email,
    phone:      contactData.phone || undefined,
    source:     'WebinarJam',
    customFields: buildCustomFields(contactData),
  };

  const res = await fetch(`${BASE}/contacts/`, {
    method: 'POST',
    headers: headers(client.ghlApiKey),
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`GHL createContact failed: ${JSON.stringify(data)}`);

  console.log(`✅ Contact created: ${data.contact?.id} (${contactData.email})`);
  return data.contact;
}

export async function updateContact(client, contactId, contactData) {
  const body = {
    customFields: buildCustomFields(contactData),
  };

  if (contactData.firstName) body.firstName = contactData.firstName;
  if (contactData.lastName)  body.lastName  = contactData.lastName;
  if (contactData.phone)     body.phone     = contactData.phone;

  const res = await fetch(`${BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: headers(client.ghlApiKey),
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`GHL updateContact failed: ${JSON.stringify(data)}`);

  console.log(`✅ Contact updated: ${contactId}`);
  return data.contact;
}

export async function upsertContact(client, contactData) {
  // Search by PHONE first — GHL's "no duplicate contacts" setting enforces phone
  // uniqueness server-side, so trying email-first lets a dup-phone create slip
  // through and get rejected with a 400. Phone-first matches what GHL itself does.
  let existing = null;
  if (contactData.phone) {
    existing = await findContactByPhone(client, contactData.phone);
    if (existing) {
      console.log(`🔁 Existing contact found by phone: ${existing.id}`);
    }
  }

  // Fall back to email lookup if no phone match (or no phone on payload)
  if (!existing) {
    existing = await findContactByEmail(client, contactData.email);
    if (existing) {
      console.log(`🔁 Existing contact found by email: ${existing.id}`);
    }
  }

  if (existing) {
    await updateContact(client, existing.id, contactData);
    return existing;
  }
  return await createContact(client, contactData);
}
