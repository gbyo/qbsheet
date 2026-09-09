import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { format } from 'prettier';

const files = [
  '../tournament-domain/src/reportRanks.ts',
  'src/standingsReport.ts',
  'src/stageAwareStandingsReport.ts',
  'tests/standingsReport.test.ts',
  '../../src/director/reports/standingsReport.ts',
  '../../src/director/reports/standingsReport.test.ts',
  '../../src/director/reports/statReportExport.ts',
  '../../src/director/reports/statReportExport.test.ts',
];

describe('standings report formatting oracle', () => {
  test('prints canonical Prettier output', async () => {
    for (const path of files) {
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
