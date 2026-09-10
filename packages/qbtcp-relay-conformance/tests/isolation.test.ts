/**
 * Scoring-budget isolation (#775): the recommended Internet QBTCP deployment must not share
 * its Cloudflare request budget — or its credential namespace — with spectator traffic.
 *
 * This is a static guard, not a runtime check. Workers Free allows 100,000 requests/day per
 * *account*: a busy QBLive spectator Worker in the same account draws from the same pool as
 * scoring, and when it is exhausted scoring stops with it. The recommended architecture is
 * scoring Worker/DO in one deployment and QBLive on self-hosted QBServer + Tunnel (see
 * #769). If someone later merges the two deployments, or points the relay docs at a shared
 * account, these tests fail before a tournament does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../../../', import.meta.url);

/** Wrangler configs are JSONC: `//` comments and trailing commas. Strip both. */
function readJsonc(relative: string): Record<string, unknown> {
  const text = readFileSync(new URL(relative, repoRoot), 'utf8');
  const withoutComments = text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

function readJson(relative: string): Record<string, unknown> {
  return readJsonc(relative);
}

function readText(relative: string): string {
  return readFileSync(new URL(relative, repoRoot), 'utf8');
}

describe('scoring and spectator deployments stay separate', () => {
  it('the QBTCP relay and QBLive are different Workers with different Durable Objects', () => {
    const relay = readJson('apps/qbtcp-relay-backend-cloudflare/wrangler.jsonc');
    const qblive = readJson('apps/qblive-backend-cloudflare/wrangler.jsonc');
    expect(relay.name).toBe('qbtcp-relay-backend');
    expect(qblive.name).toBe('qblive-backend');
    expect(relay.name).not.toBe(qblive.name);
    const relayBindings = (
      (relay.durable_objects as { bindings: { name: string; class_name: string }[] }).bindings ?? []
    ).map((binding) => `${binding.name}:${binding.class_name}`);
    const qbliveBindings = (
      (qblive.durable_objects as { bindings: { name: string; class_name: string }[] }).bindings ?? []
    ).map((binding) => `${binding.name}:${binding.class_name}`);
    expect(relayBindings).toContain('QBTCP_RELAY:QbtcpRelay');
    expect(qbliveBindings).toContain('QBLIVE_PUBLICATION:QblivePublication');
    expect(relayBindings.some((binding) => qbliveBindings.includes(binding))).toBe(false);
  });

  it('the relay deployment guide warns against sharing the scoring account with spectators', () => {
    const guide = readText('docs/QBTCP-RELAY-DEPLOY.md');
    expect(guide).toMatch(/same Workers Free request budget/i);
    expect(guide).toMatch(/QBLive/i);
    expect(guide).toMatch(/isolat/i);
  });

  it('the relay and QBLive name separate credential services', () => {
    const relaySource = readText('apps/director/src-tauri/src/relay.rs');
    expect(relaySource).toContain('com.qbsheet.director.qbtcp-relay');
    const liveSource = readText('apps/director/src-tauri/src/live.rs');
    expect(liveSource).toContain('com.qbsheet.director.qblive');
    expect(liveSource).not.toContain('com.qbsheet.director.qbtcp-relay');
  });
});
