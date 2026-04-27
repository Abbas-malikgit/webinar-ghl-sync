import { normalizePayload, fetchRegistrantData } from '../webinarjam.js';
import { findContactByEmail, updateContact, enrollContactInWorkflow } from '../ghl.js';

export async function handleAttendance(client, raw) {
  console.log(`\n👁️  ATTENDED LIVE — ${client.slug}`);

  const data = normalizePayload(raw);

  console.log('📡 Fetching attendance data from API...');
  const reg = await fetchRegistrantData(client.webinarJamApiKey, data.webinarName, data.email);

  if (reg) {
    if (reg.platform)       data.webinarType   = reg.platform;
    data.attended      = reg.attendedLive === 1;
    data.timeWatched   = reg.timeWatchedMins;
    data.replayWatched = reg.attendedReplay === 1;
    if (reg.liveRoomLink)   data.liveRoomLink   = reg.liveRoomLink;
    if (reg.replayRoomLink) data.replayRoomLink = reg.replayRoomLink;
  } else {
    data.attended    = true;
    data.timeWatched = undefined;
    console.warn('⚠️  API unavailable — marking attended from webhook');
  }

  console.log(`   ${data.email}`);
  console.log(`   Attended     : ${data.attended}`);
  console.log(`   Time watched : ${data.timeWatched ?? 'pending'} mins`);

  const contact = await findContactByEmail(client, data.email);
  if (!contact) {
    console.warn(`⚠️  Contact not found — skipping`);
    return;
  }

  await updateContact(client, contact.id, data);

  if (client.workflowAttended) {
    console.log(`🔀 Enrolling in attended workflow: ${client.workflowAttended}`);
    await enrollContactInWorkflow(client, contact.id, client.workflowAttended);
  } else {
    console.log('ℹ️  No attended workflow configured — skipping enrollment');
  }

  console.log(`✅ Done — ${data.email}`);
}
