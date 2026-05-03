# What changed in this update

Three fixes for the bugs surfaced by the Mandall test run.

## 1. Prefer webinar ID over name when calling the WJ/EW API

**Bug:** Mandall's EW had multiple webinars with the same display name "May 2nd 8 AM - Ben / English". The webhook arrived with `webinar.id: 2`, but our code did `find(w => w.name === wantedName)` which returned the first match — `webinar_id: 12`. We then called `/registrants` against id 12 and EW correctly answered "registrant not found." Adrian was registered against id 2.

**Fix:** `getApiWebinarId` in `src/webinarjam.js` now:

1. If the webhook gave us a `webinar.id`, probes both EW and WJ to find the platform that has a webinar with that exact ID. ID is canonical and matches what `/registrants` expects, so no ambiguity.
2. Only falls back to name match if no platform has the ID (or if the webhook didn't include one — legacy webhooks).
3. Handler signature: `fetchRegistrantData(apiKey, { id, name }, email)`. The old `(apiKey, name, email)` form still works for backwards compatibility.

The webhook payload always has the canonical webinar ID — we were just throwing it away. Now we use it.

## 2. No more fake fallback dates in GHL

**Bug:** When API enrichment failed (which happens whenever the webinar has expired from EW's registrant index, or when the API key is missing), `registration.js` was writing today's wall-clock time into `scheduledDate` / `scheduledTime`:

```js
const now = new Date();
data.scheduledDate = now.toISOString().split('T')[0];     // "today"
data.scheduledTime = now.toLocaleTimeString(...) + ' ET'; // "current time ET"
```

That produced misleading data on the GHL contact — "Webinar Date: 2026-05-03" and "Webinar Time: 12:35 PM ET" looked legitimate but were actually the moment the webhook arrived, not the actual session time. Pretty bad — workflows reading those fields would happily send "see you at 12:35 PM today!" reminders that weren't grounded in any real schedule.

**Fix:** When API enrichment fails, those fields are now left **blank** in GHL. The `webinar_type` field stays "Unknown" too. Workflows can detect the missing value and branch accordingly. The contact's "Webinar Registered Date" still gets set (that's just `now`, which is unambiguously correct — the webhook just arrived).

The pipeline's API enrichment step now reflects this clearly: "Registrant not found in WJ/EW API — webinar date/time fields will be left blank".

## 3. Backward compat — same fix in attended/no-show/replay handlers

Those handlers also use `fetchRegistrantData`. Updated all three to pass the webinar ref object (`{ id, name }`) instead of just the name. Same fix, same benefit.

The attended/no-show/replay handlers never had the fake-fallback bug — their guards (`if (reg.scheduledDate) data.scheduledDate = reg.scheduledDate`) only wrote when API succeeded. So no behavior change there beyond the ID-preferred lookup.

---

## Why your old contacts in GHL still show wrong dates

Contacts that got created with the buggy fallback already have those wrong dates written into their custom fields. This patch only affects future events. If you want to clean up the old ones, options:

1. **Manual sweep** — search GHL for contacts where `webinar_type = Unknown` and clear the date/time fields by hand (probably small enough number to be doable).
2. **One-shot replay script** — I can write a Node script that reads through `events.jsonl`, finds events where API enrichment failed, and for each one PUTs an update to the GHL contact clearing those three fields. Let me know if you want that.

For the Mandall registration that's stuck with `12:35 PM ET`, you can just edit the contact in GHL by hand for now and replay the next test webhook to confirm the fix works.

---

# Files touched

```
src/webinarjam.js               — getApiWebinarId now ID-first, falls back to name
                                  fetchRegistrantData accepts { id, name } object
src/handlers/registration.js    — no fake fallback dates on enrichment failure
src/handlers/attendance.js      — pass webinar ref object
src/handlers/noShow.js          — pass webinar ref object (both noShow + replay handlers)
```

Everything else from the previous update is unchanged. Same deploy:

```bash
git add -A
git commit -m "fix: prefer webinar id over name; remove fake fallback dates"
git push
```
