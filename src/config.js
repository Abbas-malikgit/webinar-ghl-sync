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
// Shared across all clients — the field keys must exist in each
// client's GHL sub-account (copy the same field set per client).
export const FIELDS = {
  webinarName:              'webinar_name',
  webinarId:                'webinar_id',
  webinarType:              'webinar_type',
  webinarRegisteredDate:    'webinar_registered_date',
  webinarScheduledDate:     'webinar_scheduled_date',
  webinarScheduledTime:     'webinar_scheduled_time',
  registrationSource:       'webinar_registration_source',
  webinarAttended:          'webinar_attended',
  timeWatchedMins:          'time_watched_mins',
  watchPercentage:          'watch_percentage',
  replayWatched:            'replay_watched',
  webinarNoShow:            'webinar_no_show',

  consultationBookedDate:   'consultation_booked_date',
  consultationDate:         'consultation_date',
  consultationPaid:         'consultation_paid',
  consultationAmount:       'consultation_amount',
  consultationStatus:       'consultation_status',
};
