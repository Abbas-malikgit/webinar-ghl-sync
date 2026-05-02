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
  if (!email) return null;
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

// Strict phone match — GHL's search returns partial matches, we want exact.
// Compares on digits-only so "+1 (415) 555-1234" matches "+14155551234".
export async function findContactByPhone(client, phone) {
  if (!phone) return null;
  const url = `${BASE}/contacts/?locationId=${client.ghlLocationId}&query=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: headers(client.ghlApiKey) });
  const data = await res.json();

  if (!res.ok) {
    console.error('GHL phone search error:', data);
    return null;
  }

  const target = phone.replace(/\D/g, '');
  const contacts = data?.contacts || [];
  return contacts.find(c => (c.phone || '').replace(/\D/g, '') === target) || null;
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
  if (!res.ok) {
    // Surface the GHL response object as a structured error so upsertContact
    // can detect the "duplicate phone" case and recover by updating instead.
    const err = new Error(`GHL createContact failed: ${JSON.stringify(data)}`);
    err.response = data;
    err.status   = res.status;
    throw err;
  }

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
  if (contactData.email)     body.email     = contactData.email;

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

// Smart upsert: search phone first, then email, fall through to create.
// If create still fails with "duplicate" (race or stale search), recover by
// pulling the existing contact ID from GHL's error response and updating it.
export async function upsertContact(client, contactData) {
  // 1. Try phone first (most reliable in WebinarJam — phone is typed by user, less typo-prone than email)
  if (contactData.phone) {
    const byPhone = await findContactByPhone(client, contactData.phone);
    if (byPhone) {
      console.log(`🔁 Existing contact found by phone: ${byPhone.id}`);
      await updateContact(client, byPhone.id, contactData);
      return byPhone;
    }
  }

  // 2. Fall back to email
  if (contactData.email) {
    const byEmail = await findContactByEmail(client, contactData.email);
    if (byEmail) {
      console.log(`🔁 Existing contact found by email: ${byEmail.id}`);
      await updateContact(client, byEmail.id, contactData);
      return byEmail;
    }
  }

  // 3. Neither found — try to create. If GHL says duplicate, GHL hands us
  //    the matching contactId in error.response.meta.contactId — use it.
  try {
    return await createContact(client, contactData);
  } catch (err) {
    const meta = err?.response?.meta;
    const isDup = err?.response?.message?.toLowerCase().includes('duplicat');
    if (isDup && meta?.contactId) {
      console.log(`🔁 Recovered duplicate from GHL error (matched on ${meta.matchingField}): ${meta.contactId}`);
      await updateContact(client, meta.contactId, contactData);
      return { id: meta.contactId, email: contactData.email, phone: contactData.phone };
    }
    throw err;
  }
}
