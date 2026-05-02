import fetch from 'node-fetch';

const WJ_BASE = 'https://api.webinarjam.com/webinarjam';
const EW_BASE = 'https://api.webinarjam.com/everwebinar';

// ─── Per-client cache of resolved webinar IDs ────────────────
// Key: `${apiKey}::${webinarName}` → { base, apiId, platform }
const webinarIdCache = new Map();

// ─── Find the API webinar_id by name — tries both WJ + EW ────
// Returns { base, apiId, platform: 'WebinarJam' | 'EverWebinar' } so callers
// can tell which platform owns the webinar.
async function getApiWebinarId(apiKey, webinarName) {
  const cacheKey = `${apiKey}::${webinarName}`;
  if (webinarIdCache.has(cacheKey)) return webinarIdCache.get(cacheKey);

  for (const base of [EW_BASE, WJ_BASE]) {
    try {
      const res = await fetch(`${base}/webinars`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey }),
      });
      const data = await res.json();
      if (data?.status !== 'success') continue;

      const webinars = data?.webinars || [];
      const match = webinars.find(w => w.name === webinarName);
      if (match) {
        const platform = base === EW_BASE ? 'EverWebinar' : 'WebinarJam';
        const result = { base, apiId: match.webinar_id, platform };
        webinarIdCache.set(cacheKey, result);
        console.log(`   Resolved ${platform} webinar_id: ${match.webinar_id} for "${webinarName}"`);
        return result;
      }
    } catch (e) {
      console.warn(`   ${base} lookup failed:`, e.message);
    }
  }

  console.warn('⚠️  Webinar not found in either WJ or EW:', webinarName);
  return null;
}

