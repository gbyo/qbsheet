/** @vitest-environment jsdom */

/**
 * The paper copy.
 *
 * Every role query below passes `hidden: true`, which is not a workaround but the assertion: the
 * document sets `aria-hidden` because it duplicates the scoresheet, so it is correctly invisible to
 * the role tree and a test that could reach it without asking would mean the attribute was missing.
 *
 * Two things matter and only one of them is the layout. The first is that the document says what the
 * game says — it is a second rendering of the same `IDerivedGame`, and a printed scoresheet that
 * disagrees with the screen is worse than no printed scoresheet at all. The second is that it is not
 * in the DOM unless a print is actually happening, which is the constraint that shapes the whole
 * feature; see `usePrinting`.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import PrintableScoresheet, { continuationRows } from '../src/scorer/PrintableScoresheet';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { identityDisplaySideMapping, swapDisplaySideMapping } from '../src/scorer/DisplaySideMapping';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';

const rules = new ScoringRules(CommonRuleSets.AcfPowers);
rules.maximumPlayersPerTeam = 2;
const format = scoringRulesToScorekeeperFormat(rules);

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

/** A power and a bonus, then a neg answered by the other team. */
const events: ScoreEvent[] = [
  event({
    type: 'tossup-buzz',
    questionNumber: 1,
    team: 'left',
    playerName: 'Sarah Mitchell',
    answerTypeIndex: typeIndex(format, 15),
  }),
  event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
  event({
    type: 'tossup-buzz',
    questionNumber: 2,
    team: 'right',
    playerName: 'Emma Turner',
    answerTypeIndex: typeIndex(format, -5),
  }),
  event({
    type: 'tossup-buzz',
    questionNumber: 2,
    team: 'left',
    playerName: 'James Robinson',
    answerTypeIndex: typeIndex(format, 10),
  }),
  event({ type: 'bonus', questionNumber: 2, team: 'left', controlledPoints: 10 }),
];

function printed(scoreEvents: ScoreEvent[] = events, displaySides = identityDisplaySideMapping) {
  const game = deriveGame(format, setup, scoreEvents);
  render(
    <PrintableScoresheet
      game={game}
      format={format}
      tournamentName="Greenwood Invitational"
      roundName="Round 7"
      roomName="Room 204"
      packetName="12"
      operatorName="C. Bell"
      displaySides={displaySides}
      now={new Date('2026-08-20T14:32:00Z')}
    />,
  );
  return game;
}

describe('what the printed sheet says', () => {
  test('names the game, the round and the room, so sixteen of them can be told apart', () => {
    printed();
    expect(screen.getByText('Ninety Six vs Greenwood')).toBeInTheDocument();
    expect(screen.getByText(/Greenwood Invitational · Round 7 · Room 204 · Packet 12/)).toBeInTheDocument();
    expect(screen.getByText(/C\. Bell/)).toBeInTheDocument();
  });

  test('agrees with the game it was rendered from', () => {
    const game = printed();
    const score = screen.getByText(/after \d+ tossups/);
    expect(score).toHaveTextContent(String(game.left.points));
    expect(score).toHaveTextContent(String(game.right.points));
  });

  test('shows who answered what, question by question', () => {
    printed();
    const grid = screen.getByRole('table', { name: /question by question/i, hidden: true });
    const rows = within(grid).getAllByRole('row', { hidden: true });
    // Header, then two played questions, then the blanks.
    expect(within(rows[1]).getByText('Sarah Mitchell +15')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Emma Turner -5')).toBeInTheDocument();
    expect(within(rows[2]).getByText('James Robinson +10')).toBeInTheDocument();
  });

  test('carries a running tossup-and-bonus total down the page', () => {
    printed();
    const grid = screen.getByRole('table', { name: /question by question/i, hidden: true });
    const rows = within(grid).getAllByRole('row', { hidden: true });
    // 15 + 20 after one; then 10 + 10 for the left team and -5 for the right. Slash-separated,
    // because a running total can be negative and `55–-5` is not a score anybody can read.
    expect(within(rows[1]).getByText('35 / 0')).toBeInTheDocument();
    expect(within(rows[2]).getByText('55 / -5')).toBeInTheDocument();
  });

  test('leaves ruled rows to finish the game by hand, numbered where the device stopped', () => {
    printed();
    const grid = screen.getByRole('table', { name: /question by question/i, hidden: true });
    const rows = within(grid).getAllByRole('row', { hidden: true });
    expect(rows).toHaveLength(1 + 2 + continuationRows);
    // The first blank row continues the numbering rather than restarting it.
    expect(within(rows[3]).getByRole('rowheader', { hidden: true })).toHaveTextContent('3');
  });

  test('gives each team a box score with a column per answer type', () => {
    printed();
    const left = screen.getByRole('table', { name: 'Ninety Six', hidden: true });
    expect(within(left).getByRole('rowheader', { name: 'Sarah Mitchell', hidden: true })).toBeInTheDocument();
    format.answerTypes.forEach((answerType) => {
      expect(
        within(left).getByRole('columnheader', { name: answerType.shortLabel, hidden: true }),
      ).toBeInTheDocument();
    });
  });

  test('may follow the displayed orientation while keeping canonical question ownership', () => {
    printed(events, swapDisplaySideMapping(identityDisplaySideMapping));

    expect(screen.getByText('Greenwood vs Ninety Six')).toBeInTheDocument();
    const grid = screen.getByRole('table', { name: /question by question/i, hidden: true });
    const header = within(grid).getAllByRole('columnheader', { hidden: true });
    expect(header[1]).toHaveTextContent('Greenwood');
    expect(header[3]).toHaveTextContent('Ninety Six');
    const rows = within(grid).getAllByRole('row', { hidden: true });
    expect(within(rows[1]).getByText('0 / 35')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Sarah Mitchell +15')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Greenwood', hidden: true })).toBeInTheDocument();
  });

  test('says what the answer types are worth, for whoever picks the sheet up', () => {
    printed();
    expect(screen.getByText(/15 = 15|P = 15/)).toBeInTheDocument();
  });

  test('carries the notes, including a mid-game rules correction', () => {
    printed([
      ...events,
      event({
        type: 'note',
        questionNumber: 2,
        text: 'Scoring rules corrected — Power: 15 points → 20 points.',
      }),
    ]);
    expect(screen.getByText(/Scoring rules corrected/)).toBeInTheDocument();
  });

  test('says where the device’s copy stops, so a paper continuation is not mistaken for the whole game', () => {
    printed();
    expect(screen.getByText(/stops at question 2/)).toBeInTheDocument();
  });

  /**
   * The document is a duplicate of the scoresheet by construction, so a screen reader that read both
   * would announce the entire game twice. `print.css` cannot help — a stylesheet is not the
   * accessibility tree.
   */
  test('is hidden from assistive technology, being a copy of what is already on screen', () => {
    printed();
    expect(document.querySelector('.printable-scoresheet')).toHaveAttribute('aria-hidden', 'true');
  });
});
