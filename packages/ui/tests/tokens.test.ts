import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const packageRoot = process.cwd();
const tokens = readFileSync(join(packageRoot, 'src/tokens.css'), 'utf8');
const roomCompat = readFileSync(join(packageRoot, 'src/room-compat.css'), 'utf8');

function declarations(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').trim(),
    ]),
  );
}

function selectorBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} should exist`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('\n}', bodyStart);
  return css.slice(bodyStart, end);
}

describe('Scorer-derived design tokens', () => {
  test('keeps the established Scorer light palette as the canonical values', () => {
    const light = declarations(selectorBlock(tokens, ':root'));

    expect(light.get('--qbs-font-sans')).toContain("'IBM Plex Sans'");
    expect(light.get('--qbs-text')).toBe('#1c1d20');
    expect(light.get('--qbs-text-muted')).toBe('#5c6066');
    expect(light.get('--qbs-surface')).toBe('#ffffff');
    expect(light.get('--qbs-surface-sunken')).toBe('#f6f7f8');
    expect(light.get('--qbs-border')).toBe('#d8dade');
    expect(light.get('--qbs-accent')).toBe('#1565c0');
    expect(light.get('--qbs-success-fg')).toBe('#1e6b32');
    expect(light.get('--qbs-warning-fg')).toBe('#8a5300');
    expect(light.get('--qbs-danger-fg')).toBe('#a8231b');
  });

  test('uses identical overrides for system-dark and explicit-dark appearances', () => {
    const systemDark = declarations(selectorBlock(tokens, ":root:not([data-theme='light'])"));
    const explicitDark = declarations(selectorBlock(tokens, ":root[data-theme='dark']"));

    expect(Object.fromEntries(systemDark)).toEqual(Object.fromEntries(explicitDark));
    expect(systemDark.get('--qbs-text')).toBe('#e7e9ec');
    expect(systemDark.get('--qbs-surface')).toBe('#16171a');
    expect(systemDark.get('--qbs-accent')).toBe('#7ab3ee');
  });

  test('keeps the Scorer compatibility layer alias-only', () => {
    const aliases = declarations(selectorBlock(roomCompat, ':root'));

    expect(aliases.get('--room-text')).toBe('var(--qbs-text)');
    expect(aliases.get('--room-accent')).toBe('var(--qbs-accent)');
    expect(aliases.get('--room-error-bg')).toBe('var(--qbs-danger-bg)');
    expect(aliases.get('--room-motion-standard')).toBe('var(--qbs-duration)');
    expect([...aliases.values()].every((value) => /^var\(--qbs-[\w-]+\)$/.test(value))).toBe(true);
    expect(roomCompat).not.toMatch(/#[0-9a-f]{3,8}\b|\brgb\(/i);
  });
});

describe('Scorer token ownership', () => {
  test.each(['app-shell.css', 'recovery.css', 'motion.css'])(
    '%s no longer owns room token values',
    (file) => {
      const css = readFileSync(join(packageRoot, '../../src/app', file), 'utf8');
      expect(css).not.toMatch(/--room-[\w-]+\s*:/);
    },
  );

  test('Recovery Mode loads only the CSS compatibility entry point', () => {
    const css = readFileSync(join(packageRoot, '../../src/app/recovery.css'), 'utf8');
    expect(css).toContain("@import '@qbsheet/ui/room-compat.css';");
    expect(css).not.toContain('@qbsheet/ui/components.css');
  });
});
