import { normalizePayload, fetchRegistrantData } from '../webinarjam.js';
import { findContactByEmail, updateContact, upsertContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleNoShow(client, raw) {
  console.log(`\n🚫 MISSED LIVE — ${client.slug}`);

  const data = normalizePayload(raw);
  data.attended = false;
  data.noShow   = true;

  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);
  if (reg) {
    data.replayWatched  = reg.attendedReplay === 1;
    if (reg.scheduledDate) data.scheduledDate = reg.scheduledDate;
    if (reg.scheduledTime) data.scheduledTime = reg.scheduledTime;
  }

  console.log(`   ${data.email}`);

  const contact = await findContactByEmail(client, data.email);
  if (!contact) {
    console.warn(`⚠️  Contact not found — skipping`);
    return;
  }

  await updateContact(client, contact.id, data);

  if (client.workflowNoShow) {
    console.log(`🔀 Enrolling in no-show workflow: ${client.workflowNoShow}`);
    await enrollContactInWorkflow(client, contact.id, client.workflowNoShow);
  } else {
    console.log('ℹ️  No no-show workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
}

export async function handleReplayWatched(client, raw) {
  console.log(`\n▶️  ATTENDED REPLAY — ${client.slug}`);

  const data = normalizePayload(raw);
  data.replayWatched = true;

  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);
  if (reg) {
    if (reg.scheduledDate)  data.scheduledDate  = reg.scheduledDate;
    if (reg.scheduledTime)  data.scheduledTime  = reg.scheduledTime;
    if (reg.timeReplayMins) data.timeWatched    = reg.timeReplayMins;
  }

  console.log(`   ${data.email}`);

  let contact = await findContactByEmail(client, data.email);
  if (!contact) {
    console.log('   Contact not found — creating from replay data');
    contact = await upsertContact(client, data);
  } else {
    await updateContact(client, contact.id, data);
  }

  if (client.workflowReplay) {
    console.log(`🔀 Enrolling in replay workflow: ${client.workflowReplay}`);
    await enrollContactInWorkflow(client, contact.id, client.workflowReplay);
  } else {
    console.log('ℹ️  No replay workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
}
