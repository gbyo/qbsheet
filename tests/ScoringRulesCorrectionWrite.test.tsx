/** @vitest-environment jsdom */

/**
 * Applying a rules correction to a device that only half accepts it.
 *
 * `formatCorrection` decides whether a correction is applicable and `ScoringRulesCorrectionDialog`
 * gets it confirmed, and both are tested elsewhere. What is tested here is the write, because the
 * write is where a correction can go half-done: the re-pointed history goes to `localStorage` and
 * the corrected format goes to IndexedDB, and the second can be refused after the first has been
 * accepted.
 *
 * The re-pointed history is not a harmless leftover. A correction that adds an answer type moves
 * every index below it, so what is sitting in the journal after the format write fails is a set of
 * buzzes pointing at positions that exist only in the format that was refused — a game whose powers
 * are priced as tossups from the next reload onwards, with the correction's own note in the history
 * claiming the rules were fixed, and nothing on screen to say so. Retrying does not undo it either:
 * `correctFormat` remaps from wherever the indices currently sit.
 *
 * So the property is that the journal is exactly what it was, and that the room is told so.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ScoringScreen from '../src/app/ScoringScreen';
import { GameStore, IStoredGameRecord } from '../src/game/GameStore';
import { IRecordStore } from '../src/persistence/GameDatabase';
import { ResultDeliveryService } from '../src/app/ResultDelivery';
import { ResultDeliveryCapabilityStore } from '../src/app/ResultDeliveryCapability';
import { loadGame, saveGame } from '../src/scorer/GameSession';
import { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import deriveGame from '../src/scoring/deriveGame';
import { validPackage } from './packages';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';

const rules = new ScoringRules(CommonRuleSets.AcfPowers);
rules.maximumPlayersPerTeam = 3;
const format = scoringRulesToScorekeeperFormat(rules);

const setup: IGameSetup = {
  left: { name: 'Ninety Six A', players: ['Sarah Mitchell', 'James Okafor', 'Alex Rivera'] },
  right: { name: 'Greenwood', players: ['Emma Chen', 'Jordan Blake', 'Morgan Ellis'] },
};

/** A power and its bonus on question one: twenty-five points that a correction can move. */
function scoredPower(): ScoreEvent[] {
  return [
    event({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Sarah Mitchell',
      answerTypeIndex: typeIndex(format, 15),
    }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 10 }),
  ];
}

/**
 * A durable record store that accepts everything except a change to the scoring rules.
 *
 * Durable matters: `GameStore.update` reports success for a refused write when the store is not
 * durable, on the grounds that a memory fallback is meant to stay usable. The failure being modelled
 * is a real database refusing a real write, which is the only kind that returns null.
 */
class FormatRefusingStore implements IRecordStore<IStoredGameRecord> {
  readonly durable = true;
  readonly storageDegraded = false;
  private records = new Map<string, IStoredGameRecord>();
  private readonly accepted = JSON.stringify(format);
  /** Every write this store turned away, so a test can prove the refusal actually happened. */
  refusals = 0;

  constructor(private readonly refuseRules: boolean) {}

  async list(): Promise<IStoredGameRecord[]> {
    return [...this.records.values()];
  }

  async get(id: string): Promise<IStoredGameRecord | null> {
    return this.records.get(id) ?? null;
  }

  async put(record: IStoredGameRecord): Promise<boolean> {
    if (this.refuseRules && JSON.stringify(record.package.scorekeeperFormat) !== this.accepted) {
      this.refusals += 1;
      return false;
    }
    this.records.set(record.id, record);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

async function openScoringScreen({ refuseRules = true }: { refuseRules?: boolean } = {}) {
  const records = new FormatRefusingStore(refuseRules);
  const store = new GameStore(records);
  const created = await store.create({
    package: validPackage({ scorekeeperFormat: format }),
    setup,
    connected: false,
  });
  // The journal is what the scorer reads and what `saveEvents` writes, so the game has to be in it
  // before the screen mounts. Reading the record back is what teaches the store where to journal.
  saveGame(created.gameKey, setup, scoredPower());
  const record = (await store.get(created.id)) as IStoredGameRecord;

  const onRecordChanged = vi.fn();
  render(
    <ScoringScreen
      record={record}
      store={store}
      resultDelivery={new ResultDeliveryService(store, new ResultDeliveryCapabilityStore())}
      connection={null}
      durable
      onComplete={vi.fn()}
      onRecordChanged={onRecordChanged}
      onConnectionRepaired={vi.fn()}
      onConnectionLost={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByText('Ninety Six A')).toBeInTheDocument());
  return { records, store, record, onRecordChanged };
}

async function press(name: string | RegExp, role: 'button' | 'menuitem' = 'button') {
  const control = await screen.findByRole(role, { name });
  await act(async () => {
    fireEvent.click(control);
  });
}

/**
 * Open the scoring-rules correction from the row it corrects.
 *
 * It used to be its own Game-menu entry. Corrections to the game's own definition are reached from
 * Game details now, where the value being corrected is on screen beside the control -- so the row
 * has to be found first, because "Correct…" on its own names three different buttons in there.
 */
async function openScoringRulesCorrection() {
  await press(/^game$/i);
  await press(/game details/i, 'menuitem');
  const details = await screen.findByRole('dialog', { name: 'Game details' });
  const row = within(details).getByText('Scoring rules').closest('.scorer-detail-row');
  if (!(row instanceof HTMLElement)) throw new Error('the Scoring rules row is not on screen');
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: /correct/i }));
  });
}

