import { describe, expect, test } from 'vitest';
import { recommendTournamentPlan } from './planning';

describe('recommendTournamentPlan', () => {
  test('too small a field yields no recommendation', () => {
    expect(recommendTournamentPlan(0)).toBeNull();
    expect(recommendTournamentPlan(1)).toBeNull();
  });

  test('ten teams get a full round robin with honest consequences', () => {
    const set = recommendTournamentPlan(10);
    expect(set?.recommended.id).toBe('full-round-robin');
    expect(set?.recommended.title).toBe('Full round robin');
    expect(set?.recommended.consequences).toContain('9 rounds · 9 games per team');
    expect(set?.recommended.consequences).toContain('Every team plays every other team once.');
    expect(set?.alternatives.map((plan) => plan.id)).toEqual(['double-round-robin', 'swiss', 'manual']);
  });

  test('odd small fields warn about byes', () => {
    const set = recommendTournamentPlan(9);
    expect(set?.recommended.id).toBe('full-round-robin');
    expect(set?.recommended.consequences).toContain('9 rounds · 8 games per team');
    expect(set?.recommended.consequences).toContain('One bye per round: each team sits out once.');
  });

  test('eighteen teams get pools into playoff divisions with planner consequences', () => {
    const set = recommendTournamentPlan(18);
    expect(set?.recommended.id).toBe('pools-playoffs');
    const consequences = set?.recommended.consequences.join(' ') ?? '';
    expect(consequences).toContain('3 pools of 6');
    expect(consequences).toContain('5 preliminary rounds');
    expect(consequences).toContain('3 playoff rounds');
    expect(consequences).toContain('5 preliminary games');
    expect(set?.recommended.poolPlan).toBeDefined();
    // The full round robin stays available as an alternative with its real cost attached.
    const full = set?.alternatives.find((plan) => plan.id === 'full-round-robin');
    expect(full?.consequences).toContain('17 rounds · 17 games per team');
  });
});
