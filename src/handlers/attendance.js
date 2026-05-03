import { normalizePayload, fetchRegistrantData, resolveWorkflows } from '../webinarjam.js';
import { findOrCreateContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleAttendance(client, raw) {
  console.log(`\n👁️  ATTENDED LIVE — ${client.slug}`);

  const pipeline = {
    kind: 'attended',
    steps: [],
    apiEnrichment: null,
    contact: null,
    workflow: null,
    override: null,
  };

  const data = normalizePayload(raw);
  pipeline.steps.push({
    name: 'normalize_webhook', ok: true,
    output: {
      firstName: data.firstName, lastName: data.lastName,
      email: data.email, phone: data.phone,
      webinarId: data.webinarId, webinarName: data.webinarName,
    },
  });

  console.log('📡 Fetching attendance data from API...');
  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);

  if (reg) {
    if (reg.platform)       data.webinarType    = reg.platform;
    data.attended      = reg.attendedLive === 1;
    data.timeWatched   = reg.timeWatchedMins;
    data.replayWatched = reg.attendedReplay === 1;
    if (reg.liveRoomLink)   data.liveRoomLink   = reg.liveRoomLink;
    if (reg.replayRoomLink) data.replayRoomLink = reg.replayRoomLink;

    pipeline.apiEnrichment = reg;
    pipeline.steps.push({
      name: 'api_enrichment', ok: true,
      output: {
        platform: reg.platform,
        attendedLive: reg.attendedLive,
        timeWatchedMins: reg.timeWatchedMins,
        attendedReplay: reg.attendedReplay,
        dateLive: reg.dateLive,
      },
    });
  } else {
    data.attended    = true;
    data.timeWatched = undefined;
    pipeline.steps.push({
      name: 'api_enrichment', ok: false,
      message: client.webinarJamApiKey ? 'Registrant not found in WJ/EW API' : 'No WebinarJam API key configured',
    });
    console.warn('⚠️  API unavailable — marking attended from webhook');
  }

  const workflows = resolveWorkflows(client, raw);
  pipeline.override = workflows.override ? {
    label: workflows.override.label,
    matchType: workflows.override.matchType,
    matchValue: workflows.override.matchValue,
  } : null;
  pipeline.steps.push({
    name: 'resolve_workflows', ok: true,
    output: {
      override: pipeline.override,
      attended: workflows.attended,
    },
  });

  console.log(`   ${data.email}`);
  console.log(`   Attended     : ${data.attended}`);
  console.log(`   Time watched : ${data.timeWatched ?? 'pending'} mins`);
  if (workflows.override) console.log(`   Override: ${workflows.override.label}`);

  // FIX: was findContactByEmail + bail. Now uses smart resolver with phone
  // fallback, direct lookup endpoint, and create-if-missing. Solves the
  // "stuck in registered" bug where 69 attended events were lost because
  // GHL search index lag returned 0 hits.
  const { contact, action } = await findOrCreateContact(client, data);
  pipeline.contact = { id: contact.id, action };
  pipeline.steps.push({
    name: 'ghl_contact', ok: true,
    output: { contactId: contact.id, action },
  });

  if (workflows.attended) {
    console.log(`🔀 Enrolling in attended workflow: ${workflows.attended}`);
    await enrollContactInWorkflow(client, contact.id, workflows.attended);
    pipeline.workflow = workflows.attended;
    pipeline.steps.push({
      name: 'ghl_workflow', ok: true,
      output: { workflowId: workflows.attended },
    });
  } else {
    pipeline.steps.push({
      name: 'ghl_workflow', skipped: true,
      message: 'No attended workflow configured',
    });
    console.log('ℹ️  No attended workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
  return pipeline;
}
