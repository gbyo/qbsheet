#!/usr/bin/env node
/**
 * Run the QBTCP relay conformance suite against a relay by base URL.
 *
 * Claim a fresh tournament with the deployment's one-time setup token:
 *
 *   node dist/cli.js --origin https://qbtcp-relay-backend.<subdomain>.workers.dev \
 *     --setup-token <token>
 *
 * Or check an already-claimed tournament:
 *
 *   node dist/cli.js --origin http://127.0.0.1:8787 \
 *     --tournament-id <id> --management-token <token>
 *
 * Exit 0 when the relay conforms, 1 when it does not, 2 on usage errors.
 */

import { formatReport, runRelayConformance } from './suite.js';

function usage(message: string): never {
  console.error(message);
  console.error('');
  console.error('Usage:');
  console.error('  qbtcp-relay-conformance --origin <url> --setup-token <token> [--tournament-id <id>]');
  console.error('  qbtcp-relay-conformance --origin <url> --tournament-id <id> --management-token <token>');
  process.exit(2);
}

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};

const origin = get('--origin');
const setupToken = get('--setup-token');
const tournamentId = get('--tournament-id');
const managementToken = get('--management-token');
const streamTimeoutMs = get('--stream-timeout-ms');

if (!origin) usage('Missing --origin.');
if (setupToken && managementToken) usage('Pass --setup-token or --management-token, not both.');
if (!setupToken && !(tournamentId && managementToken)) {
  usage('Without --setup-token, both --tournament-id and --management-token are required.');
}

try {
  const report = await runRelayConformance({
    origin,
    ...(tournamentId ? { tournamentId } : {}),
    ...(setupToken ? { setupToken } : {}),
    ...(managementToken ? { managementToken } : {}),
    ...(streamTimeoutMs ? { streamTimeoutMs: Number(streamTimeoutMs) } : {}),
  });
  console.log(formatReport(report));
  process.exit(report.conforming ? 0 : 1);
} catch (reason) {
  console.error(`Conformance failed to run: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
}
