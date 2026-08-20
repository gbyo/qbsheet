/**
 * Whether the browser is currently producing a printed copy.
 *
 * # Why the printable scoresheet is not simply always there
 *
 * The obvious implementation is to render `PrintableScoresheet` all the time and let `print.css`
 * hide it on screen. That works, and it is wrong: the printable document contains every player name,
 * every ruling and every score in the game, so leaving it mounted puts a complete second copy of the
 * scoresheet in the DOM at all times. A screen reader can be told to skip it. `document` text
 * searches cannot — which is how it was found, by thirty-six tests that suddenly matched two of
 * everything, and those tests were right: two copies of the game is exactly what it was.
 *
 * So it mounts for the length of a print and not otherwise.
 *
 * # Getting mounted in time
 *
 * `beforeprint` fires before the browser serializes the page, which is the hook this needs, but a
 * React state update scheduled from it is batched and would land after the snapshot was already
 * taken. `flushSync` forces the render to completion inside the event, so the document exists by the
 * time the browser looks at it.
 *
 * Safari fires no `beforeprint` at all. It does change `matchMedia('print')`, so that is listened to
 * as well; both paths set the same flag and either is enough. The returned `print` covers the third
 * case — the scorer's own menu entry, which knows a print is about to start and need not be told.
 */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export interface IPrinting {
  /** True while a printed copy is being produced, and only then. */
  printing: boolean;
  /** Print now, from a control that already knows it is printing. */
  print: () => void;
}

export default function usePrinting(): IPrinting {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const start = () => {
      // Inside a native event handler, so this is a legal place to force a synchronous render.
      flushSync(() => setPrinting(true));
    };
    const stop = () => setPrinting(false);

    window.addEventListener('beforeprint', start);
    window.addEventListener('afterprint', stop);

    // Safari's route. `addListener` is the deprecated spelling, kept because the iPads that need it
    // are the same ones that do not have `addEventListener` on a MediaQueryList.
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    const onQueryChange = (event: MediaQueryListEvent) => {
      if (event.matches) start();
      else stop();
    };
    if (query?.addEventListener) query.addEventListener('change', onQueryChange);
    else query?.addListener?.(onQueryChange);

    return () => {
      window.removeEventListener('beforeprint', start);
      window.removeEventListener('afterprint', stop);
      if (query?.removeEventListener) query.removeEventListener('change', onQueryChange);
      else query?.removeListener?.(onQueryChange);
    };
  }, []);

  /*
   * The imperative path, for the scorer's own menu entry.
   *
   * Mounts the document, prints, and unmounts it without depending on any of the events above, so
   * that the route a scorekeeper is most likely to take is the one that cannot be defeated by a
   * browser's choice of print event.
   */
  const print = () => {
    if (typeof window === 'undefined') return;
    flushSync(() => setPrinting(true));
    /*
     * Mounted, then left alone. Clearing the flag after `window.print()` returns looks tidy and is
     * wrong: `print()` blocks only where it is implemented synchronously, and where it is not, the
     * document would be unmounted while the browser was still deciding what to put on the paper --
     * producing a blank print, on exactly the browsers least able to spare one.
     *
     * `afterprint` and the `matchMedia('print')` listener above both clear it, and between them they
     * cover every browser this ships to. The synchronous case clears it before this line is even
     * reached, which is why there is nothing to do here.
     */
    window.print();
  };

  return { printing, print };
}
