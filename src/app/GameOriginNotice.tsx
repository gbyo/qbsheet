/**
 * What the scoresheet had to take on faith, said where the game is.
 *
 * # Why it lives here and not on the file picker
 *
 * The obvious home is next to the button that opened the file, and that is wrong: opening a game
 * replaces the welcome screen, so a notice rendered there is unmounted in the same tick it appears.
 * A message nobody can read is worse than no message, because it looks like the work was done.
 *
 * So the notice travels with the game. Everything it says comes off the definition, which means it
 * survives a reload for the same reason the game does.
 *
 * # Non-blocking, and small
 *
 * None of this stops anybody scoring. A legacy file scores exactly as well as a QBJ one, and a
 * generic QBJ with no procedure in it scores fine — the room simply needs to know that the
 * scoresheet will not be enforcing rules it was never given, so that nobody assumes silence means
 * approval.
 */
import { IGameDefinition } from '../game/GameDefinition';
import { IGamePackage } from '../game/GamePackage';

export default function GameOriginNotice(props: { packageValue: IGamePackage }) {
  // Records written before definitions carried provenance simply have neither field, and a game
  // stored by an older build must not start throwing because of a banner.
  const definition = props.packageValue as Partial<IGameDefinition>;
  const legacy = definition.origin === 'qbg';
  const assumptions = definition.assumptions ?? [];

  if (!legacy && assumptions.length === 0) return null;

  return (
    <div className="game-origin-notice" role="status">
      {legacy && (
        <p>
          <strong>Legacy QBSheet game file.</strong> This file is supported, but new assignments use QBJ.
        </p>
      )}
      {assumptions.map((assumption) => (
        <p key={assumption}>{assumption}</p>
      ))}
    </div>
  );
}
