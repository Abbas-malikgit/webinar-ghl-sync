# What changed in this update

## Per-schedule workflow overrides

**Use case:** One webinar with multiple schedules (e.g., "Just in time" + "Every day, 1:00 PM" running off the same EverWebinar config) → fire different workflows per schedule.

The previous override system matched only by webinar ID/name. So if both schedules used the same webinar, they fired the same workflows. Now overrides can additionally pin to a specific schedule.

### How it works

EverWebinar's webhook payload only contains `webinar.id` and `webinar.name` — no schedule info. So we have to use API enrichment to know which schedule a registrant signed up for. Specifically:

1. **Webhook arrives** → handler runs API enrichment (`/everwebinar/registrants`) → that response includes `schedule` (an integer ID like 55 or 56)
2. **Override matcher** now does a two-pass selection:
   - **Pass 1:** find an override matching this webinar **and** with `scheduleId === reg.schedule`
   - **Pass 2:** if no schedule-specific match, find an override matching this webinar with **no scheduleId set** (matches all schedules)
   - **Fallback:** client-level defaults
3. **Schedule-specific beats webinar-level**, so you can have a "Daily 1pm → workflow X" override AND a "(any other schedule) → workflow Y" fallback both on the same webinar.

### UI flow (Add/Edit Client → Per-Webinar Overrides)

When the user picks a webinar in an override row:
1. App calls `POST /api/wj/webinar` with that webinar's ID
2. EW API responds with the schedules list including their integer IDs and comment labels ("Just in time", "Every day, 01:00 PM", etc.)
3. Schedule dropdown populates with each schedule. "All schedules" option = leave scheduleId blank = matches every session of that webinar.

If the EW API call fails (network issue, expired schedule index, key missing), the picker falls back to a manual numeric input — you can paste the schedule ID directly if you know it from the EW dashboard URL or earlier API responses.

### Constraint to know

**This only works for clients with a configured WebinarJam/EverWebinar API key.** Without the API call we can't read the registrant's schedule from the webhook (the webhook just doesn't contain it). For clients without a key, schedule-specific overrides will never match → falls through to webinar-level overrides → falls through to client defaults. So existing setups keep working unchanged.

---

# Files touched

```
src/webinarjam.js               — getWebinarDetails() (singular /webinar endpoint)
                                  scheduleId extracted from registrant response
                                  resolveWorkflows takes enrichment as 3rd arg
                                  two-pass match: schedule-specific → webinar-level → defaults
src/clients.js                  — normalizeOverrides accepts scheduleId + scheduleLabel
src/handlers/registration.js    — passes reg to resolveWorkflows
src/handlers/attendance.js      — same
src/handlers/noShow.js          — same (both noShow and replay handlers)
server.js                       — POST /api/wj/webinar endpoint
public/index.html               — schedule picker per override row, lazy-loads schedules,
                                  saves scheduleId/scheduleLabel in payload, resets
                                  schedule when matchType or webinar changes
```

Same deploy:

```bash
git add -A
git commit -m "feat: per-schedule workflow overrides (one webinar, different workflows per session)"
git push
```
