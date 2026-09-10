import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const srcDir = new URL('../src/', import.meta.url);

describe('dependency boundaries', () => {
  it('no shared module imports provider code, so protocols stay portable', () => {
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(new URL(file, srcDir), 'utf8');
      expect(text).not.toMatch(/from\s+['"]cloudflare:/);
      expect(text).not.toMatch(/require\(\s*['"]cloudflare:/);
    }
  });

  it('no shared module names a product table, route, or role in code', () => {
    // Comments may explain the boundary in product terms; identifiers may not depend
    // on it. Strip comments first so documentation wording cannot trip the guard.
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const productWords = /(qbtcp|qblive|collab|tournament|room_token|match_teams)/i;
    for (const file of ['credentials.ts', 'replay.ts', 'sqlite.ts', 'migrations.ts', 'websocket.ts']) {
      const text = readFileSync(new URL(file, srcDir), 'utf8');
      expect(stripComments(text)).not.toMatch(productWords);
    }
  });
});
