/**
 * What the room sees when the scoresheet itself throws.
 *
 * # The failure this exists for
 *
 * `watchForErrors` catches what reaches `window.onerror` and what rejects unhandled. It cannot catch
 * a throw during render, because React catches that one first, unmounts the whole tree, and leaves
 * an empty `<div id="root">`. The scorekeeper does not see an error. They see a white screen, on
 * question fourteen, with a moderator waiting.
 *
 * The scoring is not lost when that happens — `useGameEvents` writes the event history to
 * `localStorage` synchronously on every accepted operation, so the journal on disk is already
 * current as of the last thing the scorekeeper did. But a blank page does not say so, and a room
 * that does not know its game survived will start writing on paper, or worse, start over.
 *
 * So this exists to say the true thing: the game is on the device, and reloading brings it back.
 *
 * # Why the escalation
 *
 * A render crash caused by transient state is fixed by a reload. A render crash caused by state that
 * is *stored* comes back on the reload, and then the room is in a loop with no way out — the
 * scoresheet cannot draw, so none of the in-app exports can be reached, and the morning's scoring is
 * sitting in a `localStorage` key nobody can get at.
 *
 * A crash count in `sessionStorage` tells those two apart. The first crash offers a reload, because
 * that is nearly always the answer. A repeat crash stops recommending it and offers the raw journal
 * instead, which is `exportJournals` reading the strings without validating them. That file is not
 * pretty and it is not a QBJ, but it is the morning's scoring, off the device, in a form somebody
 * can act on.
 *
 * # What it deliberately does not do
 *
 * It does not clear the journal, and it offers nothing that would. The state that crashed the render
 * may be the state holding the game, and a "reset" button on a screen shown to somebody who is
 * already having a bad morning is a way to lose a game permanently. Clearing stays where it always
 * was: behind the deliberate, named actions in Settings.
 *
 * It also does not try to render any of the application's own chrome. Whatever just threw is
 * somewhere in that tree, and a fallback that reuses the components it is standing in for is a
 * fallback that can throw while reporting a throw. Everything below is plain elements and the
 * shell's own tokens.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { downloadFile } from '../integrations/file/QbjDownload';
import { describeThrown, errorLog, ErrorLog, messageLimit } from './ErrorLog';
import { redact } from './ConnectionTimeline';
import { downloadDiagnostics } from './Diagnostics';
import { exportJournals } from '../scorer/GameSession';
import {
  inspectBrowserJournals,
  journalFileContents,
  journalFileName,
  summarizeJournalRecovery,
} from './RecoveryJournal';
import type { IJournalInspection } from './RecoveryJournal';
import { recoveryModeHref } from './recoveryModeRequest';

// Kept as named exports here for existing callers and tests. The implementation lives beside the
// read-only journal inspector so Recovery Mode and the crash boundary use the same raw format.
export { journalFileContents, journalFileName } from './RecoveryJournal';

/**
 * Where the repeat count lives.
 *
 * `sessionStorage` rather than `localStorage` on purpose. The question being asked is "did this tab
 * just crash and come back?", which is about this run of the application, not about the device. A
 * device-wide count would still read as a loop on a Saturday morning because of something that
 * happened on Thursday.
 */
export const crashCountStorageKey = 'qbsheet.render-crash-count';

/** Past this many crashes in one session, reloading has been tried and has not worked. */
export const repeatCrashThreshold = 2;

interface IStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStore(): IStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // A profile with storage disabled. The boundary still works; it just cannot count.
    return null;
  }
}

