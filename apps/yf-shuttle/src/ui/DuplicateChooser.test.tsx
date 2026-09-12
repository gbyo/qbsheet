/**
 * Same-basename duplicates must not light up two radios.
 *
 * Two rooms' OUT folders can each hold `result.qbj` for the same Match. The choice is a
 * physical candidate identity, so exactly one radio is selected even though the display
 * names match — and clicking a row persists that row's candidateId, not a basename.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { candidateIdFor } from '../lib/scan';
import type { Shuttle } from '../lib/useShuttle';
import { DuplicateChooser } from './ShuttleApp';

const fileName = 'result.qbj';

function candidates() {
  return [
    {
      candidateId: candidateIdFor('319', fileName, '{"319":"final"}'),
      fileName,
      folderName: '319',
      scoreLine: '319 final',
    },
    {
      candidateId: candidateIdFor('321', fileName, '{"321":"final"}'),
      fileName,
      folderName: '321',
      scoreLine: '321 final',
    },
  ];
}

function shuttleStub(onChoose: (matchId: string, candidateId: string) => void): Shuttle {
  return { chooseResult: async (matchId: string, candidateId: string) => onChoose(matchId, candidateId) } as Shuttle;
}

test('one radio is selected when two OUT folders hold the same basename', () => {
  const [first] = candidates();
  render(
    <DuplicateChooser
      shuttle={shuttleStub(() => {})}
      matchId="match-1"
      room="319"
      roundNumber={1}
      candidates={candidates()}
      selectedCandidateId={first.candidateId}
    />,
  );
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(2);
  expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  expect((radios[0] as HTMLInputElement).checked).toBe(true);
});

test('choosing a row persists that row’s candidate identity', () => {
  const seen: { matchId: string; candidateId: string }[] = [];
  const [, second] = candidates();
  render(
    <DuplicateChooser
      shuttle={shuttleStub((matchId, candidateId) => seen.push({ matchId, candidateId }))}
      matchId="match-1"
      room="319"
      roundNumber={1}
      candidates={candidates()}
    />,
  );
  const radios = screen.getAllByRole('radio');
  expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(0);
  fireEvent.click(radios[1]);
  expect(seen).toEqual([{ matchId: 'match-1', candidateId: second.candidateId }]);
});
