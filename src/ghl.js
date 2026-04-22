import fetch from 'node-fetch';
import { config, FIELDS } from './config.js';

const BASE = config.ghl.baseUrl;

function headers(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Version': config.ghl.apiVersion,
  };
}

// GHL's workflow endpoint rejects the "Z" suffix on ISO timestamps
// and demands an explicit +HH:MM offset. Same instant, fussier format.
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

  push(field(FIELDS.webinarName,           data.webinarName));
  push(field(FIELDS.webinarId,             data.webinarId));
  push(field(FIELDS.webinarType,           data.webinarType));
  push(dateField(FIELDS.webinarRegisteredDate, data.registeredAt));
  push(dateField(FIELDS.webinarScheduledDate,  data.scheduledDate));
  push(field(FIELDS.webinarScheduledTime,  data.scheduledTime));
  push(field(FIELDS.registrationSource,    data.source));

  if (data.attended !== undefined)
    push(field(FIELDS.webinarAttended, data.attended ? 'Yes' : 'No'));

  if (data.timeWatched !== undefined)
    push(numField(FIELDS.timeWatchedMins, data.timeWatched));

  if (data.watchPercentage !== undefined)
    push(numField(FIELDS.watchPercentage, data.watchPercentage));

  if (data.replayWatched !== undefined)
    push(field(FIELDS.replayWatched, data.replayWatched));

  if (data.noShow !== undefined)
    push(field(FIELDS.webinarNoShow, data.noShow));

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

  const eventStartTime = nowIsoWithOffset();
  console.log(`   ↪ enroll payload: eventStartTime="${eventStartTime}"`);

  const res = await fetch(`${BASE}/contacts/${contactId}/workflow/${workflowId}`, {
    method: 'POST',
    headers: headers(client.ghlApiKey),
    body: JSON.stringify({ eventStartTime }),
  });

  const raw = await res.text();
  console.log(`   ↪ GHL responded ${res.status}: ${raw}`);

  if (res.ok) {
  console.log(`✅ Enrolled contact ${contactId} in workflow ${workflowId}`);
  return true;
 }

  throw new Error(`GHL enrollWorkflow failed (${res.status}): ${raw}`);
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
  const existing = await findContactByEmail(client, contactData.email);
  if (existing) {
    console.log(`🔁 Existing contact found: ${existing.id}`);
    await updateContact(client, existing.id, contactData);
    return existing;
  }
  return await createContact(client, contactData);
}
