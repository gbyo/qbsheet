/**
 * What the Game menu offers, and — more usefully — what it does not.
 *
 * These assertions were previously unreachable without rendering the entire scoresheet, because the
 * menu was composed inline in a 2,500-line component. That is the point of `scorerMenu` being a
 * function: "does a timed format that has already ended regulation still offer End regulation?" is
 * a question about the game, and it should be answerable by asking the game.
 *
 * The rule the whole file is really testing is the one stated at the top of `scorerMenu`: an action
 * the host cannot perform is absent, not disabled. A greyed entry a room can never use is an entry
 * it has to read past on every one of sixteen rounds.
 */
import { describe, expect, test, vi } from 'vitest';
import scorerMenuItems, { IScorerMenuInput } from '../src/scorer/scorerMenu';
import { IGameMenuItem } from '../src/scorer/GameMenu';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

function formatFor(ruleSet: CommonRuleSets): IScorekeeperFormat {
  const rules = new ScoringRules(ruleSet);
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

/**
 * The menu for a game, with everything the caller did not care about filled in.
 *
 * One builder, because a test that restates all twenty inputs to vary one of them is a test that
 * stops being read. `menu` is the label-only view of the same thing.
 */
function items(overrides: Partial<IScorerMenuInput> = {}, events: ScoreEvent[] = []): IGameMenuItem[] {
  const format = overrides.format ?? formatFor(CommonRuleSets.AcfPowers);
  const game = deriveGame(format, setup, events);
  return scorerMenuItems({
    game,
    format,
    phase: game.phase,
    procedure: undefined,
    currentQuestion: 1,
    lastPlayed: 0,
    keyboardEnabled: false,
    scoringView: 'scoresheet',
    submitting: false,
    canDownloadForms: false,
    canCorrectGame: false,
    openDialog: vi.fn(),
    setKeyboardEnabled: vi.fn(),
    setScoringView: vi.fn(),
    record: vi.fn().mockReturnValue(true),
    newEventId: () => 'id',
    openReview: vi.fn(),
    openReplacement: vi.fn(),
    downloadQbjBackup: vi.fn(),
    downloadPartialQbj: vi.fn(),
    downloadLegacyQbj: vi.fn(),
    print: vi.fn(),
    ...overrides,
  });
}

function menu(overrides: Partial<IScorerMenuInput> = {}, events: ScoreEvent[] = []): string[] {
  return items(overrides, events).map((item) => item.label);
}

describe('what every game gets', () => {
  test('the things that are always true of a scoresheet', () => {
    const labels = menu();
    expect(labels).toEqual(
      expect.arrayContaining([
        'Notes',
        'Game details',
        'Full scoresheet review',
        'Adjust score',
        'Download QBJ backup',
        'Recover from QBJ',
        'Print scoresheet',
      ]),
    );
  });

  test('the paper copy is offered to every game, because it is the fallback that needs nothing', () => {
    // Not conditional on a connection, a file, or a durable store: those are the things that fail.
    expect(menu({ canDownloadForms: false })).toContain('Print scoresheet');
  });

  test('keyboard scoring states which way it currently is', () => {
    expect(menu({ keyboardEnabled: false })).toContain('Keyboard scoring: off');
    expect(menu({ keyboardEnabled: true })).toContain('Keyboard scoring: on');
  });
});

describe('what depends on the format', () => {
  test('lightning appears only for a format that plays it', () => {
    const withoutLightning = formatFor(CommonRuleSets.AcfPowers);
    expect(menu({ format: withoutLightning })).not.toContain('Lightning / worksheet');
    expect(
      menu({
        format: { ...withoutLightning, lightning: { enabled: true, countPerTeam: 1, divisor: 10 } },
      }),
    ).toContain('Lightning / worksheet');
  });

  test('End regulation is for a timed round, and only until regulation is over', () => {
    const timed = formatFor(CommonRuleSets.NaqtTimed);
    expect(menu({ format: timed })).toContain('End regulation');
    expect(menu({ format: formatFor(CommonRuleSets.NaqtUntimed) })).not.toContain('End regulation');

    // Once the horn has gone, there is nothing left to end.
    const ended = [event({ type: 'end-regulation', questionNumber: 5, lastRegulationQuestion: 4 })];
    expect(menu({ format: timed }, ended)).not.toContain('End regulation');
  });

  test('a timeout is offered only by a procedure that has any', () => {
    expect(menu({ procedure: undefined })).not.toContain('Timeout');
    expect(menu({ procedure: { version: 1, halves: false, timeoutsPerTeam: 1 } })).toContain('Timeout');
    expect(menu({ procedure: { version: 1, halves: false, timeoutsPerTeam: 0 } })).not.toContain('Timeout');
  });
});

describe('what depends on the host, and is absent rather than disabled', () => {
  test('the mid-game QBJ forms belong to a host that can deliver them', () => {
    expect(menu({ canDownloadForms: false })).not.toContain('Download current QBJ');
    expect(menu({ canDownloadForms: true })).toContain('Download current QBJ');
    expect(menu({ canDownloadForms: true })).toContain('Download legacy match-only QBJ');
  });

  /*
   * Corrections to the game's own definition are not menu entries any more. They live beside the
   * thing they correct, in Game details -- which is one entry whether the host can persist a
   * correction or not, because reading what the game is configured for is always available.
   */
  test('correcting the game itself is reached through Game details rather than the menu', () => {
    expect(menu({ canCorrectGame: true })).not.toContain('Correct scoring rules…');
    expect(menu({ canCorrectGame: false })).toContain('Game details');
    expect(menu({ canCorrectGame: true })).toContain('Game details');
  });
});

describe('ending a game', () => {
  test('a game with nothing recorded cannot be ended early, only forfeited', () => {
    const labels = menu();
    expect(labels).not.toContain('End game early…');
    expect(labels).toContain('Record forfeit');
  });

  test('once a tossup has been read, ending early becomes possible', () => {
    const played = [event({ type: 'tossup-dead', questionNumber: 1 })];
    expect(menu({}, played)).toContain('End game early…');
  });

  test('both are marked destructive, so the menu can set them apart', () => {
    const built = items({ currentQuestion: 2, lastPlayed: 1 }, [
      event({ type: 'tossup-dead', questionNumber: 1 }),
    ]);
    const ending = built.filter(
      (item) => item.label === 'End game early…' || item.label === 'Record forfeit',
    );
    expect(ending).toHaveLength(2);
    ending.forEach((item) => expect(item.destructive).toBe(true));
  });
});

describe('while a result is being submitted', () => {
  test('everything that would change the game is unavailable, and the backup is not', () => {
    const built = items({ submitting: true, canCorrectGame: true });
    const by = (label: string) => built.find((item) => item.label === label);

    expect(by('Adjust score')?.disabled).toBe(true);
    expect(by('Notes')?.disabled).toBe(true);
    expect(by('Full scoresheet review')?.disabled).toBe(true);
    // Getting a copy off the device is never the dangerous operation.
    expect(by('Download QBJ backup')?.disabled).toBeUndefined();
    expect(by('Print scoresheet')?.disabled).toBeUndefined();
  });
});
