import { useEffect, useState } from 'react';
import { runPreflight, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import {
  isNativeDirector,
  readNativeServerStatus,
  startNativeServer,
  stopNativeServer,
  type NativeServerStatus,
} from '../platform/native';
import type { SectionId } from '../app/navigation';

export function TournamentView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const [server, setServer] = useState<NativeServerStatus>({ running: false });
  const [serverLoading, setServerLoading] = useState(true);
  const nativeDirector = isNativeDirector();
  const issues = runPreflight(state, server.running);
  const round =
    state.rounds.find((entry) => entry.id === state.tournament?.currentRoundId) ?? state.rounds.at(-1);
  useEffect(() => {
    let mounted = true;
    void readNativeServerStatus()
      .then((next) => {
        if (!mounted) return;
        setServer(next);
        setServerLoading(false);
      })
      .catch((reason: unknown) => {
        if (!mounted) return;
        setServer({
          running: false,
          message: reason instanceof Error ? reason.message : 'Server status could not be read.',
        });
        setServerLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const toggleServer = async () => {
    setServerLoading(true);
    try {
      const next = server.running ? await stopNativeServer() : await startNativeServer();
      setServer(next);
      onAnnounce(next.message ?? (next.running ? 'QBTCP server started.' : 'QBTCP server stopped.'));
    } finally {
      setServerLoading(false);
    }
  };
  const serverHasError = !serverLoading && nativeDirector && !server.running && Boolean(server.message);
  const serverState = serverLoading
    ? 'waiting'
    : serverHasError
      ? 'error'
      : server.running
        ? 'connected'
        : 'not-started';
  const serverLabel = serverLoading
    ? 'Checking'
    : serverHasError
      ? 'Error'
      : server.running
        ? 'Running'
        : 'Stopped';
  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Tournament control"
        description="Prepare, release, monitor, and close rounds from one operational view."
        actions={
          <Button
            variant="primary"
            icon="clipboard"
            onClick={() => {
              void controller
                .checkpoint('running the tournament')
                .then(() => onAnnounce('Checkpoint created.'));
            }}
          >
            Create checkpoint
          </Button>
        }
      />
      <div className="director-page-stack">
        <div className="director-two-column">
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Preflight</p>
                <h2>
                  {issues.length === 0
                    ? 'Ready to run'
                    : `${issues.length} check${issues.length === 1 ? '' : 's'} to review`}
                </h2>
              </div>
              <StateLabel
                state={
                  issues.some((issue) => issue.severity === 'blocker')
                    ? 'blocker'
                    : issues.length
                      ? 'warning'
                      : 'ready'
                }
                label={
                  issues.some((issue) => issue.severity === 'blocker')
                    ? 'Blocked'
                    : issues.length
                      ? 'Review'
                      : 'Ready'
                }
              />
            </div>
            {issues.length === 0 ? (
              <div className="director-panel-body">
                <p className="director-empty-copy">
                  The tournament has a valid plan, schedule, and storage checkpoint.
                </p>
              </div>
            ) : (
              <div className="director-panel-body director-panel-body-list">
                <ul className="director-list director-preflight-list">
                  {issues.map((issue) => (
                    <li key={issue.id}>
                      <StateLabel state={issue.severity} label={issue.severity} />
                      <div>
                        <strong>{issue.message}</strong>
                        <small>
                          {issue.area}
                          {issue.action ? ` · ${issue.action}` : ''}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="director-inline-action"
                        onClick={() => onNavigate(sectionForArea(issue.area))}
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">QBTCP server</p>
                <h2>Local network</h2>
              </div>
              <StateLabel state={serverState} label={serverLabel} />
            </div>
            <div className="director-panel-body">
              <dl className="director-detail-list director-detail-list-large">
                <div>
                  <dt>Address</dt>
                  <dd className="director-mono">
                    {server.running && server.address
                      ? `${server.address}${server.port ? `:${server.port}` : ''}`
                      : 'Not listening'}
                  </dd>
                </div>
                <div>
                  <dt>Paired rooms</dt>
                  <dd>{server.running ? (server.pairedRooms ?? state.qbtcpSessions.length) : '—'}</dd>
                </div>
                <div>
                  <dt>Protocol</dt>
                  <dd>{server.running ? (server.protocol ?? 'QBTCP v1') : '—'}</dd>
                </div>
              </dl>
              {serverHasError && (
                <p className="director-error-copy" role="alert">
                  {server.message}
                </p>
              )}
              {!nativeDirector && (
                <p className="director-panel-footnote">
                  The browser preview can plan and score manual games. Start the Tauri Director app for the
                  native LAN server.
                </p>
              )}
            </div>
            <div className="director-panel-footer">
              <Button
                variant={server.running ? 'secondary' : 'primary'}
                icon={server.running ? 'pause' : 'play'}
                disabled={serverLoading}
                onClick={() => {
                  void toggleServer();
                }}
              >
                {serverLoading ? 'Checking server' : server.running ? 'Stop server' : 'Start server'}
              </Button>
              {!serverLoading && server.pairingUrl && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    void navigator.clipboard?.writeText(server.pairingUrl ?? '');
                    onAnnounce('Pairing link copied.');
                  }}
                >
                  Copy pairing link
                </Button>
              )}
            </div>
          </section>
        </div>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Round sequence</p>
              <h2>
                {state.rounds.length
                  ? `${state.rounds.length} generated round${state.rounds.length === 1 ? '' : 's'}`
                  : 'No rounds generated'}
              </h2>
            </div>
            <Button variant="secondary" onClick={() => onNavigate('format')}>
              Edit format
            </Button>
          </div>
          {state.rounds.length === 0 ? (
            <div className="director-panel-body">
              <div className="director-empty-inline">
                <p>Add confirmed teams and available rooms, then generate the first round.</p>
                <Button variant="primary" onClick={() => onNavigate('teams')}>
                  Review teams
                </Button>
              </div>
            </div>
          ) : (
            <div className="director-panel-body director-panel-body-list">
              <ol className="director-list director-round-list">
                {state.rounds.map((entry) => {
                  const games = state.scheduledGames.filter((game) => game.roundId === entry.id);
                  const accepted = games.filter((game) => game.status === 'accepted').length;
                  return (
                    <li
                      className={`director-round-row ${entry.id === round?.id ? 'is-current' : ''}`}
                      key={entry.id}
                      aria-current={entry.id === round?.id ? 'step' : undefined}
                    >
                      <div className="director-round-number">{String(entry.number).padStart(2, '0')}</div>
                      <div>
                        <strong>{entry.name}</strong>
                        <small>
                          {games.length} game slots · {accepted} accepted · revision {entry.revision}
                        </small>
                      </div>
                      <StateLabel state={entry.status} label={entry.status} />
                      <div className="director-round-row-actions">
                        {entry.status === 'planned' && (
                          <Button
                            variant="quiet"
                            onClick={() => {
                              controller.prepareRound(entry.id);
                              onAnnounce(`${entry.name} prepared.`);
                            }}
                          >
                            Prepare
                          </Button>
                        )}
                        {entry.status === 'prepared' && (
                          <Button
                            variant="primary"
                            onClick={() => {
                              controller.releaseRound(entry.id);
                              onAnnounce(`${entry.name} released.`);
                            }}
                          >
                            Release
                          </Button>
                        )}
                        {entry.status === 'released' && (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              controller.closeRound(entry.id);
                              onAnnounce(`${entry.name} closed if all results are accepted.`);
                            }}
                          >
                            Close
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>
        {server.pairingCode && (
          <section className="director-panel director-pairing-panel">
            <div className="director-panel-body director-pairing-panel-body">
              <div>
                <p className="director-eyebrow">Pairing</p>
                <h2>Room pairing is ready</h2>
                <p>
                  Give a scorekeeper the link or code. The code is shown only in this operational panel and is
                  not persisted in QBJ.
                </p>
              </div>
              <StateLabel state="paired" label="Ready to pair" />
              <div className="director-pairing-code director-mono">{server.pairingCode}</div>
              <Icon name="server" size={28} />
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function sectionForArea(area: string): SectionId {
  return area === 'teams'
    ? 'teams'
    : area === 'format'
      ? 'format'
      : area === 'rooms'
        ? 'rooms'
        : area === 'packets'
          ? 'packets'
          : area === 'qbtcp'
            ? 'tournament'
            : area === 'storage'
              ? 'settings'
              : 'results';
}
