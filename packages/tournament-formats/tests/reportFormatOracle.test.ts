import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { format } from 'prettier';

describe('report formatting oracle', () => {
  test('prints canonical Prettier output for report files', async () => {
    for (const path of ['src/boxScoreReport.ts', 'tests/boxScoreReport.test.ts']) {
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
