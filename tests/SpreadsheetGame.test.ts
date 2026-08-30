import { describe, expect, it } from 'vitest';
import { IGameDefinition } from '../src/game/GameDefinition';
import deriveGame from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import toQbjMatch from '../src/scoring/toQbjMatch';
import {
  ISpreadsheetGameMetadata,
  ISpreadsheetGameSnapshot,
  buildSpreadsheetGameGrid,
  buildSpreadsheetGameSnapshot,
  encodeSpreadsheetText,
  parseSpreadsheetGame,
  serializeSpreadsheetGame,
  spreadsheetEventColumns,
  spreadsheetGameIdentity,
} from '../src/spreadsheet';
import { validPackage } from './packages';

function event(id: string, fields: Record<string, unknown>): ScoreEvent {
  return { id, questionNumber: 1, ...fields } as unknown as ScoreEvent;
}

function source(events: ScoreEvent[] = []): ISpreadsheetGameSnapshot {
  const packageValue: IGameDefinition = {
    ...validPackage({
      left: {
        name: 'Left\tΩ',
        players: [{ name: 'Ada "Ace"\nLovelace' }, { name: 'Björk' }],
      },
      right: {
        name: 'Right',
        players: [{ name: 'Grace' }, { name: '李' }],
      },
    }),
    origin: 'qbj',
    qbjIdentity: {
      tournamentId: 'tournament-1',
      matchId: 'qbj-match-9',
      phaseId: 'playoffs',
      roundId: 'round-7',
      teamIds: { left: 'team-l', right: 'team-r' },
      playerIds: { 'Left\tΩ\u001fAda "Ace"\nLovelace': 'player-1' },
    },
    assumptions: ['A note with a tab\tand a newline\nremains readable.'],
  };
  const metadata: ISpreadsheetGameMetadata = {
    recordIdentity: 'record-9',
    attempt: 1,
    connected: true,
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T13:00:00.000Z',
    completedAt: '2026-08-29T13:01:00.000Z',
    scorekeeper: 'Operator Ω',
    moderator: 'Moderator',
    notes: 'Keep\tthis\nprivate to the record.',
    qbjMatchMeta: { round: 7, location: 'Room "α"\nEast', notes: 'Keep\tthis' },
    serverDelivery: 'sent',
    serverDeliveryDetail: 'Accepted by tournament control.',
    serverDeliveryLedger: { attemptCount: 1, acceptedAsDuplicate: false, fingerprint: 'safe-fingerprint' },
    qbjDownloadedAt: '2026-08-29T13:02:00.000Z',
    handoffAcknowledgedAt: '2026-08-29T13:03:00.000Z',
  };
  return buildSpreadsheetGameSnapshot({
    package: packageValue,
    setup: {
      left: { name: 'Left\tΩ', players: ['Ada "Ace"\nLovelace', 'Björk'] },
      right: { name: 'Right', players: ['Grace', '李'] },
    },
    events,
    gameId: 'record-9',
    metadata,
  });
}

function parsedValue(text: string): ISpreadsheetGameSnapshot {
  const result = parseSpreadsheetGame(text);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.value;
}

function errorCode(text: string): string {
  const result = parseSpreadsheetGame(text);
  if (result.ok) throw new Error('Expected the spreadsheet parser to reject the payload.');
  return result.errors[0].code;
}

