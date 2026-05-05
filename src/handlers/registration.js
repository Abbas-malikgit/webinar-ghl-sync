import { normalizePayload, fetchRegistrantData, resolveWorkflows } from '../webinarjam.js';
import { findOrCreateContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleRegistration(client, raw) {
  console.log(`\n📋 REGISTRATION — ${client.slug}`);

  const pipeline = {
    kind: 'registration',
    steps: [],
    apiEnrichment: null,
    contact: null,
    workflow: null,
    override: null,
  };

  const data = normalizePayload(raw);
  pipeline.steps.push({
    name: 'normalize_webhook',
    ok: true,
    output: {
      firstName: data.firstName, lastName: data.lastName,
      email: data.email, phone: data.phone,
      webinarId: data.webinarId, webinarName: data.webinarName,
      liveRoomLink: data.liveRoomLink, replayRoomLink: data.replayRoomLink,
    },
  });

  console.log('📡 Fetching registrant from API...');
  // Pass the webinar ref object — id is preferred over name
  const reg = await fetchRegistrantData(
    client.webinarJamApiKey,
    { id: data.webinarId, name: data.webinarName },
    data.email
  );

  if (reg) {
    if (reg.platform)       data.webinarType = reg.platform;
    if (reg.scheduledDate)  data.scheduledDate = reg.scheduledDate;
    if (reg.scheduledTime)  data.scheduledTime = reg.scheduledTime;
    // Client-level override takes priority — EverWebinar's w.timezone is the
    // webinar owner's account timezone, but reg.event times for JIT sessions
    // are returned in the registrant's local timezone. If those don't match,
    // set webinarEventTimezone on the client to the actual source timezone
    // (e.g. "Asia/Karachi") so the EST conversion is correct.
    const sourceTimezone = client.webinarEventTimezone || reg.webinarTimezone;
    if (sourceTimezone) data.webinarTimezone = sourceTimezone;
    if (reg.registeredAt)   data.registeredAt   = reg.registeredAt;
    if (reg.liveRoomLink)   data.liveRoomLink   = reg.liveRoomLink;
    if (reg.replayRoomLink) data.replayRoomLink = reg.replayRoomLink;

    pipeline.apiEnrichment = reg;
    pipeline.steps.push({
      name: 'api_enrichment', ok: true,
      output: {
        platform: reg.platform,
        scheduledDate: reg.scheduledDate,
        scheduledTime: reg.scheduledTime,
        registeredAt: reg.registeredAt,
      },
    });
  } else {
    // No fake fallback! We previously wrote today's wall-clock time into
    // `scheduledDate` / `scheduledTime` which silently produced misleading
    // data in GHL ("Webinar Date: today" even when there was no real session).
    // Better to leave those fields empty so workflows can detect the missing
    // value and the GHL contact's "Webinar Date" stays blank rather than wrong.
    //
    // We DO still record the registration date — that's just "now" and is
    // unambiguously correct because the webhook just arrived.
    data.scheduledDate = '';
    data.scheduledTime = '';
    data.webinarType   = 'Unknown';   // explicit — was already the default

    pipeline.steps.push({
      name: 'api_enrichment', ok: false,
      message: client.webinarJamApiKey
        ? 'Registrant not found in WJ/EW API — webinar date/time fields will be left blank'
        : 'No WebinarJam API key configured',
    });
    console.warn('⚠️  API enrichment failed — leaving webinar date/time fields blank (no fake fallback)');
  }

  // Resolve which workflow to use — checks per-webinar overrides first.
  // Pass `reg` (the API enrichment) so schedule-specific overrides can match.
  const workflows = resolveWorkflows(client, raw, reg);
  pipeline.override = workflows.override ? {
    label: workflows.override.label,
    matchType: workflows.override.matchType,
    matchValue: workflows.override.matchValue,
  } : null;
  pipeline.steps.push({
    name: 'resolve_workflows', ok: true,
    output: {
      override: pipeline.override,
      registration: workflows.registration,
      attended:     workflows.attended,
      noShow:       workflows.noShow,
      replay:       workflows.replay,
    },
  });

  console.log(`   ${data.firstName} ${data.lastName} <${data.email}>`);
  console.log(`   Phone   : ${data.phone}`);
  console.log(`   Session : ${data.scheduledDate || '(blank)'} ${data.scheduledTime || ''}`);
  if (workflows.override) console.log(`   Override: ${workflows.override.label}`);

  const { contact, action } = await findOrCreateContact(client, data);
  pipeline.contact = { id: contact.id, action };
  pipeline.steps.push({
    name: 'ghl_contact', ok: true,
    output: { contactId: contact.id, action },
  });

  if (workflows.registration) {
    console.log(`🔀 Enrolling in registration workflow: ${workflows.registration}`);
    await enrollContactInWorkflow(client, contact.id, workflows.registration);
    pipeline.workflow = workflows.registration;
    pipeline.steps.push({
      name: 'ghl_workflow', ok: true,
      output: { workflowId: workflows.registration },
    });
  } else {
    pipeline.steps.push({
      name: 'ghl_workflow', skipped: true,
      message: 'No registration workflow configured',
    });
    console.log('ℹ️  No registration workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
  return pipeline;
}
