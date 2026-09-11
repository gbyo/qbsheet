import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import scorerMenuItems from '../src/scorer/scorerMenu';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

function activeGameMenu(tournamentControlled = false): string[] {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  const format = scoringRulesToScorekeeperFormat(rules);
  const game = deriveGame(format, setup, []);
  return scorerMenuItems({
    game,
    format,
    phase: game.phase,
    procedure: undefined,
    currentQuestion: 1,
    lastPlayed: 0,
    keyboardEnabled: false,
    submitting: false,
    canDownloadForms: false,
    canCorrectGame: false,
    tournamentControlled,
    openDialog: vi.fn(),
    setKeyboardEnabled: vi.fn(),
    record: vi.fn().mockReturnValue(true),
    newEventId: () => 'id',
    openReview: vi.fn(),
    openReplacement: vi.fn(),
    downloadQbjBackup: vi.fn(),
    downloadPartialQbj: vi.fn(),
    downloadLegacyQbj: vi.fn(),
    print: vi.fn(),
  }).map((item) => item.label);
}

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('connected tournament scorer intent', () => {
  test('manual QBTCP examples match Director port 8787', () => {
    const connectedSetup = source('../src/app/ConnectedSetup.tsx');
    const welcome = source('../src/app/WelcomeScreen.tsx');

    expect(connectedSetup).toContain('placeholder="192.168.1.50:8787"');
    expect(welcome).toContain('placeholder="192.168.1.50:8787"');
    expect(connectedSetup).not.toContain('192.168.1.50:8080');
    expect(welcome).not.toContain('192.168.1.50:8080');
  });

  test('a tournament-controlled scoresheet does not offer Arcade as an ordinary game command', () => {
    expect(activeGameMenu(true)).not.toContain('Take a break…');
  });

  test('a standalone scoresheet keeps the Arcade break entry', () => {
    expect(activeGameMenu(false)).toContain('Take a break…');
  });

  test('manual result handoff copy does not pretend the transport was an upload', () => {
    const completion = source('../src/app/CompletionScreen.tsx');

    expect(completion).toContain('I handed off the result');
    expect(completion).toContain('Hand off the QBJ using the instructions provided for this room.');
    expect(completion).not.toContain('I uploaded the result');
    expect(completion).not.toContain('Upload the QBJ using the instructions provided for this room.');
  });
});
