import { useEffect, useId, useLayoutEffect, useRef } from 'react';

export const DIRECTOR_SHORTCUTS = [
  { keys: ['⌘', 'K'], win: ['Ctrl', 'K'], description: 'Focus tournament search', action: 'search-focus' },
  { keys: ['↑', '↓'], description: 'Move active search result', action: 'search-navigate' },
  { keys: ['Enter'], description: 'Open active search result', action: 'search-open' },
  { keys: ['Escape'], description: 'Close search / dialog', action: 'escape' },
] as const;

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) previousFocusRef.current = document.activeElement as HTMLElement | null;
      if (!dialog.open) dialog.showModal();
      // Focus the close button (inside dialog) per a11y requirements.
      closeButtonRef.current?.focus();
      const handleCancel = (e: Event) => {
        e.preventDefault();
        onCloseRef.current();
      };
      dialog.addEventListener('cancel', handleCancel);
      return () => dialog.removeEventListener('cancel', handleCancel);
    } else {
      if (dialog.open) dialog.close();
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      // Restore focus to the exact control that opened the dialog, not a fixed help button.
      if (previous && document.contains(previous)) previous.focus();
    }
  }, [open]);

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} className="director-help-dialog" aria-modal="true">
      <div className="director-help-dialog-header">
        <h2 id={titleId}>Help & keyboard shortcuts</h2>
        <button
          ref={closeButtonRef}
          type="button"
          className="director-button director-button-secondary"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="director-help-dialog-body">
        <nav aria-label="Help sections" className="director-help-toc">
          <a href="#help-getting-started">Getting started</a>
          <a href="#help-planning">Planning a tournament</a>
          <a href="#help-running">Running rounds</a>
          <a href="#help-results">Results / review</a>
          <a href="#help-transfers">Transfers / USB workflow</a>
          <a href="#help-qbtcp">QBTCP troubleshooting</a>
          <a href="#help-live">QBSheet Live troubleshooting</a>
          <a href="#help-storage">Recovery & storage</a>
          <a href="#help-shortcuts">Keyboard shortcuts</a>
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
            Teams → Format → Rooms & staff → Packets. The preflight checklist on Overview shows what is
            missing.
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
            Prepare a round to assign rooms/packets, release it to publish the schedule, then close it when
            scoring is complete. Closing a round does not complete the tournament.
          </p>
        </section>

        <section id="help-results">
          <h3>Results / review</h3>
          <p>
            Incoming results appear in Results for review. Accept or reject there; accepted results update
            standings and the Live projection.
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
            Director saves to SQLite in the desktop app and IndexedDB in the browser. Use Settings → Create
            checkpoint before major changes. Restarts restore the last saved tournament.
          </p>
        </section>

        <section id="help-shortcuts">
          <h3>Keyboard shortcuts</h3>
          <p>Shortcuts are tested against actual bindings below:</p>
          <table className="director-table director-help-shortcuts">
            <thead>
              <tr>
                <th>Shortcut</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {DIRECTOR_SHORTCUTS.map((s) => (
                <tr key={s.action}>
                  <td>
                    <kbd>{s.keys.join(' + ')}</kbd>
                    {(s as unknown as { win?: string[] }).win && (
                      <span>
                        {' '}
                        / <kbd>{(s as unknown as { win: string[] }).win!.join(' + ')}</kbd>
                      </span>
                    )}
                  </td>
                  <td>{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Search: type to filter teams, players, rooms, packets, and games. Arrow keys move focus, Enter
            opens the highlighted result, Escape clears/closes.
          </p>
          <p>Dialogs: Escape closes, focus is trapped while open and returns to the triggering button.</p>
        </section>

        <p className="director-help-footnote">
          Full docs: <a href="https://github.com/gbyo/qbsheet/blob/main/docs/QBTCP.md">QBTCP</a> ·{' '}
          <a href="https://github.com/gbyo/qbsheet/blob/main/docs/QBLIVE.md">QBLive</a> (online, optional)
        </p>
      </div>
    </dialog>
  );
}