/** Read the count, treating anything unparseable as a first crash. */
export function readCrashCount(storage: IStorageLike | null = sessionStore()): number {
  try {
    const raw = storage?.getItem(crashCountStorageKey);
    const parsed = raw === null || raw === undefined ? 0 : Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Record one more crash and report the new total. */
export function recordCrash(storage: IStorageLike | null = sessionStore()): number {
  const next = readCrashCount(storage) + 1;
  try {
    storage?.setItem(crashCountStorageKey, String(next));
  } catch {
    // Counting is a convenience. A boundary that threw while counting would be the actual disaster.
  }
  return next;
}

type SaveState = 'idle' | 'saved' | 'empty' | 'failed';

interface IProps {
  children: ReactNode;
  /** Injected by tests so a crash can be observed without a real `sessionStorage`. */
  log?: ErrorLog;
  storage?: IStorageLike | null;
  onReload?: () => void;
  onRecoveryMode?: () => void;
  now?: () => Date;
  /**
   * How a file reaches the scorekeeper's downloads folder.
   *
   * Injected on the same terms as `downloadDiagnostics`'s own `write`: a test needs to know a file
   * was offered without jsdom having anywhere to put it, and a seam that already exists one layer
   * down should not stop here.
   */
  write?: (contents: string, fileName: string) => boolean;
}

interface IState {
  thrown: unknown;
  crashed: boolean;
  crashCount: number;
  diagnostics: SaveState;
  journal: SaveState;
  journalInspection: IJournalInspection[];
}

const initialState: IState = {
  thrown: undefined,
  crashed: false,
  crashCount: 0,
  diagnostics: 'idle',
  journal: 'idle',
  journalInspection: [],
};

export default class RenderErrorBoundary extends Component<IProps, IState> {
  state: IState = initialState;

  static getDerivedStateFromError(thrown: unknown): Partial<IState> {
    return { thrown, crashed: true };
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    const log = this.props.log ?? errorLog;
    // The component stack is the one piece of context `window.onerror` could never have supplied,
    // and it is the piece that says which screen was on the scoresheet. `record` redacts and
    // truncates it like everything else.
    const where = info.componentStack?.trim().split('\n')[0]?.trim();
    log.record('render', thrown, where === '' ? undefined : where);
    // `undefined` means "nobody said", which is the real browser. An explicit `null` is a test
    // saying "this device has no session storage", and `??` would quietly overrule it.
    const storage = this.props.storage !== undefined ? this.props.storage : sessionStore();
    let journalInspection: IJournalInspection[] = [];
    try {
      journalInspection = inspectBrowserJournals(this.now()).entries;
    } catch {
      // The boundary must remain renderable even when a storage implementation misbehaves while it
      // is being inspected. The raw export action still has its own defensive path.
    }
    this.setState({ crashCount: recordCrash(storage), journalInspection });
  }

  private now(): Date {
    return this.props.now ? this.props.now() : new Date();
  }

  private reload = (): void => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  };

  private openRecoveryMode = (): void => {
    if (this.props.onRecoveryMode) {
      this.props.onRecoveryMode();
      return;
    }
    if (typeof window !== 'undefined') window.location.assign(recoveryModeHref(window.location));
  };

  private saveDiagnostics = (): void => {
    // The bundle collects the timeline and the error log from their module-level singletons, so it
    // carries the crash that produced this screen without anything being threaded down here.
    const outcome = this.props.write
      ? downloadDiagnostics({ now: this.now() }, [], this.props.write)
      : downloadDiagnostics({ now: this.now() });
    this.setState({ diagnostics: outcome.ok ? 'saved' : 'failed' });
  };

  private saveJournal = (): void => {
    const journals = exportJournals();
    if (Object.keys(journals).length === 0) {
      this.setState({ journal: 'empty' });
      return;
    }
    const now = this.now();
    const write = this.props.write ?? downloadFile;
    const written = write(journalFileContents(journals, now), journalFileName(now));
    this.setState({ journal: written ? 'saved' : 'failed' });
  };

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;

    const repeating = this.state.crashCount >= repeatCrashThreshold;
    const journalFact = summarizeJournalRecovery(this.state.journalInspection);
    const savedProgress =
      journalFact.kind === 'valid'
        ? journalFact.questionNumber === undefined
          ? 'Your scoring journal is saved on this device.'
          : `Your scoring through TU ${journalFact.questionNumber} is saved on this device.`
        : journalFact.kind === 'unverified'
          ? 'QBSheet found recovery data on this device, but could not verify the newest journal.'
          : 'QBSheet could not verify a saved scoring journal on this device.';

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-panel">
          <h1 className="crash-title">QBSheet stopped drawing the scoresheet</h1>

          {repeating ? (
            <>
              <p className="crash-lead">QBSheet keeps crashing while opening this game.</p>
              <p className="crash-lead">{savedProgress}</p>
              <p className="crash-body">
                Use Recovery Mode to inspect the copies QBSheet can read. Save the raw journal before asking
                anyone to clear browser data; it preserves exactly what was stored, even when this build
                cannot verify it.
              </p>
            </>
          ) : (
            <>
              <p className="crash-lead">{savedProgress}</p>
              <p className="crash-body">
                {journalFact.kind === 'valid'
                  ? 'Reload to return to the question you were on. Every accepted operation in this journal was written before the screen went wrong.'
                  : 'Reload may help with a temporary drawing problem. If it happens again, use Recovery Mode or save the raw journal; do not clear this device’s recovery data.'}
              </p>
            </>
          )}

          <div className="crash-actions">
            <button
              type="button"
              className={`crash-button${repeating ? '' : ' is-primary'}`}
              onClick={this.reload}
            >
              Reload the scoresheet
            </button>
            <button
              type="button"
              className={`crash-button${repeating ? ' is-primary' : ''}`}
              onClick={this.openRecoveryMode}
            >
              Open Recovery Mode
            </button>
            <button type="button" className="crash-button" onClick={this.saveJournal}>
              Save recovery file
            </button>
            <button type="button" className="crash-button" onClick={this.saveDiagnostics}>
              Save diagnostics
            </button>
          </div>

          {this.state.journal !== 'idle' && (
            <p className="crash-note" role="status">
              {this.state.journal === 'saved' && 'Recovery file saved to this device’s downloads.'}
              {this.state.journal === 'empty' && 'There is no in-progress game saved on this device.'}
              {this.state.journal === 'failed' &&
                'This browser refused the download. Try again, or check its download settings.'}
            </p>
          )}
          {this.state.diagnostics !== 'idle' && (
            <p className="crash-note" role="status">
              {this.state.diagnostics === 'saved' && 'Diagnostics saved to this device’s downloads.'}
              {this.state.diagnostics === 'failed' && 'This browser refused the diagnostics download.'}
            </p>
          )}

          {/* Shown, not hidden. A director reading over a shoulder gets further with the real
              message than with a reference number. Redacted and truncated on exactly the same terms
              as the copy `ErrorLog` keeps -- a stack trace is precisely the sort of string that
              quietly contains a URL with a token in its query. */}
          <details className="crash-details">
            <summary>What went wrong</summary>
            <p className="crash-thrown">{redact(describeThrown(this.state.thrown)).slice(0, messageLimit)}</p>
          </details>
        </div>
      </div>
    );
  }
}
