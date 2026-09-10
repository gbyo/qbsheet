/**
 * Scoring-rules transport parity from the TypeScript side (#783).
 *
 * The golden corpus `apps/director/src-tauri/tests/parity/scoring-rules.json`
 * is generated from the canonical builder (`scoringRulesObject`) and consumed
 * by the native Rust conformance test as well. This file pins the canonical
 * side: every vector round-trips through the builder byte-identically, every
 * golden document is accepted by the scorer-side reader, and the corpus
 * exercises every competitive `TournamentRules` field so a new field fails
 * loudly instead of drifting one transport.
 */
import { describe, expect, it } from 'vitest';
import { defaultRules } from '@qbsheet/tournament-domain';
import { readQbjScoringRules } from '../../qbj/QbjScoringRules';
import corpus from '../../../apps/director/src-tauri/tests/parity/scoring-rules.json';
import { scoringRulesObject } from './assignment';
import { nonCompetitiveRulesFields } from './scoringRulesParityVectors';
import { assignmentFor, directorFixture } from './testFixtures';

interface CorpusVector {
  name: string;
  exercises: string[];
  rules: Parameters<typeof scoringRulesObject>[0];
  expected: Record<string, unknown>;
}

const vectors = (corpus as { vectors: CorpusVector[] }).vectors;

describe('scoring-rules parity corpus (canonical side)', () => {
  it('covers every required competitive vector', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    'canonical builder reproduces %s',
    (_name, vector) => {
      expect(scoringRulesObject(vector.rules, 'scoring-rules-parity')).toEqual(vector.expected);
    },
  );

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    'scorer reader accepts %s',
    (_name, vector) => {
      const read = readQbjScoringRules(
        vector.expected as Parameters<typeof readQbjScoringRules>[0],
        vector.rules.timed,
      );
      expect(read.ok).toBe(true);
    },
  );

  it('a file assignment for ACF no-powers omits Power and stamps the digest', () => {
    const state = directorFixture();
    if (!state.tournament) throw new Error('fixture: no tournament');
    state.tournament.rules = {
      ...defaultRules,
      superpowerValue: null,
      powerValue: null,
      negValue: -5,
      overtimeTossupCount: 1,
      overtimeBonuses: false,
    };
    const assignment = assignmentFor(state, 'game-5-1');
    const objects = assignment.document.objects as Array<Record<string, unknown>>;
    const scoring = objects.find((object) => object.type === 'ScoringRules');
    const answerIds = ((scoring?.answer_types ?? []) as Array<{ id?: unknown }>).map((entry) => entry.id);
    // The file path — the transport the native builder must match — offers no
    // power the definition does not have.
    expect(answerIds).toEqual(['answer-correct', 'answer-neg']);
    const match = objects.find((object) => object.type === 'Match') as
      { _qbtcp?: { definition_digest?: unknown; definition_revision?: unknown } } | undefined;
    expect(typeof match?._qbtcp?.definition_digest).toBe('string');
    expect(typeof match?._qbtcp?.definition_revision).toBe('number');
  });

  it('exercises every competitive TournamentRules field', () => {
    const covered = new Set(vectors.flatMap((vector) => vector.exercises));
    const ruleKeys = new Set(Object.keys(defaultRules));
    for (const field of Object.keys(nonCompetitiveRulesFields)) {
      expect(ruleKeys.has(field) || field === 'tiebreakerCountsStatistically').toBe(true);
    }
    const uncovered = [...ruleKeys].filter(
      (field) => !covered.has(field) && !(field in nonCompetitiveRulesFields),
    );
    expect(uncovered).toEqual([]);
    for (const field of covered) {
      expect(ruleKeys.has(field)).toBe(true);
    }
  });
});
