/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  discoverSecret,
  loadSecrets,
  logoClickSequence,
  matchSecretCommand,
  secretStorageKey,
} from '../src/scorer/secrets/secretState';
import { advanceDvd } from '../src/scorer/secrets/dvdPhysics';
import { keystrokeBelongsToControl } from '../src/scorer/KeyboardScoring';
import { isPowerResult } from '../src/scorer/secrets/useScorerReactions';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import type { ScoreEvent } from '../src/scoring/ScoreEvents';

describe('scorer secrets stay local and deterministic', () => {
  beforeEach(() => localStorage.clear());

  test('logo unlock needs seven clicks in one rolling eight-second window', () => {
    let clicks: number[] = [];
    for (let index = 0; index < 6; index += 1) clicks = logoClickSequence(clicks, index * 1000).clicks;
    expect(logoClickSequence(clicks, 6000).unlocked).toBe(true);
    expect(logoClickSequence(clicks, 14001).unlocked).toBe(false);
  });

  test('discovers each secret once and persists outside game data', () => {
    const once = discoverSecret('dvd', []);
    const twice = discoverSecret('dvd', once);
    expect(twice).toEqual(['dvd']);
    expect(loadSecrets()).toEqual(['dvd']);
    expect(JSON.parse(localStorage.getItem(secretStorageKey) ?? '[]')).toEqual(['dvd']);
  });

  test.each(['dvd', 'snake', 'qbbird', 'stats'] as const)('matches the %s command', (command) => {
    expect(matchSecretCommand(` ${command.toUpperCase()} `)).toBe(command);
  });

  test('a typing control owns question mark', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(keystrokeBelongsToControl(new KeyboardEvent('keydown', { key: '?' }))).toBe(true);
    input.remove();
  });

  test('DVD physics enters, exits, and identifies a mathematical corner collision', () => {
    const middle = advanceDvd({ x: 10, y: 10, vx: 10, vy: 10 }, 100, 100, 0.1);
    expect(middle.collisions).toBe(0);
    const corner = advanceDvd({ x: 99.6, y: 99.6, vx: 10, vy: 10 }, 100, 100, 0.041);
    expect(corner.corner).toBe(true);
    expect(corner.position.vx).toBe(-10);
    expect(corner.position.vy).toBe(-10);
  });

  test('only an actual +15 power triggers lightning', () => {
    const rules = new ScoringRules(CommonRuleSets.AcfPowers);
    const format = scoringRulesToScorekeeperFormat(rules);
    const event = (index: number): ScoreEvent => ({
      id: `event-${index}`,
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Player',
      answerTypeIndex: index,
    });
    const power = format.answerTypes.find((answer) => answer.value === 15 && answer.isPower);
    const ten = format.answerTypes.find((answer) => answer.value === 10);
    const neg = format.answerTypes.find((answer) => answer.value === -5);
    expect(power && isPowerResult(event(power.index), format)).toBe(true);
    expect(ten && isPowerResult(event(ten.index), format)).toBe(false);
    expect(neg && isPowerResult(event(neg.index), format)).toBe(false);
  });
});
