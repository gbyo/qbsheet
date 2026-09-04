/**
 * The arcade's front door, and the only part of it in the scoring bundle.
 *
 * # Why the games are behind a dynamic import
 *
 * Because the arcade is the least important thing QBSheet does and the scoresheet is the most, and
 * the ordinary path through this application — a Chromebook reloading in the middle of a round —
 * must not parse a bird, a snake and two canvases to get back to a tossup. `import()` puts all of it
 * in a chunk of its own, fetched the first time somebody actually opens it, which is the same reason
 * and the same mechanism as the QR decoder; see `QrDecoding`.
 *
 * # Why that is still safe offline
 *
 * The chunk lands in `assets/` like every other scorer asset, and `vite.config.ts` precaches
 * everything there when the service worker installs. So the file is on the device before anybody
 * presses the entry, and a room in airplane mode gets the same arcade a room on the network does.
 * The failure branch below is for the one case that remains: a device whose cache predates this
 * feature and which is offline now. It says so, in the dialog, and nothing else changes.
 *
 * # Why this component and not three copies of the import
 *
 * Three screens open the arcade — the homepage and a waiting paired room, both through the same
 * promotional banner, and the scoresheet through its Game menu. Putting the load here means those
 * hosts render one element and hold one boolean, and the loading state, the failure message and the
 * closed state have one implementation between them.
 */
import { useEffect, useState, type ComponentType } from 'react';
import ScorerDialog from '../scorer/ScorerDialog';

type ArcadeComponent = ComponentType<{ onClose: () => void }>;

/**
 * The resolved module, kept for the life of the page.
 *
 * A scorekeeper who opens the arcade twice between rounds should get it instantly the second time,
 * and the alternative — re-importing on every open — is a promise resolved from the module cache
 * anyway, one render late. This holds a component, not a game: no state survives a close.
 */
let loaded: ArcadeComponent | null = null;

/** For tests, which need the failure branch to be reachable more than once. */
export function resetArcadeModuleCache(): void {
  loaded = null;
}

export default function ArcadeLauncher(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  /*
   * Both of these are wrapped in a function on purpose, and neither is optional.
   *
   * The value being stored is itself a function — a React component — and `useState` reads a bare
   * function as a lazy initializer and calls it, while `setState` reads one as an updater and calls
   * that. Either way the component would be invoked outside React with no props, which is a crash in
   * the dialog rather than a dialog. The extra arrow is what says "this function is the value".
   */
  const [Arcade, setArcade] = useState<ArcadeComponent | null>(() => loaded);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || loaded !== null) return undefined;
    let live = true;
    import('./ArcadeDialog')
      .then((module) => {
        loaded = module.default;
        if (live) setArcade(() => module.default);
      })
      .catch(() => {
        // An offline device cached before the arcade existed. Nothing about the scoresheet changes.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;

  if (Arcade !== null) return <Arcade onClose={onClose} />;

  return (
    <ScorerDialog title="Arcade" onClose={onClose}>
      {failed ? (
        <p className="scorer-dialog-note">
          The arcade could not be loaded on this device. It is not part of scoring, and nothing else is
          affected. Reconnecting once and reloading QBSheet will fetch it.
        </p>
      ) : (
        <p className="scorer-dialog-note">Loading…</p>
      )}
    </ScorerDialog>
  );
}