// ─── Fetch full registrant record ─────────────────────────────
export async function fetchRegistrantData(apiKey, webinarName, email) {
  if (!apiKey) {
    console.warn('⚠️  No WebinarJam API key for this client — skipping API enrichment');
    return null;
  }

  try {
    const resolved = await getApiWebinarId(apiKey, webinarName);
    if (!resolved) return null;
    const { base, apiId, platform } = resolved;

    const res = await fetch(`${base}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:    apiKey,
        webinar_id: apiId,
        search:     email,
      }),
    });

    const data = await res.json();
    if (data?.status !== 'success') {
      console.warn('⚠️  /registrants failed:', data?.status);
      return null;
    }

    const list = data?.registrants?.data || data?.registrants || [];
    const regs = Array.isArray(list) ? list : [];
    const reg  = regs.find(r => r.email?.toLowerCase() === email.toLowerCase());

    if (!reg) {
      console.warn('⚠️  Registrant not found for:', email);
      return null;
    }

    console.log('✅ Registrant found:', reg.email);

    // Session date/time
    let scheduledDate = '';
    let scheduledTime = '';
    if (reg.event) {
      const p = parseDateString(String(reg.event));
      scheduledDate = p.date;
      scheduledTime = p.time;
      console.log(`📅 Session: ${scheduledDate} ${scheduledTime}`);
    }

    // Registration date
    let registeredAt = '';
    if (reg.signup_date) {
      const val = reg.signup_date;
      if (typeof val === 'number') {
        registeredAt = new Date(val * 1000).toISOString().split('T')[0];
      } else {
        registeredAt = parseDateString(String(val)).date;
      }
    }

    const attendedLive =
      reg.attended_live === 'Yes' || reg.attended_live === 1 ? 1 :
      reg.attended_live === 'No'  || reg.attended_live === 2 ? 2 : 0;

    const attendedReplay =
      reg.attended_replay === 'Yes' || reg.attended_replay === 1 ? 1 : 0;

    let dateLive = '';
    if (reg.date_live && reg.date_live !== '') {
      dateLive = typeof reg.date_live === 'number'
        ? new Date(reg.date_live * 1000).toISOString().split('T')[0]
        : parseDateString(String(reg.date_live)).date;
    }

    let dateReplay = '';
    if (reg.date_replay && reg.date_replay !== '') {
      dateReplay = typeof reg.date_replay === 'number'
        ? new Date(reg.date_replay * 1000).toISOString().split('T')[0]
        : parseDateString(String(reg.date_replay)).date;
    }

    const timeWatchedMins = parseHMStoMins(reg.time_live);
    const timeReplayMins  = parseHMStoMins(reg.time_replay);

    return {
      platform,                    // 'WebinarJam' or 'EverWebinar' — set as webinar_type by handler
      scheduledDate,
      scheduledTime,
      registeredAt,
      attendedLive,
      dateLive,
      enteredLive: reg.entered_live || '',
      timeWatchedMins,
      attendedReplay,
      dateReplay,
      timeReplayMins,
      utmSource:   reg.utm_source   || '',
      utmMedium:   reg.utm_medium   || '',
      utmCampaign: reg.utm_campaign || '',
      // Per-registrant join URLs (these are tokenized and unique per contact).
      // WebinarJam's /registrants response field names vary between WJ and EW;
      // we accept either pattern and fall back to empty.
      liveRoomLink:   reg.live_room_url   || reg.live_url   || reg.url_live   || reg.live_link   || '',
      replayRoomLink: reg.replay_room_url || reg.replay_url || reg.url_replay || reg.replay_link || '',
    };

  } catch (err) {
    console.warn('⚠️  API error:', err.message);
    return null;
  }
}

// ─── Normalize webhook payload ────────────────────────────────
export function normalizePayload(raw) {
  const lead    = raw.lead    || {};
  const webinar = raw.webinar || {};
  const links   = raw.links   || {};   // WebinarJam ships per-registrant tokenized URLs here

  const firstName = lead.first_name || raw.first_name || '';
  const lastName  = lead.last_name  || raw.last_name  || '';
  const email     = lead.email || raw.email || '';
  const phoneCountry = String(lead.phone_country_code || '').replace(/\s+/g, '');
  const phoneNumber  = String(lead.phone_number || raw.phone || '').replace(/\s+/g, '');

  // Build E.164-ish phone. WebinarJam sometimes ships `phone_number` already
  // including the country code (e.g. cc=+250, number=+250722776822) which
  // produced `+250+250722776822` and made GHL reject the contact. If the number
  // already starts with the country code (with or without a leading +), strip it.
  let phone = '';
  if (phoneNumber) {
    const ccDigits = phoneCountry.replace(/\D/g, '');
    let numDigits  = phoneNumber.replace(/\D/g, '');
    if (ccDigits && numDigits.startsWith(ccDigits)) {
      numDigits = numDigits.slice(ccDigits.length);
    }
    if (ccDigits && numDigits) {
      phone = `+${ccDigits}${numDigits}`;
    } else if (numDigits) {
      // No country code provided — keep digits and prefix with +
      phone = `+${numDigits}`;
    }
  }

  return {
    firstName,
    lastName,
    email,
    phone,
    webinarId:    String(webinar.id   || raw.webinar_id   || ''),
    webinarName:  webinar.name || raw.webinar_name || '',
    // Default to "Unknown" — the registration handler upgrades to
    // "WebinarJam" or "EverWebinar" when API enrichment confirms which.
    webinarType:  'Unknown',
    scheduledDate: '',
    scheduledTime: '',
    registeredAt:  new Date().toISOString(),
    attended:      undefined,
    replayWatched: undefined,
    // Per-registrant join URLs — WebinarJam puts these directly in the webhook's
    // `links` object. Empty string when not provided so they're falsy and
    // get skipped in buildCustomFields rather than written as empty strings.
    liveRoomLink:   links.live_room   || links.live   || '',
    replayRoomLink: links.replay_room || links.replay || '',
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function parseDateString(str) {
  if (!str) return { date: '', time: '' };
  const s = str.replace(/^[A-Za-z]+,\s*/, '');
  const lastComma = s.lastIndexOf(',');
  if (lastComma === -1) return { date: s.trim(), time: '' };

  const datePart = s.slice(0, lastComma).trim();
  const time     = s.slice(lastComma + 1).trim();

  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const parts = datePart.split(/\s+/);

  if (parts.length === 3) {
    let day, mon, year;
    if (!isNaN(parseInt(parts[0]))) {
      day  = String(parseInt(parts[0])).padStart(2, '0');
      mon  = String(MONTHS[parts[1].toLowerCase().slice(0,3)] || 1).padStart(2, '0');
      year = parts[2];
    } else {
      mon  = String(MONTHS[parts[0].toLowerCase().slice(0,3)] || 1).padStart(2, '0');
      day  = String(parseInt(parts[1])).padStart(2, '0');
      year = parts[2];
    }
    return { date: `${year}-${mon}-${day}`, time };
  }

  return { date: datePart, time };
}

function parseHMStoMins(str) {
  if (!str || str === '' || str === '00:00:00') return undefined;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return Math.round(parts[0] * 60 + parts[1] + parts[2] / 60);
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  return undefined;
}
