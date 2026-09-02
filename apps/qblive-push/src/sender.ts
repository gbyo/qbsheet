/**
 * The Queue consumer's work: turning a push job into APNs requests.
 *
 * Everything that talks to Apple goes through here. That is what absorbs a tournament burst — a
 * round ending puts a dozen shard updates in the queue at once, and they drain at a controlled
 * concurrency rather than opening a dozen simultaneous APNs connections from a dozen isolates.
 */

import {
  broadcastPayload,
  BROADCAST_PAYLOAD_LIMIT,
  isRetryable,
  payloadBytes,
  sendBroadcast,
  sendNotification,
  tokenIsDead,
  type ApnsEnvironment,
} from './apns';
import { providerToken, rotateProviderToken } from './credential';
import { shardStateHash, type PushPublication } from './publication';
import type { PushJob } from './types';

export interface JobOutcome {
  retry: boolean;
  detail: string;
}

function environmentOf(env: Env): ApnsEnvironment {
  return env.APNS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
}

function stubFor(env: Env, publicationId: string): DurableObjectStub<PushPublication> {
  return env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
}

export async function handlePushJob(job: PushJob, env: Env): Promise<JobOutcome> {
  if (!env.APNS_PRIVATE_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    // Not retryable: no amount of waiting configures a secret. Dropped rather than spun on.
    return { retry: false, detail: 'this push gateway has no APNs credential configured' };
  }
  switch (job.kind) {
    case 'shard':
      return sendShard(job, env);
    case 'announcement':
      return sendAnnouncement(job, env);
    case 'end':
      return endPublication(job, env);
  }
}

async function sendShard(job: Extract<PushJob, { kind: 'shard' }>, env: Env): Promise<JobOutcome> {
  const stub = stubFor(env, job.publicationId);
  const channelId = await stub.channelId(job.shard);
  if (!channelId) {
    // The channel went away between enqueueing and draining — the publication ended, or its
    // channels were reclaimed. Nothing to send and nothing to retry.
    return { retry: false, detail: 'no channel for that shard' };
  }

  const body = broadcastPayload({
    state: job.state,
    event: 'update',
    timestamp: Math.floor(Date.now() / 1000),
  });
  const bytes = payloadBytes(body);
  if (bytes > BROADCAST_PAYLOAD_LIMIT) {
    // Apple rejects the whole request, which during a tournament would look like the Lock Screen
    // silently freezing. Dropping one update with a recorded reason is the better failure, and the
    // shard size is chosen from measurement precisely so this does not happen — see
    // docs/QBLIVE_ACTIVITY.md.
    return { retry: false, detail: `payload ${bytes} bytes exceeds Apple's ${BROADCAST_PAYLOAD_LIMIT}` };
  }

  const outcome = await sendBroadcast({
    environment: environmentOf(env),
    bundleId: env.APNS_BUNDLE_ID ?? 'com.qbsheet.live',
    providerToken: await providerToken(env),
    channelId,
    body,
    // A score change is routine and gets priority 5, which lets Apple deliver it with the device's
    // power state in mind. Only a real transition — a game starting, a game going final — is worth
    // waking a phone for.
    priority: job.urgency === 'transition' ? 10 : 5,
    // Non-zero, because the channel uses MostRecentMessageStored: a phone that was in a pocket
    // should come back to the current score rather than to nothing. One hour.
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });

  if (outcome.ok) {
    await stub.recordSend(job.shard, shardStateHash(job.state), job.state.r);
    return { retry: false, detail: `sent ${bytes} bytes` };
  }
  if (outcome.status === 403 && outcome.reason === 'ExpiredProviderToken') {
    await rotateProviderToken(env);
    return { retry: true, detail: 'provider token expired; rotated' };
  }
  return {
    retry: isRetryable(outcome),
    detail: outcome.transportError ?? `${outcome.status} ${outcome.reason ?? ''}`.trim(),
  };
}

async function sendAnnouncement(
  job: Extract<PushJob, { kind: 'announcement' }>,
  env: Env,
): Promise<JobOutcome> {
  const stub = stubFor(env, job.publicationId);
  const devices = await stub.audience(job.audienceTeamIds);
  if (devices.length === 0) return { retry: false, detail: 'no registered devices for that audience' };

  const token = await providerToken(env);
  const environment = environmentOf(env);
  let sent = 0;
  let dead = 0;
  let retryable = 0;

  for (const device of devices) {
    const outcome = await sendNotification({
      environment,
      // An App Clip is a different APNs topic from the full app. Sending to the wrong one is a
      // silent no-delivery, which is the hardest kind of push bug to notice.
      bundleId:
        device.clientKind === 'app-clip'
          ? (env.APNS_CLIP_BUNDLE_ID ?? 'com.qbsheet.live.Clip')
          : (env.APNS_BUNDLE_ID ?? 'com.qbsheet.live'),
      providerToken: token,
      deviceToken: device.deviceToken,
      title: job.title,
      body: job.body,
      // Only an urgent announcement interrupts. A tournament that made every update
      // time-sensitive would train everybody to silence it before the one that mattered.
      interruptionLevel:
        job.severity === 'urgent' ? 'time-sensitive' : job.severity === 'important' ? 'active' : 'passive',
      publicationId: job.publicationId,
    });
    if (outcome.ok) {
      sent += 1;
      continue;
    }
    if (tokenIsDead(outcome)) {
      // Apple will never accept this token again. Keeping it would mean spending part of every
      // future announcement on a phone that has been wiped.
      await stub.forgetDevice(device.deviceToken);
      dead += 1;
      continue;
    }
    if (outcome.status === 403 && outcome.reason === 'ExpiredProviderToken') {
      await rotateProviderToken(env);
      return { retry: true, detail: 'provider token expired mid-fanout; rotated' };
    }
    if (isRetryable(outcome)) retryable += 1;
  }

  // Retried only if something transient happened. A partial success with dead tokens is complete:
  // retrying would re-notify the phones that already got it.
  return {
    retry: retryable > 0 && sent === 0,
    detail: `sent ${sent}, dropped ${dead} dead tokens, ${retryable} transient failures`,
  };
}

async function endPublication(job: Extract<PushJob, { kind: 'end' }>, env: Env): Promise<JobOutcome> {
  const stub = stubFor(env, job.publicationId);
  const result = await stub.end();
  // Retried while any channel deletion failed. A channel that is never deleted counts against
  // Apple's global ceiling forever, which is how a push service quietly runs out.
  return {
    retry: result.failed > 0,
    detail: `deleted ${result.deleted} channels, ${result.failed} failed`,
  };
}
