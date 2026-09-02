/**
 * The load harness as a command. Deliberately not part of ordinary CI; see `./harness.ts`.
 */

import { formatLoadReport, modelChannelUsage, runLoadTest } from './harness.js';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

if (argv.includes('--channels')) {
  // The APNs channel model. No network, no server: arithmetic over the sharding rules.
  const scenarios = [
    { label: 'One 64-team tournament, 20% adoption', tournaments: [{ teams: 64, adoption: 0.2 }] },
    { label: 'One 64-team tournament, 100% adoption', tournaments: [{ teams: 64, adoption: 1 }] },
    {
      label: 'A busy Saturday: 40 tournaments averaging 32 teams, 30% adoption',
      tournaments: Array.from({ length: 40 }, () => ({ teams: 32, adoption: 0.3 })),
    },
    {
      label: 'An implausible Saturday: 500 tournaments averaging 48 teams, 50% adoption',
      tournaments: Array.from({ length: 500 }, () => ({ teams: 48, adoption: 0.5 })),
    },
  ];
  for (const scenario of scenarios) {
    const report = modelChannelUsage(scenario.tournaments);
    console.log(`\n${scenario.label}`);
    console.log(`  teams                       ${report.teams}`);
    console.log(`  channels if one per team    ${report.naiveChannels}`);
    console.log(`  channels if shards eager    ${report.eagerChannels}`);
    console.log(`  channels with lazy creation ${report.lazyChannels}`);
    console.log(
      `  against QBSheet's ceiling   ${report.ceiling} — ${report.withinBudget ? 'within budget' : 'OVER BUDGET'}`,
    );
  }
  console.log('');
  process.exit(0);
}

const origin = flag('origin');
const publication = flag('publication');
if (!origin || !publication) {
  console.error(
    [
      'Usage:',
      '  qblive-load --origin <url> --publication <id> [--viewers 300] [--seconds 60]',
      '              [--management-token <token>] [--update-ms 3000]',
      '  qblive-load --channels        model APNs channel consumption, no network',
    ].join('\n'),
  );
  process.exit(2);
}

const report = await runLoadTest({
  origin,
  publicationId: publication,
  viewers: Number(flag('viewers') ?? 100),
  seconds: Number(flag('seconds') ?? 30),
  updateIntervalMs: Number(flag('update-ms') ?? 3000),
  managementToken: flag('management-token'),
  onProgress: (line) => console.log(line),
});

console.log(formatLoadReport(report));
process.exit(report.failedToConnect > 0 || report.deliveryRatio < 0.99 ? 1 : 0);