describe('QBSheet spreadsheet game schema', () => {
  it('round-trips package, setup, metadata, Unicode, delimiters, and future event fields', () => {
    const original = source([
      {
        ...event('note-1', { type: 'note', text: 'tab\tnewline\nquote " emoji 🚀', flagged: true }),
        futureField: { z: 'last', a: 'first' },
      } as unknown as ScoreEvent,
    ]);

    const text = serializeSpreadsheetGame(original);
    const parsed = parsedValue(text);
    const grid = buildSpreadsheetGameGrid(original);

    expect(parsed).toEqual(original);
    expect(new Set(grid.map((row) => row.length))).toEqual(new Set([spreadsheetEventColumns.length]));
    expect((parsed.events[0] as ScoreEvent & { futureField: unknown }).futureField).toEqual({
      z: 'last',
      a: 'first',
    });
    expect(text).toContain('QBSHEET_GAME\t1');
    expect(text).toContain('QBSHEET_END\t1');
    expect(text).toContain('SECTION\tGAME');
    expect(text).toContain('NEW BLANK TAB');
    expect(text).not.toContain('tab\tnewline');
    expect(text).toContain('QBSHEET_TEXT:"tab\\tnewline\\nquote');
  });

  it('is deterministic and protects string cells from spreadsheet coercion', () => {
    const original = source();
    const first = serializeSpreadsheetGame(original);
    const second = serializeSpreadsheetGame({ ...original, events: original.events.slice() });
    expect(first).toBe(second);
    expect(encodeSpreadsheetText('=SUM(A1:A2)\tunsafe\n')).not.toMatch(/[\t\r\n]/);

    const grid = buildSpreadsheetGameGrid(
      source([event('danger', { type: 'note', text: '=1+1', flagged: false })]),
    );
    for (const row of grid) {
      for (const cell of row) {
        expect(cell.startsWith('=')).toBe(false);
        expect(cell.startsWith('+')).toBe(false);
        expect(cell.startsWith('@')).toBe(false);
      }
    }
  });

  it('preserves the ordered event list as the scoring source of truth', () => {
    const original = source([
      event('buzz', {
        type: 'tossup-buzz',
        team: 'left',
        playerName: 'Ada "Ace"\nLovelace',
        answerTypeIndex: 0,
      }),
      event('bonus', { type: 'bonus', team: 'left', controlledPoints: 20 }),
    ]);
    const expected = deriveGame(original.package.scorekeeperFormat, original.setup, original.events);
    const parsed = parsedValue(serializeSpreadsheetGame(original));
    const actual = deriveGame(parsed.package.scorekeeperFormat, parsed.setup, parsed.events);
    expect(actual.left.points).toBe(expected.left.points);
    expect(actual.right.points).toBe(expected.right.points);
    expect(actual.questions).toEqual(expected.questions);
    expect(toQbjMatch(original.package.scorekeeperFormat, actual)).toEqual(
      toQbjMatch(original.package.scorekeeperFormat, expected),
    );
  });

  it('keeps multiple team buzzes, flat zero-point bonuses, and hostile strings lossless', () => {
    const hostileValues = [
      '=1+1',
      '+1+1',
      '-1+1',
      '@foo',
      '＝1+1',
      '＋1+1',
      '－1+1',
      '＠foo',
      '00123',
      '1/2',
      '1-2',
      '<script>alert(1)</script>',
      'A&B',
      '"quoted"',
      'back\\slash',
      'tab\tinside',
      'line one\nline two',
      'José',
      '李雷',
      '😀',
    ];
    const original = source([
      event('left-buzz', { type: 'tossup-buzz', team: 'left', playerName: 'Ada', answerTypeIndex: 0 }),
      event('right-buzz', { type: 'tossup-buzz', team: 'right', playerName: 'Grace', answerTypeIndex: 1 }),
      event('zero-bonus', { type: 'bonus', team: 'left', controlledPoints: 0, bouncebackPoints: 0 }),
      ...hostileValues.map((text, index) =>
        event(`hostile-${index}`, { type: 'note', text, flagged: index % 2 === 0 }),
      ),
    ]);
    const text = serializeSpreadsheetGame(original);

    expect(text).not.toContain('tab\tinside');
    for (const row of buildSpreadsheetGameGrid(original)) {
      for (const cell of row) {
        expect(cell.startsWith('=')).toBe(false);
        expect(cell.startsWith('+')).toBe(false);
        expect(cell.startsWith('@')).toBe(false);
      }
    }
    expect(parsedValue(text)).toEqual(original);
  });

  it('round-trips the configured room procedure and scheduled breaks', () => {
    const original = source([
      event('timeout-start', { type: 'timeout-start', team: 'left', startedAt: 456 }),
    ]);
    original.package = {
      ...original.package,
      procedure: {
        version: 3,
        halves: true,
        breaks: [{ afterTossup: 10, label: 'Halftime' }, { afterTossup: 20 }],
        halfLengthMinutes: 22,
        timeoutsPerTeam: 2,
        timeoutDurationSeconds: 30,
        protestCheckpoints: 'strict-overtime',
        substitutionPolicy: 'breaks-timeouts-overtime',
      },
    };

    expect(parsedValue(serializeSpreadsheetGame(original))).toEqual(original);
  });

  it.each([
    ['tossup-buzz', { type: 'tossup-buzz', team: 'left', playerName: 'Ada', answerTypeIndex: 0 }],
    ['tossup-no-penalty', { type: 'tossup-no-penalty', team: 'right', playerName: '李' }],
    ['tossup-reading-resumed', { type: 'tossup-reading-resumed' }],
    ['tossup-readout', { type: 'tossup-readout' }],
    ['tossup-dead', { type: 'tossup-dead' }],
    ['bonus', { type: 'bonus', team: 'left', parts: [{ controlledPoints: 10, bouncebackPoints: 5 }] }],
    ['lightning', { type: 'lightning', team: 'right', points: 30 }],
    ['substitution', { type: 'substitution', team: 'left', activePlayers: ['Ada'] }],
    ['roster-add', { type: 'roster-add', team: 'left', playerName: 'New Player' }],
    ['end-regulation', { type: 'end-regulation', lastRegulationQuestion: 1 }],
    ['half-break', { type: 'half-break', lastQuestion: 1 }],
    ['half-resume', { type: 'half-resume' }],
    ['begin-overtime', { type: 'begin-overtime' }],
    ['begin-sudden-death', { type: 'begin-sudden-death' }],
    ['timeout', { type: 'timeout', team: 'left' }],
    ['timeout-start', { type: 'timeout-start', team: 'right', startedAt: 123 }],
    ['timeout-resume', { type: 'timeout-resume' }],
    [
      'protest',
      {
        type: 'protest',
        team: 'left',
        subject: 'question',
        description: 'Why?',
        status: 'open',
        resolution: 'Pending',
      },
    ],
    ['question-void', { type: 'question-void', scope: 'bonus', reason: 'Spoiled\tquestion' }],
    ['end-game-early', { type: 'end-game-early', reason: 'Packet ended', tossupsRead: 0 }],
    ['adjustment', { type: 'adjustment', team: 'right', points: -5, reason: 'Correction' }],
    ['forfeit', { type: 'forfeit', teams: ['right'] }],
    ['note', { type: 'note', text: 'A note', flagged: false }],
  ] as const)('round-trips the %s event variant', (_name, fields) => {
    const original = event(`id-${_name}`, fields);
    expect(parsedValue(serializeSpreadsheetGame(source([original]))).events).toEqual([original]);
  });

  it('rejects structural corruption instead of guessing', () => {
    const text = serializeSpreadsheetGame(source());
    expect(errorCode(text.replace('QBSHEET_GAME\t1', 'NOPE\t1'))).toBe('wrong-marker');
    expect(errorCode(text.replace('QBSHEET_GAME\t1', 'QBSHEET_GAME\t2'))).toBe('unsupported-version');
    expect(errorCode(text.replace(/QBSHEET_END\t1[^\n]*\n?$/, ''))).toBe('missing-end-marker');
    expect(errorCode(`${text}\nEVENTS\t0\tgarbage\n`)).toBe('data-outside-section');
    expect(errorCode(text.replace('SECTION\tGAME', 'SECTION\tGAME\textra'))).toBe('malformed-section-marker');
    expect(errorCode(text.replace('SECTION\tRECORD', 'SECTION\tGAME'))).toBe('duplicate-section');
    expect(
      errorCode(text.replace(/(SECTION\tTEAMS\t1\t)QBSHEET_TEXT:[^\n]+/, '$1QBSHEET_TEXT:"other"')),
    ).toBe('section-game-id-mismatch');
    expect(
      errorCode(text.replace(/QBSHEET_END\t1\t[^\t]+\t0/, 'QBSHEET_END\t1\tQBSHEET_TEXT:"other"\t0')),
    ).toBe('end-game-id-mismatch');
    expect(errorCode(text.replace('SECTION\tEVENTS\t1', 'SECTION\tEVENTS\t2'))).toBe('unsupported-version');
  });

  it('rejects duplicate event IDs and malformed event rows', () => {
    const duplicate = serializeSpreadsheetGame(
      source([event('same', { type: 'note', text: 'one' }), event('same', { type: 'note', text: 'two' })]),
    );
    expect(errorCode(duplicate)).toBe('duplicate-event-id');

    const valid = serializeSpreadsheetGame(source([event('one', { type: 'note', text: 'one' })]));
    const malformed = valid.replace(/(\n1\t)[^\t]+\t/, '$1bad\t');
    expect(errorCode(malformed)).toBe('malformed-number');
  });

  it('uses durable assignment identity before a local record fallback', () => {
    const packageValue = source().package;
    expect(spreadsheetGameIdentity(packageValue, 'local-record')).toBe('match:qbj-match-9');
    expect(
      spreadsheetGameIdentity(
        { ...packageValue, qbjIdentity: undefined, scheduledMatchId: 'scheduled-1' },
        'other',
      ),
    ).toBe('match:scheduled-1');
    expect(
      spreadsheetGameIdentity(
        { ...packageValue, qbjIdentity: undefined, scheduledMatchId: undefined },
        'local-record',
      ),
    ).toBe('local-record');
    expect(() =>
      spreadsheetGameIdentity({ ...packageValue, qbjIdentity: undefined, scheduledMatchId: undefined }),
    ).toThrow(/existing stable local identity/);
  });

  it('accepts harmless blank rows, trimmed trailing cells, and an omitted optional procedure section', () => {
    const original = serializeSpreadsheetGame(
      source([event('note', { type: 'note', text: 'kept', flagged: false })]),
    );
    let skippingProcedure = false;
    const withoutProcedure = original
      .split('\n')
      .filter((line) => {
        if (line.startsWith('SECTION\tPROCEDURE')) {
          skippingProcedure = true;
          return false;
        }
        if (line.startsWith('SECTION\tEVENTS')) skippingProcedure = false;
        return !skippingProcedure;
      })
      .join('\n');
    const withBlanks = withoutProcedure
      .replace('SECTION\tTEAMS', '\n\nSECTION\tTEAMS')
      .replace(/\nQBSHEET_END/, '\n\nQBSHEET_END');
    const trimmedEvent = withBlanks
      .split('\n')
      .map((line) => (line.startsWith('1\t') ? line.replace(/\t+$/, '') : line))
      .join('\n');

    const parsed = parseSpreadsheetGame(trimmedEvent);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.package.procedure).toBeUndefined();
      expect(parsed.value.events).toHaveLength(1);
    }
  });

  it('rejects malformed typed cells and unrelated event columns', () => {
    const note = serializeSpreadsheetGame(
      source([event('note', { type: 'note', text: 'kept', flagged: false })]),
    );
    expect(errorCode(note.replace(/\tfalse\t/, '\tmaybe\t'))).toBe('malformed-boolean');

    const bonus = serializeSpreadsheetGame(
      source([event('bonus', { type: 'bonus', team: 'left', parts: [{ controlledPoints: 10 }] })]),
    );
    expect(errorCode(bonus.replace(/QBSHEET_JSON:\{[^\n]*?\}/, 'QBSHEET_JSON:{'))).toBe('malformed-json');

    const unrelated = note.replace(/(\n1\t[^\n]*?\t1\tnote\t)[^\t]*\t/, '$1left\t');
    expect(errorCode(unrelated)).toBe('unexpected-event-field');
  });
});
