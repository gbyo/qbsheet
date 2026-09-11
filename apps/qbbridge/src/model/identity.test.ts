import { describe, expect, test } from 'vitest';
import { pairingMatchId } from './identity';

describe('pairing match identity', () => {
  test('does not collide when an imported id contains a tuple separator', () => {
    const first = pairingMatchId({
      tournamentId: 'tournament',
      roundId: 'round\u001froom',
      roomId: 'room',
      leftTeamId: 'left',
      rightTeamId: 'right',
    });
    const second = pairingMatchId({
      tournamentId: 'tournament',
      roundId: 'round',
      roomId: 'room\u001froom',
      leftTeamId: 'left',
      rightTeamId: 'right',
    });

    expect(first).not.toBe(second);
  });

  test('keeps team order significant', () => {
    const common = {
      tournamentId: 'tournament',
      roundId: 'round',
      roomId: 'room',
    };

    expect(pairingMatchId({ ...common, leftTeamId: 'left', rightTeamId: 'right' })).not.toBe(
      pairingMatchId({ ...common, leftTeamId: 'right', rightTeamId: 'left' }),
    );
  });
});
