import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { basicScorekeeperFormat, basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { derivedStatsGrid } from '../src/scoring/statsSheet';
import TeamStatLines from '../src/scorer/TeamStatLines';

const setup: IGameSetup = {
  left: { name: 'Dorman', players: ['Alice'] },
  right: { name: 'Wren A', players: ['Cleo'] },
};

function noBonusFormat() {
  const format = basicScorekeeperFormat({
    ...basicScoringRulesDefaults,
    useBonuses: false,
  });
  if (!format) throw new Error('No-bonus rules did not produce a format.');
  return format;
}

describe('no-bonus stat sheet presentation', () => {
  test('omits bonus totals from copied and visible team summaries', () => {
    const format = noBonusFormat();
    const game = deriveGame(format, setup, []);

    const teamHeading = derivedStatsGrid(format, game).find(
      (row) => row[0] === 'Team' && row[1] === 'Points',
    );
    expect(teamHeading).toEqual(['Team', 'Points', 'Tossup points']);
    expect(teamHeading).not.toContain('Bonuses');

    render(<TeamStatLines format={format} team={game.left} />);
    expect(screen.getByText(/Tossup points 0/)).toBeInTheDocument();
    expect(screen.queryByText(/Bonuses/)).not.toBeInTheDocument();
  });
});
