/**
 * Corpus generator for the scoring-rules parity suite (#783). Run explicitly:
 *
 *   GENERATE_PARITY_CORPUS=1 npx vitest --run src/director/transfers/scoringRulesParity.generate.test.ts
 *
 * Regenerates `apps/director/src-tauri/tests/parity/scoring-rules.json` from
 * the canonical TypeScript builder. Review the diff before committing: these
 * bytes are the contract the native Rust builder must match.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoringRulesObject } from './assignment';
import { nonCompetitiveRulesFields, scoringRulesParityVectors } from './scoringRulesParityVectors';

export const parityCorpusId = 'scoring-rules-parity';

describe('scoring-rules parity corpus generator', () => {
  it('writes the golden corpus from the canonical builder', () => {
    if (process.env.GENERATE_PARITY_CORPUS !== '1') {
      console.log('Set GENERATE_PARITY_CORPUS=1 to regenerate the corpus.');
      return;
    }
    const vectors = scoringRulesParityVectors.map((vector) => ({
      name: vector.name,
      exercises: vector.exercises,
      rules: vector.rules,
      expected: scoringRulesObject(vector.rules, parityCorpusId),
    }));
    const corpus = {
      version: 1,
      note: 'Generated from the canonical TypeScript builder (scoringRulesObject). The native Rust builder (generated_scoring_rules) must emit semantically identical documents. Review diffs before committing.',
      nonCompetitiveFields: nonCompetitiveRulesFields,
      vectors,
    };
    const path = join(process.cwd(), 'apps/director/src-tauri/tests/parity/scoring-rules.json');
    writeFileSync(path, `${JSON.stringify(corpus, null, 2)}\n`);
    expect(vectors.length).toBeGreaterThan(0);
  });
});