/** Propose the correction that moves indices: a tier above the power this game already recorded. */
async function proposeSuperpower() {
  await openScoringRulesCorrection();
  await press(/add an answer type/i);

  const fill = (label: string, value: string) => {
    const fields = screen.getAllByLabelText(label);
    fireEvent.input(fields[fields.length - 1], { target: { value } });
  };
  fill('Points', '20');
  fill('Name', 'Superpower');
  fill('Short', 'SP');

  const review = await screen.findByRole('button', { name: /review changes/i });
  await waitFor(() => expect(review).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(review);
  });
  await press(/apply corrected rules/i);
}

describe('when the device accepts the history but refuses the corrected rules', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('puts the history back rather than leaving it pointed at rules that were refused', async () => {
    const { records, record } = await openScoringScreen();
    const before = loadGame(record.gameKey);
    expect(before?.events).toHaveLength(2);

    await proposeSuperpower();
    await waitFor(() => expect(records.refusals).toBeGreaterThan(0));

    // Exactly what it was: no re-pointed buzz, and no note claiming the rules were corrected.
    await waitFor(() => expect(loadGame(record.gameKey)?.events).toEqual(before?.events));

    // Which is the point of putting it back. Read under the rules the game is still being scored
    // under, the power is still a power.
    const journalled = loadGame(record.gameKey) as { events: ScoreEvent[] };
    expect(deriveGame(format, setup, journalled.events).left.points).toBe(25);
  });

  test('says nothing has changed, and stays open so the retry is one press', async () => {
    await openScoringScreen();
    await proposeSuperpower();

    // One of the alerts on screen, rather than the only one: refusing the write also puts the
    // screen's own storage warning up, which is a separate true thing about the same moment.
    const refusal = await screen.findByText(/nothing has changed/i);
    expect(refusal).toHaveTextContent(/could not be saved on this device/i);
    expect(screen.getAllByRole('alert')).toContain(refusal);
    expect(screen.getByRole('button', { name: /apply corrected rules/i })).not.toBeDisabled();
  });

  test('says so differently when the device will not take the scoresheet back either', async () => {
    await openScoringScreen();

    /*
     * The rollback refused too. Rare -- a browser that withdrew storage between the two writes --
     * and the one case where "nothing has changed" is itself false, so the room is told to get a
     * backup out instead. This is a message only the host can know to send, which is why it travels
     * as `GameCorrectionRefusal` rather than being the dialog's own wording; a plain `Error` here
     * falls back to the reassuring sentence and the room never hears it.
     */
    const storage = Object.getPrototypeOf(window.localStorage) as Storage;
    const setItem = storage.setItem;
    let writes = 0;
    storage.setItem = function refuseTheSecond(this: Storage, key: string, value: string) {
      writes += 1;
      if (writes > 1) throw new Error('quota');
      return setItem.call(this, key, value);
    };
    try {
      await proposeSuperpower();
      const refusal = await screen.findByText(/would not put the scoresheet back/i);
      expect(refusal).toHaveTextContent(/download the qbj backup/i);
      expect(screen.getAllByRole('alert')).toContain(refusal);
    } finally {
      storage.setItem = setItem;
    }
  });

  test('does not redraw the scoresheet under rules that exist only in memory', async () => {
    const { records, onRecordChanged } = await openScoringScreen();
    await proposeSuperpower();
    await waitFor(() => expect(records.refusals).toBeGreaterThan(0));

    // The scorer is not remounted and the host is not told the record moved on.
    expect(onRecordChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/every question has been recalculated/i)).toBeNull();
  });
});

describe('when the device accepts both halves', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('the correction lands, and the journal keeps the re-pointed history', async () => {
    const { records, record, onRecordChanged } = await openScoringScreen({ refuseRules: false });
    await proposeSuperpower();

    await waitFor(() => expect(onRecordChanged).toHaveBeenCalled());
    expect(records.refusals).toBe(0);

    /*
     * The buzz has moved to the position its own button now occupies, and the corrected rules are
     * the ones the record holds -- so the pair agrees, which is the whole thing the rollback exists
     * to protect. Still twenty-five points: the same power, the same bonus, priced by rules that
     * now have a tier above it.
     */
    const journalled = loadGame(record.gameKey) as { events: ScoreEvent[] };
    const corrected = ((await records.get(record.id)) as IStoredGameRecord).package.scorekeeperFormat;
    expect(corrected.answerTypes.map((answerType) => answerType.value)).toEqual([20, 15, 10, -5]);
    expect(deriveGame(corrected, setup, journalled.events).left.points).toBe(25);

    // And the correction says so in the game, for whoever imports the result on Monday.
    expect(journalled.events.some((candidate) => candidate.type === 'note')).toBe(true);
  });
});
