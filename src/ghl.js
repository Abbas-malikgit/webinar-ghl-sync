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

function nowIsoWithOffset() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function buildCustomFields(data) {
  const fields = [];
  const push = (item) => item && fields.push(item);

  push(dateField(FIELDS.webinarRegisteredDate, data.registeredAt));
  push(dateField(FIELDS.webinarDate,           data.scheduledDate));
  push(field(FIELDS.webinarTime, data.scheduledTime));
  push(field(FIELDS.webinarType, data.webinarType));

  if (data.attended !== undefined)
    push(field(FIELDS.webinarAttended, data.attended ? 'Yes' : 'No'));

  if (data.replayWatched !== undefined)
    push(field(FIELDS.replayWatched, data.replayWatched ? 'Yes' : 'No'));

  if (data.liveRoomLink)   push(field(FIELDS.liveRoomLink,   data.liveRoomLink));
  if (data.replayRoomLink) push(field(FIELDS.replayRoomLink, data.replayRoomLink));

  return fields.filter(Boolean);
}

// ─── Location / Workflow discovery ────────────────────────────

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

// More reliable than search query for fresh contacts — hits the
// dedicated lookup endpoint which reads from the contacts table
// directly (not the search index, which lags 30-90s).
export async function lookupContactDirect(client, { email, phone }) {
  if (!email && !phone) return null;
  const params = new URLSearchParams({ locationId: client.ghlLocationId });
  if (email) params.set('email', email);
  if (phone) params.set('phone', phone);

  try {
    const url = `${BASE}/contacts/lookup?${params.toString()}`;
    const res = await fetch(url, { headers: headers(client.ghlApiKey) });
    if (!res.ok) return null;
    const data = await res.json();
    const contacts = data?.contacts || [];
    return contacts[0] || null;
  } catch (e) {
    return null;
  }
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

// ─── Smart contact resolver ──────────────────────────────────
// Tries every reasonable way to find an existing contact before
// giving up. Used by every handler for the upsert path.
//
// Strategy:
//   1. lookup endpoint (direct, no index lag)  — phone or email
//   2. search by phone (digits-only equality)
//   3. search by email (case-insensitive)
//   4. wait `retryDelayMs` (default 8s) and try lookup again — covers
//      the GHL search-index-lag race when registration just happened
//
// Returns: matched GHL contact, or null if none found.
async function findContactExhaustive(client, data, { retryDelayMs = 8000 } = {}) {
  // 1. Direct lookup endpoint — most reliable
  const direct = await lookupContactDirect(client, { email: data.email, phone: data.phone });
  if (direct) {
    console.log(`🔁 Found by lookup endpoint: ${direct.id}`);
    return direct;
  }

  // 2. Search by phone
  if (data.phone) {
    const byPhone = await findContactByPhone(client, data.phone);
    if (byPhone) {
      console.log(`🔁 Found by phone search: ${byPhone.id}`);
      return byPhone;
    }
  }

  // 3. Search by email
  if (data.email) {
    const byEmail = await findContactByEmail(client, data.email);
    if (byEmail) {
      console.log(`🔁 Found by email search: ${byEmail.id}`);
      return byEmail;
    }
  }

  // 4. Last resort — wait and retry the lookup endpoint. This catches
  //    the case where registration just happened and GHL's index hasn't
  //    caught up yet. Only do this if we have an email or phone to look up.
  if ((data.email || data.phone) && retryDelayMs > 0) {
    console.log(`⏳ Not found on first pass — waiting ${Math.round(retryDelayMs/1000)}s before retry`);
    await sleep(retryDelayMs);
    const retry = await lookupContactDirect(client, { email: data.email, phone: data.phone });
    if (retry) {
      console.log(`🔁 Found on retry: ${retry.id}`);
      return retry;
    }
  }

  return null;
}

// ─── Find-or-create with attendance updates ──────────────────
// Used by attended / no_show / replay handlers. Replaces the old
// "findContactByEmail then bail" pattern that lost the 69 contacts.
//
// If no contact exists after exhaustive search, creates one from the
// webhook data. If create fails as duplicate, recovers via meta.contactId.
//
// Returns: { contact, action: 'updated' | 'created' | 'recovered' }
export async function findOrCreateContact(client, data) {
  const found = await findContactExhaustive(client, data);
  if (found) {
    await updateContact(client, found.id, data);
    return { contact: found, action: 'updated' };
  }

  console.log(`📝 No contact found — creating from webhook data`);
  try {
    const created = await createContact(client, data);
    return { contact: created, action: 'created' };
  } catch (err) {
    // Duplicate recovery — GHL hands us the matching contactId
    const meta = err?.response?.meta;
    const isDup = err?.response?.message?.toLowerCase().includes('duplicat');
    if (isDup && meta?.contactId) {
      console.log(`🔁 Recovered duplicate from GHL error (matched on ${meta.matchingField}): ${meta.contactId}`);
      await updateContact(client, meta.contactId, data);
      return {
        contact: { id: meta.contactId, email: data.email, phone: data.phone },
        action:  'recovered',
      };
    }
    throw err;
  }
}

// Smart upsert — same idea, used by registration handler.
// (Kept as separate name for clarity; under the hood it's the same flow.)
export async function upsertContact(client, contactData) {
  const result = await findOrCreateContact(client, contactData);
  return result.contact;
}
