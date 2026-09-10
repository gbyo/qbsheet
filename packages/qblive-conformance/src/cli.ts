/**
 * The conformance suite as a command.
 *
 * Deliberately usable against somebody else's server. QBLive is an open protocol, and a third-party
 * implementer needs a way to check their work that is not "read the reference implementation".
 */

import { readFileSync } from 'node:fs';
import { formatReport, runConformance, type ConformanceProfile } from './suite.js';
import { setupBackend } from './setup.js';

interface Arguments {
  origin?: string;
  publication?: string;
  managementToken?: string;
  setupToken?: string;
  initialSnapshot?: string;
  profile?: ConformanceProfile;
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
      case '--setup-token':
        args.setupToken = value;
        index += 1;
        break;
      case '--initial-snapshot':
        args.initialSnapshot = value;
        index += 1;
        break;
      case '--profile':
        if (value === 'full' || value === 'local' || value === 'basic') args.profile = value;
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
      '                     [--setup-token <secret> [--initial-snapshot <path>]]',
      '                     [--profile full|local|basic] [--json] [--skip-large-upload]',
      '',
      'Without a management token the management checks that write are skipped, so this is safe',
      'to point at a tournament that is actually running.',
      '',
      'With --setup-token the CLI claims the publication first via the standard',
      'setup/claim hook, so the same command tests a fresh Cloudflare backend,',
      'a standalone QBServer, or any third-party host. --initial-snapshot',
      'publishes a JSON snapshot after claiming. --profile local tests',
      'Director local-only mode without pretending it is a full backend.',
    ].join('\n'),
  );
  process.exit(2);
}

let managementToken = args.managementToken;
if (!managementToken && args.setupToken) {
  const initialSnapshot = args.initialSnapshot
    ? JSON.parse(readFileSync(args.initialSnapshot, 'utf8'))
    : undefined;
  const setup = await setupBackend({
    origin: args.origin,
    setupToken: args.setupToken,
    publicationId: args.publication,
    initialSnapshot: initialSnapshot?.snapshot ?? initialSnapshot,
  });
  managementToken = setup.managementToken;
}

const report = await runConformance({
  origin: args.origin,
  publicationId: args.publication,
  managementToken,
  skipLargeUpload: args.skipLargeUpload,
  profile: args.profile,
});

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatReport(report));
}

// Non-zero when a check failed, so this is usable as a CI gate.
process.exit(report.failed > 0 ? 1 : 0);
