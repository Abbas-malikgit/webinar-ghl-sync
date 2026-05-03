# What changed in this update

Four things, plus a couple of bonuses:

## 1. Bug fix — "stuck in registered" (the 69 contacts issue)

The attended / no_show / replay handlers used to do `findContactByEmail` and bail out with "contact not found" if GHL didn't return a hit. That was the root cause of the 69 contacts that got webhooks for attended but never moved out of the registered stage.

There were two failure modes stacked on top of each other:

- **Email-only search** — registration uses phone *first* then email, but attended only searched by email. If WJ sent a different email casing on attended vs registration, search missed it.
- **GHL search index lag** — GHL's `/contacts/?query=` reads from a search index that's eventually-consistent (30-90 second lag). Fast EverWebinar attended events fired before registration's index entry was searchable.

The fix is in `src/ghl.js`. New helper `findOrCreateContact` does:

1. **Direct lookup** via GHL's `/contacts/lookup` endpoint (reads the contacts table directly, no index lag)
2. **Search by phone** (digits-only equality)
3. **Search by email** (case-insensitive)
4. **8-second wait + retry** on the lookup endpoint — catches the index-lag race
5. **Create if still missing**, recovering from duplicate errors via GHL's `meta.contactId`

Every handler now uses this. Even if registration somehow gets dropped, the attended handler will create the contact from the webhook payload (which contains name + email + phone) and continue. No more lost contacts.

**To recover the 69 you already lost:** the events are still in your event log with the original webhook payloads. Click any failed/missing one and use "↻ Retry now" — with the fix, they'll go through. If you want a bulk replay script for them, just tell me which slug they're under and the date range.

## 2. Per-webinar workflow overrides

What you asked for — JIT webinar to one workflow, daily 1:30 to another, all under the same client.

Schema change: each client now has an optional `webinarOverrides[]` array. Each override:

```json
{
  "id": "abc123",
  "label": "JIT Webinar",
  "matchType": "id",         // or "name"
  "matchValue": "12345",     // webinar id, or exact name
  "workflowRegistration": "...",   // null = use client default
  "workflowAttended": "...",
  "workflowNoShow": "...",
  "workflowReplay": "..."
}
```

In the wizard's Step 2, after the client default workflows, there's a new **Per-Webinar Overrides** section. Click "+ Add Override" to add one. If the client has a WebinarJam API key configured, you get a dropdown picker showing all webinars from both WJ and EW with their IDs and platform. Otherwise you can match by exact name.

**Matching priority at runtime:**
1. First override that matches `webinar.id` (preferred — IDs don't change)
2. First override that matches `webinar.name` (case-insensitive)
3. No match → use client default workflows

For each event type (registration / attended / no_show / replay), if the override has a workflow set, that wins. If the override leaves it blank, falls back to the client default for that type.

The dashboard event row shows a small purple **override badge** next to the kind label whenever an override matched, so you can see at a glance which webinar's rules fired.

## 3. CSV export — API enrichment columns now populate

The CSV had columns like `api_attended_live`, `api_time_watched_mins`, etc. that were always blank because nothing in the code populated them on the event. Now every handler captures the full WJ/EW API response (`fetchRegistrantData` result) on the event when the job completes, and the CSV pulls from it.

New columns added: `api_platform`, `api_utm_source`, `api_utm_medium`, `api_utm_campaign`.

For events created **before this update**, those columns are still empty (the data wasn't captured at the time). Going forward they fill in automatically — but only when a WebinarJam API key is configured for the client. Without the API key, `webinar_type` stays `Unknown` and the api_* columns stay blank.

> Heads up — your message said "PDF" but there's no PDF export in the codebase, only CSV. I assumed you meant the CSV. If you actually want a separate PDF report (e.g., per-webinar summary report styled like your KPI report), tell me and I'll add it.

## 4. Visual run history (Zapier-style)

Click any event row to expand. Instead of a raw JSON dump, you now see a step-by-step pipeline:

```
✓ Webhook received
  → Ali Khan <ali@x.com> · Daily 1:30 Webinar

  ↓

✓ WebinarJam API enrichment
  → EverWebinar · 2026-05-04 13:30

  ↓

✓ Workflow routing
  → Override matched: Daily 1:30 Webinar

  ↓

✓ GHL Contact
  → Updated existing contact · ABC123XYZ

  ↓

✓ Workflow enrollment
  → Enrolled in wf-9f8a7b6c
```

Each step is collapsible. Click a step header to expand and see the full key-value details — what was found in the API call, which workflow IDs were resolved, which contact action was taken (created/updated/recovered), etc.

For events that haven't run yet (`status: queued`), you see a "Pending" placeholder with the basic webhook info.

For events that failed (`status: error`), you see the partial pipeline showing exactly which step blew up and the error message — much faster diagnosis than scrolling through raw JSON.

There's still a "Show raw webhook payload ▾" toggle at the bottom for the original JSON if you ever need it.

## Bonus: search bar

Two of them, actually:

- **Main dashboard** — global search input. Empty = client cards as usual. Typing anything searches events across all clients (email, name, webinar name, error message, client name) and shows the matching events inline. Great for "where did Ali register again?"
- **Client detail page** — per-client search input next to the filter pills. Same fields, scoped to the current client. Debounced 200ms so it feels live.

The existing `/api/events/history` endpoint already supported `search` as a query param (full-text across email/name/webinar/message). I extended `/api/events` (the fast in-memory path) to support it too, so the dashboard polling stays snappy.

---

# Files touched

```
server.js                       — added /api/wj/list, search param on /api/events, webinarOverrides accepted
src/clients.js                  — schema includes webinarOverrides + normalizeOverrides validator
src/config.js                   — unchanged
src/events.js                   — added search to getRecent, new api_platform + UTM CSV columns
src/ghl.js                      — new lookupContactDirect, findOrCreateContact, smarter upsertContact
src/queue.js                    — captures pipeline from handlers, flattens API enrichment onto events
src/webinarjam.js               — added listWebinars + resolveWorkflows
src/handlers/registration.js    — returns pipeline, uses resolveWorkflows
src/handlers/attendance.js      — fixes the 69 bug (findOrCreateContact), returns pipeline
src/handlers/noShow.js          — fixes the 69 bug for both no-show and replay handlers
src/middleware/auth.js          — unchanged
public/index.html               — overrides UI in wizard, search bars, run history visual

data/clients.json               — your existing data is unchanged
                                  (webinarOverrides field added on next save)
```

# Deploying

No new env vars. No new dependencies. No database migrations. Just push the code:

```bash
git add -A
git commit -m "v3 — bugfix, per-webinar overrides, run history, search"
git push
```

Railway redeploys, your existing `clients.json` on the volume is untouched. The first time you edit any client, the `webinarOverrides: []` field gets added to their record.

# Testing checklist

If you want to smoke-test before pointing real webhooks at it:

1. Open the dashboard, search for an existing event. Confirm filtering works.
2. Click an old event — you'll see "Show raw webhook payload" because there's no pipeline data on legacy events. That's expected. New events will have the full pipeline.
3. Edit your ArgusTest client → Step 2 → add a fake override (label "Test", match by name "ZZZ Doesn't Exist"). Save. Reopen — should be there.
4. Fire a test webhook. Confirm the new event has the visual pipeline and the API enrichment fields are populated (assuming you've added the WJ key).
5. Test the per-webinar override: change the override's matchValue to your real webinar's name, change the registration workflow, fire a test registration. Check that the event shows the override badge and that GHL enrolled in the override workflow not the default.
