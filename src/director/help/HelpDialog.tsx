import { useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Dialog } from '../components/Dialog';
import { modifierKeyLabel, shortcutAriaLabel } from '../components/platform';

/**
 * The shortcuts, with the modifier rendered for *this* platform.
 *
 * The help table used to print `⌘ + K / Ctrl + K`, hedging on both. `keys` is
 * now resolved at render time, so a Windows operator reads `Ctrl K` and a Mac
 * operator reads `⌘K` — the same convention the top-bar keycap uses.
 */
export const DIRECTOR_SHORTCUTS = [
  { key: 'k', modifier: true, description: 'Focus tournament search', action: 'search-focus' },
  { keys: ['↑', '↓'], description: 'Move active search result', action: 'search-navigate' },
  { keys: ['Enter'], description: 'Open active search result', action: 'search-open' },
  { keys: ['Escape'], description: 'Close search, menu, or dialog', action: 'escape' },
] as const;

/**
 * Help, on the shared dialog language.
 *
 * It used to hand-roll its own `<dialog>`, its own header, and its own
 * focus/restore logic — and its class names (`director-help-dialog-header`)
 * were then reused as generic modal infrastructure by three unrelated dialogs.
 * It is now an ordinary `Dialog` like every other focused surface in Director.
 */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const scrollToHelpSection = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href?.startsWith('#')) return;
    const sectionId = href.slice(1);
    const target = document.getElementById(sectionId);
    if (!target || !bodyRef.current?.contains(target)) return;

    // These links navigate inside a modal, not to a new application location. Letting the browser
    // follow the fragment would add each help section to history, so Back could walk through stale
    // #help-* entries after the dialog had closed.
    event.preventDefault();
    target.scrollIntoView({ block: 'start' });
  };

  if (!open) return null;
  return (
    <Dialog
      title="Help & keyboard shortcuts"
      size="lg"
      onClose={onClose}
      cancelLabel="Close"
      className="director-help-dialog"
    >
      <div className="director-help-dialog-body" ref={bodyRef}>
        <nav aria-label="Help sections" className="director-help-toc">
          <a href="#help-getting-started" onClick={scrollToHelpSection}>
            Getting started
          </a>
          <a href="#help-planning" onClick={scrollToHelpSection}>
            Planning a tournament
          </a>
          <a href="#help-running" onClick={scrollToHelpSection}>
            Running rounds
          </a>
          <a href="#help-results" onClick={scrollToHelpSection}>
            Results / review
          </a>
          <a href="#help-transfers" onClick={scrollToHelpSection}>
            Transfers / USB workflow
          </a>
          <a href="#help-qbtcp" onClick={scrollToHelpSection}>
            QBTCP troubleshooting
          </a>
          <a href="#help-live" onClick={scrollToHelpSection}>
            QBSheet Live troubleshooting
          </a>
          <a href="#help-storage" onClick={scrollToHelpSection}>
            Recovery & storage
          </a>
          <a href="#help-shortcuts" onClick={scrollToHelpSection}>
            Keyboard shortcuts
          </a>
        </nav>

        <section id="help-getting-started">
          <h3>Getting started</h3>
          <p>
            Director is offline-first. Create a tournament with a name and date, add teams and rooms, choose a
            format, then generate the schedule. No internet or account is required.
          </p>
        </section>

        <section id="help-planning">
          <h3>Planning a tournament</h3>
          <p>
            Everything under <strong>Plan</strong> in the sidebar: Teams, Format, Rooms, Packets. The
            attention list on Overview shows what is still missing.
          </p>
          <ul>
            <li>Add confirmed teams before generating a schedule.</li>
            <li>Choose packet assignments per round.</li>
            <li>
              Set the tournament timezone in Settings; it is the event&apos;s zone, not the laptop&apos;s.
            </li>
          </ul>
        </section>

        <section id="help-running">
          <h3>Running rounds</h3>
          <p>
            <strong>Tournament day</strong> holds the sequence of rounds and the breaks between them. Each
            round has one main action for where it stands: <strong>Start round</strong>, then
            <strong> Finish round</strong> once its results are in. Finishing a round does not complete the
            tournament.
          </p>
          <p>
            The lower-level transitions the storage layer uses — prepare, release, close, and the round
            revision — live under <strong>Advanced &amp; recovery</strong> in a round&apos;s actions. They are
            there for recovering from a problem, not for running the day.
          </p>
        </section>

        <section id="help-results">
          <h3>Results / review</h3>
          <p>
            Incoming results appear under <strong>Results</strong> in a review queue. Accept or reject them
            there; accepted results update Standings and the QBSheet Live projection. Protests and
            scheduled-game administration are separate views on the same destination.
          </p>
        </section>

        <section id="help-transfers">
          <h3>Transfers / USB workflow</h3>
          <p>
            Use Transfers to import files from USB or watch a folder. Supported: Director .json, QBJ, and
            portable .qbst archives. Checksum and duplicate handling is automatic.
          </p>
        </section>

        <section id="help-qbtcp">
          <h3>QBTCP troubleshooting</h3>
          <p>
            QBTCP runs on the local network via the Tauri Director app. Browser preview cannot start the
            server.
          </p>
          <ul>
            <li>Ensure Director and scorekeeper devices are on the same LAN.</li>
            <li>Check firewall allows the reported port.</li>
            <li>Pair each room once; a pairing code expires after use.</li>
          </ul>
        </section>

        <section id="help-live">
          <h3>QBSheet Live troubleshooting</h3>
          <p>Live publishes a sanitized snapshot; private data never leaves Director.</p>
          <ul>
            <li>Local network mode serves Live Web from Director&apos;s LAN address — no internet needed.</li>
            <li>Cloud mode requires a backend origin and a one-time setup token.</li>
            <li>If publication shows error, check the Live panel&apos;s status and retry.</li>
          </ul>
        </section>

        <section id="help-storage">
          <h3>Recovery & storage</h3>
          <p>
            Director saves continuously to this computer. Before a risky change, take a recovery checkpoint
            from <strong>Settings → Recovery</strong>; restoring one rolls the tournament back to that point.
            If a save ever fails, Director keeps the tournament open in memory and offers both a retry and a
            recovery archive so nothing is lost.
          </p>
        </section>

        <section id="help-shortcuts">
          <h3>Keyboard shortcuts</h3>
          <table className="director-table director-help-shortcuts">
            <thead>
              <tr>
                <th>Shortcut</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {DIRECTOR_SHORTCUTS.map((shortcut) => {
                const modified = 'modifier' in shortcut && shortcut.modifier;
                const keys = modified
                  ? [modifierKeyLabel(), (shortcut.key as string).toUpperCase()]
                  : [...((shortcut as { keys: readonly string[] }).keys ?? [])];
                return (
                  <tr key={shortcut.action}>
                    <td>
                      <span
                        aria-label={modified ? shortcutAriaLabel(shortcut.key as string) : keys.join(' or ')}
                      >
                        {keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                    </td>
                    <td>{shortcut.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Search: type to filter teams, players, rooms, packets, and games. Arrow keys move focus, Enter
            opens the highlighted result, Escape clears/closes.
          </p>
          <p>Dialogs: Escape closes, focus is trapped while open and returns to the triggering button.</p>
        </section>

        {/*
          These are the only two links in Director that leave the application. Followed in place they
          replace the running tournament with a GitHub page, and Director has no browser chrome to
          come back with. They open in a new context, like every external link on the About site.
        */}
        <p className="director-help-footnote">
          Full docs:{' '}
          <a
            href="https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            QBTCP
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>{' '}
          ·{' '}
          <a
            href="https://github.com/gbyo/qbsheet/blob/main/docs/QBLIVE.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            QBLive
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>{' '}
          (online, optional)
        </p>
      </div>
    </Dialog>
  );
}
