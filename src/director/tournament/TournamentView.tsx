import { useEffect, useState } from 'react';
import { latestRound, runPreflight, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import {
  isNativeDirector,
  readNativeServerStatus,
  issueNativeRoomPairing,
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
  const [pairingRoomId, setPairingRoomId] = useState<string | null>(null);
  const nativeDirector = isNativeDirector();
  const issues = runPreflight(state, server.running, nativeDirector);
  const round =
    state.rounds.find((entry) => entry.id === state.tournament?.currentRoundId) ?? latestRound(state.rounds);
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
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'The QBTCP server could not be changed.');
    } finally {
      setServerLoading(false);
    }
  };
  const copyPairingLink = async (url: string, message: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(url);
      onAnnounce(message);
    } catch {
      onAnnounce('The pairing link could not be copied; use the link shown in the desktop app.');
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
  const pairingRooms = state.rooms.filter((room) => room.available && room.status === 'available');
  const invitations = server.pairingInvitations ?? [];
  const issuePairing = async (roomId: string) => {
    setPairingRoomId(roomId);
    try {
      const invitation = await issueNativeRoomPairing(roomId);
      setServer((previous) => {
        const current = (previous.pairingInvitations ?? []).filter((entry) => entry.roomId !== roomId);
        const nextInvitations = [...current, invitation].sort((left, right) =>
          left.roomId.localeCompare(right.roomId),
        );
        return {
          ...previous,
          pairingInvitations: nextInvitations,
          pairingCode: nextInvitations.length === 1 ? nextInvitations[0].pairingCode : undefined,
          pairingUrl: nextInvitations.length === 1 ? nextInvitations[0].pairingUrl : undefined,
        };
      });
      onAnnounce(`Pairing invitation issued for ${invitation.roomName}.`);
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'A room pairing invitation could not be issued.');
    } finally {
      setPairingRoomId(null);
    }
  };
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
                .then(() => onAnnounce('Checkpoint created.'))
                .catch((reason: unknown) =>
                  onAnnounce(reason instanceof Error ? reason.message : 'Checkpoint could not be saved.'),
                );
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
              {controller.qbtcpHealth.error && (
                <p className="director-error-copy" role="alert">
                  {controller.qbtcpHealth.error}
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
              {nativeDirector ? (
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
              ) : (
                <span className="director-muted">Desktop app required to start the LAN server</span>
              )}
              {!serverLoading && server.pairingUrl && invitations.length <= 1 && (
                <Button
                  variant="quiet"
                  onClick={() => void copyPairingLink(server.pairingUrl ?? '', 'Pairing link copied.')}
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
                              const prepared = controller.prepareRound(entry.id);
                              onAnnounce(
                                prepared
                                  ? `${entry.name} prepared.`
                                  : `${entry.name} could not be prepared; review the schedule first.`,
                              );
                            }}
                          >
                            Prepare
                          </Button>
                        )}
                        {entry.status === 'prepared' && (
                          <Button
                            variant="primary"
                            onClick={() => {
                              const released = controller.releaseRound(entry.id);
                              onAnnounce(
                                released
                                  ? `${entry.name} released.`
                                  : 'The round is not ready to release; review the Director error and room assignments.',
                              );
                            }}
                          >
                            Release
                          </Button>
                        )}
                        {entry.status === 'released' && (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              const closed = controller.closeRound(entry.id);
                              onAnnounce(
                                closed
                                  ? `${entry.name} closed.`
                                  : `${entry.name} could not close; accept or cancel every game first.`,
                              );
                            }}
                          >
                            Close
                          </Button>
                        )}
                        {/*
                          A shortcut, not a second implementation. Preparing files is one subsystem
                          with one page; this navigates to it rather than growing a parallel
                          prepare-and-write path inside round control.
                        */}
                        {entry.status !== 'planned' && (
                          <Button variant="quiet" icon="upload" onClick={() => onNavigate('transfers')}>
                            Prepare assignment files
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
        {nativeDirector && server.running && (
          <section className="director-panel director-pairing-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Pairing</p>
                <h2>Room invitations</h2>
              </div>
              <StateLabel state="paired" label="Room-specific" />
            </div>
            <div className="director-panel-body director-panel-body-list">
              <p className="director-panel-footnote">
                Each invitation is scoped to one room. Codes expire after{' '}
                {invitations[0]?.expiresInSeconds ?? 900} seconds and are not persisted in QBJ.
              </p>
              <ul className="director-list">
                {pairingRooms.length === 0 ? (
                  <li>
                    <span>No available rooms are configured.</span>
                  </li>
                ) : (
                  pairingRooms.map((room) => {
                    const invitation = invitations.find((entry) => entry.roomId === room.id);
                    return (
                      <li key={room.id}>
                        <div>
                          <strong>{room.name}</strong>
                          {invitation ? (
                            <small className="director-mono">{invitation.pairingCode}</small>
                          ) : (
                            <small>No active invitation</small>
                          )}
                        </div>
                        <div className="director-row-actions">
                          {invitation?.pairingUrl && (
                            <Button
                              variant="quiet"
                              onClick={() =>
                                void copyPairingLink(
                                  invitation.pairingUrl ?? '',
                                  `${room.name} pairing link copied.`,
                                )
                              }
                            >
                              Copy link
                            </Button>
                          )}
                          {invitation && !invitation.pairingUrl && (
                            <small className="director-muted">Code only; no LAN address found</small>
                          )}
                          <Button
                            variant={invitation ? 'quiet' : 'primary'}
                            disabled={pairingRoomId !== null}
                            onClick={() => void issuePairing(room.id)}
                          >
                            {pairingRoomId === room.id
                              ? 'Issuing…'
                              : invitation
                                ? 'Issue new'
                                : 'Issue pairing'}
                          </Button>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
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
