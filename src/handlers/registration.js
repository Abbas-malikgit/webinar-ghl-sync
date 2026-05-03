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
  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);

  if (reg) {
    if (reg.platform)       data.webinarType = reg.platform;
    data.scheduledDate = reg.scheduledDate;
    data.scheduledTime = reg.scheduledTime;
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
    const now = new Date();
    data.scheduledDate = now.toISOString().split('T')[0];
    data.scheduledTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    }) + ' ET';
    pipeline.steps.push({
      name: 'api_enrichment', ok: false,
      message: client.webinarJamApiKey ? 'Registrant not found in WJ/EW API' : 'No WebinarJam API key configured',
    });
    console.warn('⚠️  API unavailable — using current time as fallback');
  }

  // Resolve which workflow to use — checks per-webinar overrides first
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
      registration: workflows.registration,
      attended:     workflows.attended,
      noShow:       workflows.noShow,
      replay:       workflows.replay,
    },
  });

  console.log(`   ${data.firstName} ${data.lastName} <${data.email}>`);
  console.log(`   Phone   : ${data.phone}`);
  console.log(`   Session : ${data.scheduledDate} ${data.scheduledTime}`);
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
