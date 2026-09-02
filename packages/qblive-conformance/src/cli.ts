/**
 * The conformance suite as a command.
 *
 * Deliberately usable against somebody else's server. QBLive is an open protocol, and a third-party
 * implementer needs a way to check their work that is not "read the reference implementation".
 */

import { formatReport, runConformance } from './suite.js';

interface Arguments {
  origin?: string;
  publication?: string;
  managementToken?: string;
  json?: boolean;
  skipLargeUpload?: boolean;
}

function parse(argv: string[]): Arguments {
  const args: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--origin':
        args.origin = value;
        index += 1;
        break;
      case '--publication':
        args.publication = value;
        index += 1;
        break;
      case '--management-token':
        args.managementToken = value;
        index += 1;
        break;
      case '--json':
        args.json = true;
        break;
      case '--skip-large-upload':
        args.skipLargeUpload = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const args = parse(process.argv.slice(2));

if (!args.origin || !args.publication) {
  console.error(
    [
      'Usage:',
      '  qblive-conformance --origin <url> --publication <id> [--management-token <token>]',
      '                     [--json] [--skip-large-upload]',
      '',
      'Without a management token the management checks that write are skipped, so this is safe',
      'to point at a tournament that is actually running.',
    ].join('\n'),
  );
  process.exit(2);
}

const report = await runConformance({
  origin: args.origin,
  publicationId: args.publication,
  managementToken: args.managementToken,
  skipLargeUpload: args.skipLargeUpload,
});

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatReport(report));
}

// Non-zero when a check failed, so this is usable as a CI gate.
process.exit(report.failed > 0 ? 1 : 0);
