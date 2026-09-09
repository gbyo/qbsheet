import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { format } from 'prettier';

describe('team report formatting oracle', () => {
  test('prints canonical Prettier output', async () => {
    for (const path of ['src/teamDetailReport.ts', 'tests/teamDetailReport.test.ts']) {
      const source = await readFile(path, 'utf8');
      const formatted = await format(source, {
        filepath: path,
        printWidth: 110,
        singleQuote: true,
        trailingComma: 'all',
        arrowParens: 'always',
      });
      console.log(`FORMAT_ORACLE_START ${path}\n${formatted}FORMAT_ORACLE_END ${path}`);
    }
    expect(false).toBe(true);
  });
});
