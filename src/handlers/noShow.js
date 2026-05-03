import { normalizePayload, fetchRegistrantData, resolveWorkflows } from '../webinarjam.js';
import { findOrCreateContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleNoShow(client, raw) {
  console.log(`\n🚫 MISSED LIVE — ${client.slug}`);

  const pipeline = {
    kind: 'no_show',
    steps: [],
    apiEnrichment: null,
    contact: null,
    workflow: null,
    override: null,
  };

  const data = normalizePayload(raw);
  data.attended = false;
  data.noShow   = true;

  pipeline.steps.push({
    name: 'normalize_webhook', ok: true,
    output: {
      firstName: data.firstName, lastName: data.lastName,
      email: data.email, phone: data.phone,
      webinarId: data.webinarId, webinarName: data.webinarName,
    },
  });

  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);
  if (reg) {
    if (reg.platform)      data.webinarType   = reg.platform;
    data.replayWatched = reg.attendedReplay === 1;
    if (reg.scheduledDate) data.scheduledDate = reg.scheduledDate;
    if (reg.scheduledTime) data.scheduledTime = reg.scheduledTime;

    pipeline.apiEnrichment = reg;
    pipeline.steps.push({
      name: 'api_enrichment', ok: true,
      output: {
        platform: reg.platform,
        attendedLive: reg.attendedLive,
        attendedReplay: reg.attendedReplay,
      },
    });
  } else {
    pipeline.steps.push({
      name: 'api_enrichment', ok: false,
      message: client.webinarJamApiKey ? 'Registrant not found in WJ/EW API' : 'No WebinarJam API key configured',
    });
  }

  const workflows = resolveWorkflows(client, raw);
  pipeline.override = workflows.override ? {
    label: workflows.override.label,
    matchType: workflows.override.matchType,
    matchValue: workflows.override.matchValue,
  } : null;
  pipeline.steps.push({
    name: 'resolve_workflows', ok: true,
    output: { override: pipeline.override, noShow: workflows.noShow },
  });

  console.log(`   ${data.email}`);
  if (workflows.override) console.log(`   Override: ${workflows.override.label}`);

  // FIX: same as attendance — was findContactByEmail + bail. Now uses
  // smart resolver with phone fallback + create-if-missing.
  const { contact, action } = await findOrCreateContact(client, data);
  pipeline.contact = { id: contact.id, action };
  pipeline.steps.push({
    name: 'ghl_contact', ok: true,
    output: { contactId: contact.id, action },
  });

  if (workflows.noShow) {
    console.log(`🔀 Enrolling in no-show workflow: ${workflows.noShow}`);
    await enrollContactInWorkflow(client, contact.id, workflows.noShow);
    pipeline.workflow = workflows.noShow;
    pipeline.steps.push({
      name: 'ghl_workflow', ok: true,
      output: { workflowId: workflows.noShow },
    });
  } else {
    pipeline.steps.push({
      name: 'ghl_workflow', skipped: true,
      message: 'No no-show workflow configured',
    });
    console.log('ℹ️  No no-show workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
  return pipeline;
}

export async function handleReplayWatched(client, raw) {
  console.log(`\n▶️  ATTENDED REPLAY — ${client.slug}`);

  const pipeline = {
    kind: 'replay',
    steps: [],
    apiEnrichment: null,
    contact: null,
    workflow: null,
    override: null,
  };

  const data = normalizePayload(raw);
  data.replayWatched = true;

  pipeline.steps.push({
    name: 'normalize_webhook', ok: true,
    output: {
      firstName: data.firstName, lastName: data.lastName,
      email: data.email, phone: data.phone,
      webinarId: data.webinarId, webinarName: data.webinarName,
    },
  });

  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);
  if (reg) {
    if (reg.platform)       data.webinarType    = reg.platform;
    if (reg.scheduledDate)  data.scheduledDate  = reg.scheduledDate;
    if (reg.scheduledTime)  data.scheduledTime  = reg.scheduledTime;
    if (reg.timeReplayMins) data.timeWatched    = reg.timeReplayMins;

    pipeline.apiEnrichment = reg;
    pipeline.steps.push({
      name: 'api_enrichment', ok: true,
      output: {
        platform: reg.platform,
        attendedReplay: reg.attendedReplay,
        timeReplayMins: reg.timeReplayMins,
      },
    });
  } else {
    pipeline.steps.push({
      name: 'api_enrichment', ok: false,
      message: client.webinarJamApiKey ? 'Registrant not found in WJ/EW API' : 'No WebinarJam API key configured',
    });
  }

  const workflows = resolveWorkflows(client, raw);
  pipeline.override = workflows.override ? {
    label: workflows.override.label,
    matchType: workflows.override.matchType,
    matchValue: workflows.override.matchValue,
  } : null;
  pipeline.steps.push({
    name: 'resolve_workflows', ok: true,
    output: { override: pipeline.override, replay: workflows.replay },
  });

  console.log(`   ${data.email}`);
  if (workflows.override) console.log(`   Override: ${workflows.override.label}`);

  const { contact, action } = await findOrCreateContact(client, data);
  pipeline.contact = { id: contact.id, action };
  pipeline.steps.push({
    name: 'ghl_contact', ok: true,
    output: { contactId: contact.id, action },
  });

  if (workflows.replay) {
    console.log(`🔀 Enrolling in replay workflow: ${workflows.replay}`);
    await enrollContactInWorkflow(client, contact.id, workflows.replay);
    pipeline.workflow = workflows.replay;
    pipeline.steps.push({
      name: 'ghl_workflow', ok: true,
      output: { workflowId: workflows.replay },
    });
  } else {
    pipeline.steps.push({
      name: 'ghl_workflow', skipped: true,
      message: 'No replay workflow configured',
    });
    console.log('ℹ️  No replay workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
  return pipeline;
}
