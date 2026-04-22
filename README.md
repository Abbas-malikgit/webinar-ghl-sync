# Webinar → GHL Sync

Multi-tenant sync between WebinarJam / EverWebinar and GoHighLevel. One deployment handles all your clients — each client gets their own webhook URL, GHL credentials, pipeline, and stats.

**What it does per client:**
- Creates/updates GHL contact on registration, attendance, no-show, and replay webhooks
- Creates opportunity in the **Registered** pipeline stage on first registration
- Updates custom fields (`webinar_attended`, `webinar_no_show`, `replay_watched`, `time_watched_mins`, etc.) on every event
- Pipeline movement past Registered is the job of GHL workflows — triggered off those custom field changes

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Configure `.env`
Copy `.env.example` to `.env` and set:
```
PORT=3000
DASHBOARD_USER=admin
DASHBOARD_PASS=pick-a-strong-password
DATA_DIR=./data
```

### 3. Run
```bash
npm start        # or: npm run dev (auto-restart)
```

Open **http://localhost:3000**, log in with your dashboard credentials, and click **+ Add Client**.

---

## Adding a client (through the dashboard)

1. Click **+ Add Client**
2. Fill in:
   - **Name** — display name (e.g. "NCCI")
   - **GHL API Key** — private integration token for the GHL sub-account
   - **GHL Location ID** — the sub-account ID (e.g. `TaSBofNlkPChbCiwfrLz`)
   - **WebinarJam API Key** — optional; enables API enrichment (attendance minutes, session date/time lookups)
3. Click **Verify & Continue** — the app calls GHL, confirms credentials, and loads your pipelines
4. Pick the **Pipeline** and **Registered stage** from dropdowns
5. Click **Save Client**
6. Copy the generated webhook URL and paste it into all 4 WebinarJam integration rules for that client's webinar(s):
   - They register
   - They attend the live webinar
   - They miss the live webinar
   - They attend the webinar replay

Format: `https://your-app.railway.app/webhook/{slug}/{token}`

---

## How webhook auth works

Each client has a random 32-char `webhookToken` auto-generated at creation. The webhook URL includes both the slug and the token: `/webhook/ncci/a1b2c3...`. Requests with the wrong token return 404. If you ever need to revoke access (e.g. if a URL leaks), click **Rotate Token** on the client detail page — the old URL stops working instantly and you paste the new one into WebinarJam.

---

## Dashboard auth

HTTP Basic Auth. Set `DASHBOARD_USER` and `DASHBOARD_PASS` in `.env`. If both are unset, the dashboard is open (dev mode — don't do this in production).

The `/webhook/*` and `/api/health` endpoints are always public — they have to be, since WebinarJam needs to reach them. Everything else is locked down.

---

## Data storage

Client configs live in `./data/clients.json` (path configurable via `DATA_DIR`). Each entry:
```json
{
  "slug": "ncci",
  "name": "Northern Connections Canada Immigration",
  "ghlApiKey": "pit-xxxxx",
  "ghlLocationId": "TaSBofNlkPChbCiwfrLz",
  "ghlPipelineId": "...",
  "ghlStageRegistered": "...",
  "webinarJamApiKey": "xxx-xxx-xxx",
  "webhookToken": "a1b2c3d4...",
  "createdAt": "2026-04-21T...",
  "updatedAt": "2026-04-21T..."
}
```

**Event log is in-memory only** (last ~1000 events across all clients). Restart = empty log. GHL is the source of truth.

---

## Deploying to Railway

1. Push the repo to GitHub
2. Create a Railway project → connect the repo
3. Add the `.env` variables in Railway's dashboard
4. **Important — add a volume:** Railway → your service → Settings → Volumes → add a volume, mount path `/data`
5. Set `DATA_DIR=/data` in the Railway env vars
6. Deploy. Visit the Railway URL, log in, start adding clients.

Without the volume, `clients.json` resets every time Railway redeploys. You really do want the volume.

One Railway deployment = all your clients. $5/mo Hobby plan is plenty.

---

## WebinarJam vs EverWebinar

The webhook payload is identical for both platforms. The app tries EverWebinar's API first for enrichment (session date, attendance minutes), then falls back to WebinarJam's API. Works with either.

---

## API reference (for your own scripting if needed)

All of these require HTTP Basic Auth.

| Method | Path | Description |
|---|---|---|
| `GET`    | `/api/status`                      | server + aggregate stats |
| `GET`    | `/api/clients`                     | list all clients (keys masked) |
| `GET`    | `/api/clients/:slug`               | get one client |
| `POST`   | `/api/clients`                     | create client |
| `PUT`    | `/api/clients/:slug`               | update client |
| `DELETE` | `/api/clients/:slug`               | delete client |
| `POST`   | `/api/clients/:slug/rotate-token`  | generate new webhook token |
| `POST`   | `/api/ghl/verify`                  | `{apiKey, locationId}` → `{location, pipelines[]}` |
| `GET`    | `/api/events?clientSlug=&filter=&limit=` | recent events |

Public endpoints (no auth):

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook/:slug/:token` | WebinarJam/EverWebinar events |
| `GET`  | `/api/health`           | uptime check for monitors |

---

## Architecture notes

- **Only "Registered" stage is set by this app.** Every other stage is moved by GHL workflows that trigger off custom field changes. Don't build workflows that branch on pipeline stage — branch on `webinar_attended`, `webinar_no_show`, `replay_watched`, etc.
- **Custom field keys are shared across clients** (see `src/config.js` → `FIELDS`). Each client's GHL sub-account needs the same field keys defined. If a client uses different key names, edit the FIELDS map — or we refactor to per-client field mapping in a future version.
- **Webhook response is 200 before handler runs.** WebinarJam just needs to know the webhook was received. Handler errors go into the in-memory event log so you can see them in the dashboard.
