import { normalizePayload, fetchRegistrantData } from '../webinarjam.js';
import { upsertContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleRegistration(client, raw) {
  console.log(`\n📋 REGISTRATION — ${client.slug}`);

  const data = normalizePayload(raw);

  console.log('📡 Fetching registrant from API...');
  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);

  if (reg) {
    data.scheduledDate = reg.scheduledDate;
    data.scheduledTime = reg.scheduledTime;
    if (reg.registeredAt) data.registeredAt = reg.registeredAt;
    if (reg.liveRoomLink)   data.liveRoomLink   = reg.liveRoomLink;
    if (reg.replayRoomLink) data.replayRoomLink = reg.replayRoomLink;
  } else {
    const now = new Date();
    data.scheduledDate = now.toISOString().split('T')[0];
    data.scheduledTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    }) + ' ET';
    console.warn('⚠️  API unavailable — using current time as fallback');
  }

  console.log(`   ${data.firstName} ${data.lastName} <${data.email}>`);
  console.log(`   Phone   : ${data.phone}`);
  console.log(`   Session : ${data.scheduledDate} ${data.scheduledTime}`);

  const contact = await upsertContact(client, data);

  if (client.workflowRegistration) {
    console.log(`🔀 Enrolling in registration workflow: ${client.workflowRegistration}`);
    await enrollContactInWorkflow(client, contact.id, client.workflowRegistration);
  } else {
    console.log('ℹ️  No registration workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
}
