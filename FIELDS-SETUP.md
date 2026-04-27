# GHL Custom Fields Setup

The sync app writes to **8 custom fields** in each client's GHL sub-account. Create them once per client in **Settings → Custom Fields**, take a snapshot, then apply that snapshot to every new sub-account.

If a field is missing in GHL, the app silently skips writing that one field — the rest of the sync still works. Field keys are case-sensitive and must match exactly.

## The 8 fields

| Field name (display)     | Unique key (must match exactly) | Type                     | When it's set                                                                          |
|--------------------------|----------------------------------|--------------------------|----------------------------------------------------------------------------------------|
| Webinar Registered Date  | `webinar_registered_date`        | Date                     | Registration trigger — date the contact registered                                     |
| Webinar Date             | `webinar_date`                   | Date                     | Every event — scheduled session date (real value with API key, otherwise today's date) |
| Webinar Time             | `webinar_time`                   | Text                     | Every event — scheduled session time (real value with API key, otherwise current)      |
| Webinar Type             | `webinar_type`                   | Text                     | Every event — `WebinarJam` / `EverWebinar` / `Unknown`                                 |
| Webinar Attended         | `webinar_attended`               | Single Option (Yes / No) | Attendance + No-Show triggers                                                          |
| Replay Watched           | `replay_watched`                 | Text                     | Replay trigger (also "Yes"/"No" by attendance handler when API confirms)               |
| Live Room Link           | `live_room_link`                 | Text                     | Every event — per-registrant tokenized URL from webhook payload                        |
| Replay Room Link         | `replay_room_link`               | Text                     | Every event — per-registrant tokenized URL from webhook payload                        |

## Verifying the unique key

When you create a field in GHL, it auto-generates the unique key from the display name. After saving, click into the field and confirm the key matches the second column above.

For example: a field named "Webinar Date" should have key `contact.webinar_date`. Only the part after `contact.` matters and must match exactly. If GHL auto-generated something different (e.g., `webinar_date_1` because the name was taken before), delete and recreate.

## How `webinar_type` works

- App default: `Unknown`
- When a WebinarJam API key is configured for the client, the app calls the API on every event. If the webinar resolves via the EverWebinar API, the type becomes `EverWebinar`. If it resolves via WebinarJam, it becomes `WebinarJam`.
- If neither API recognizes the webinar (or no API key is configured), the type stays `Unknown` — the app doesn't guess.

## Snapshot workflow (recommended)

1. Create all 8 fields in any one client's GHL sub-account
2. **Settings → Snapshots → Create Snapshot**
3. For every new client, apply that snapshot when creating their sub-account
4. All 8 fields appear with the correct keys — no manual work
