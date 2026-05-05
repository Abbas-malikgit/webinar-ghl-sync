import 'dotenv/config';
import path from 'path';

export const config = {
  port:        process.env.PORT || 3000,
  dataDir:     process.env.DATA_DIR || path.resolve('./data'),
  clientsFile: process.env.CLIENTS_FILE || 'clients.json',

  auth: {
    user: process.env.DASHBOARD_USER || null,
    pass: process.env.DASHBOARD_PASS || null,
  },

  ghl: {
    baseUrl:    'https://services.leadconnectorhq.com',
    apiVersion: '2021-07-28',
  },
};

// ─── GHL Custom Field Keys ────────────────────────────────────
// These keys must exist as Custom Fields in each client's GHL sub-account.
// Field names in GHL are display-only — what matters is the unique key
// (the part after "contact." in GHL's field detail view).
export const FIELDS = {
  webinarRegisteredDate:    'webinar_registered_date',  // Date — when they registered
  webinarDate:              'webinar_date',             // Date — scheduled session date
  webinarTime:              'webinar_time',             // Text — scheduled session time (webinar's local TZ, for messages)
  webinarType:              'webinar_type',             // Text — "WebinarJam" / "EverWebinar" / "Unknown"
  webinarAttended:          'webinar_attended',         // Single Option Yes/No
  replayWatched:            'replay_watched',           // Text
  liveRoomLink:             'live_room_link',           // Text — per-registrant tokenized URL
  replayRoomLink:           'replay_room_link',         // Text — per-registrant tokenized URL
  eventTimeInEst:           'event_time_in_est',        // Text — combined "MM-DD-YYYY HH:MM AM/PM" for GHL Set Event Time
};
