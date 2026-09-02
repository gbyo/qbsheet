/**
 * Generate the language-neutral QBLive fixtures.
 *
 * The fixtures are produced by the real projection from the real privacy fixture, so they are a
 * genuine snapshot rather than a hand-written approximation that could drift from what Director
 * actually publishes. TypeScript tests, the Cloudflare backend tests, the conformance suite and the
 * Swift test target all read these same files: that shared input is what keeps the three
 * implementations of the protocol from disagreeing.
 *
 * Run with `npm run fixtures --workspace=@qbsheet/qblive-protocol`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultLivePublicationSettings, closedLivePublicationSettings } from '@qbsheet/tournament-domain';
import { projectLiveSnapshot } from '@qbsheet/qblive-projection';
import { privacyFixture } from '@qbsheet/qblive-projection/fixture';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'fixtures');
mkdirSync(out, { recursive: true });

const capabilities = { snapshot: true, events: true, stream: true, applePush: false };
const generatedAt = new Date('2026-09-05T14:30:00.000Z');
const publicationId = 'bcdfghjkmnpqrstvwxyz';

function write(name, value) {
  writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote fixtures/${name}`);
}

const defaults = projectLiveSnapshot({
  state: privacyFixture(),
  settings: { ...defaultLivePublicationSettings(), enabled: true },
  publicationId,
  revision: 41,
  generatedAt,
  capabilities,
});
write('snapshot-default.json', defaults);

write(
  'snapshot-maximal.json',
  projectLiveSnapshot({
    state: privacyFixture(),
    settings: {
      ...defaultLivePublicationSettings(),
      enabled: true,
      playerNames: true,
      playerStatistics: true,
      liveScores: true,
      liveProgress: true,
    },
    publicationId,
    revision: 42,
    generatedAt,
    capabilities,
  }),
);

write(
  'snapshot-minimal.json',
  projectLiveSnapshot({
    state: privacyFixture(),
    settings: { ...closedLivePublicationSettings(), enabled: true, teamNames: true },
    publicationId,
    revision: 43,
    generatedAt,
    capabilities: { snapshot: true, events: false, stream: false, applePush: false },
  }),
);

write('manifest.json', {
  protocolVersion: 1,
  publicationId,
  revision: 41,
  generatedAt: generatedAt.toISOString(),
  tournament: defaults.tournament,
  capabilities,
  endpoints: {
    snapshot: `/qblive/v1/tournaments/${publicationId}/snapshot`,
    events: `/qblive/v1/tournaments/${publicationId}/events`,
    stream: `/qblive/v1/tournaments/${publicationId}/stream`,
  },
  final: false,
});

write('events.json', {
  protocolVersion: 1,
  publicationId,
  currentRevision: 43,
  resyncRequired: false,
  events: [
    {
      revision: 42,
      generatedAt: '2026-09-05T14:30:05.000Z',
      sections: { liveGames: defaults.liveGames },
    },
    {
      revision: 43,
      generatedAt: '2026-09-05T14:30:20.000Z',
      sections: { results: defaults.results, standings: defaults.standings },
    },
  ],
});

write('error.json', { error: 'conflict', message: 'The publication has moved on.', currentRevision: 44 });
