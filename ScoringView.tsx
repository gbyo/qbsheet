/**
 * The scorekeeping screen: a narrow host-owned status bar above MODAQ.
 *
 * MODAQ stays the primary interface. Everything YellowFruit adds is confined to one compact bar, so a
 * scorekeeper's eyes stay on the scoresheet rather than on our chrome. The bar carries the things
 * MODAQ cannot know — which room this is, which round, whether the result has reached tournament
 * control.
 *
 * It deliberately does not show a question number. MODAQ prints the question it is on a few pixels
 * below ("Question #1", with Previous/Next either side), and the only count available to a host is
 * how many questions have been *played*, which is a different number the moment a scorekeeper
 * navigates back to fix an earlier buzz. Two disagreeing question numbers on one screen is worse
 * than one, so the bar shows only what the played count is genuinely evidence of: that the game has
 * gone past regulation.
 *
 * It also says plainly that questions are read externally and that this is a scoresheet rather than a
 * packet, because the structural packet MODAQ needs in order to have any scoring cycles at all can
 * otherwise be mistaken for real question content.
 */
import { ReactNode } from 'react';
import { ModaqControl, IGameFormat, IPacket, IPlayer } from 'modaq';
import { IModaqGameFormat } from '../renderer/Services/YellowFruitScoringRulesToModaq';
import { HelpRequestCategory, IHelpRequest, IRoomPresence } from '../main/server/ServerTypes';
import RoomOperatorControls from './RoomOperatorControls';
import buildScaffoldPacket, { describeScoringBands, scaffoldPacketName } from './ScaffoldPacket';
import { connectionStatusClass, describeConnection, offlineReassurance, RoomConnectionState } from './RoomLifecycle';

/** MODAQ's custom-export callback shape, from modaq's ICustomExport */
export interface IModaqCustomExport {
  type: 'QBJ';
  label: string;
  customExportInterval: number;
  onExport: unknown;
}

export interface IScoringViewProps {
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
  roundName: string;
  leftTeamName: string;
  rightTeamName: string;
  gameFormat: IModaqGameFormat;
  players: IPlayer[];
  /** localStorage key for MODAQ's own game persistence. Stable per session. */
  // eslint-disable-next-line react/require-default-props
  storeName?: string;
  customExport: IModaqCustomExport;
  connection: RoomConnectionState;
  /** Set when the room is degraded: the game on screen is real, the room state behind it is stale */
  // eslint-disable-next-line react/require-default-props
  degradedMessage?: string;
  /**
   * Number of questions played so far, from the most recent snapshot.
   *
   * Not the question the scorekeeper is looking at — MODAQ owns that, and shows it. This is the
   * highest question with anything recorded against it, which is what tells us the game has run into
   * overtime.
   */
  questionsPlayed: number;
  /** True once a final has been sent and is waiting on tournament control */
  awaitingReview: boolean;
  /** Set when the last automatic upload didn't land */
  // eslint-disable-next-line react/require-default-props
  snapshotError?: string;
  // eslint-disable-next-line react/require-default-props
  operatorName?: string;
  // eslint-disable-next-line react/require-default-props
  ready?: boolean;
  // eslint-disable-next-line react/require-default-props
  readyAllowed?: boolean;
  // eslint-disable-next-line react/require-default-props
  presence?: IRoomPresence | null;
  // eslint-disable-next-line react/require-default-props
  helpRequest?: IHelpRequest | null;
  // eslint-disable-next-line react/require-default-props
  helpBusy?: boolean;
  // eslint-disable-next-line react/require-default-props
  onOperatorNameChange?: (name: string) => void;
  // eslint-disable-next-line react/require-default-props
  onReadyChange?: (ready: boolean) => void;
  // eslint-disable-next-line react/require-default-props
  onRequestHelp?: (category: HelpRequestCategory, message: string) => Promise<void>;
  // eslint-disable-next-line react/require-default-props
  onCancelHelp?: () => Promise<void>;
  // eslint-disable-next-line react/require-default-props
  onChangeRoom?: () => void;
  // eslint-disable-next-line react/require-default-props
  lifecycleNotice?: string;
  /**
   * Set when the server's view of this game no longer matches the one being scored.
   *
   * Shown rather than acted on. Replacing a game in progress with the schedule's opinion of it
   * would destroy the only record of what happened in the room.
   */
  // eslint-disable-next-line react/require-default-props
  conflictNotice?: string;
  /**
   * False when this browser could not write the result to local storage.
   *
   * The offline message promises the game is saved on this device. That promise is only made when
   * it is true, which is what this prop is for.
   */
  // eslint-disable-next-line react/require-default-props
  resultIsSaved?: boolean;
  /**
   * False when finishing this game produces a result nothing will send on its own.
   *
   * Emergency scoring is the case: it has no session to upload to, so its result is stored as a
   * non-authoritative backup and reaches the tournament only when a human imports the file. The
   * offline banner must not tell that scorekeeper to sit and wait for the connection to come back —
   * waiting is how the game ends up in nobody's standings.
   */
  // eslint-disable-next-line react/require-default-props
  automaticDelivery?: boolean;
  /** The delivery-failure notice, when the last final has not reached YellowFruit. */
  // eslint-disable-next-line react/require-default-props
  deliveryFailure?: ReactNode;
  /** The saved-results list, rendered below MODAQ. */
  // eslint-disable-next-line react/require-default-props
  savedResults?: ReactNode;
}

export default function ScoringView(props: IScoringViewProps) {
  const {
    roomName,
    roundName,
    leftTeamName,
    rightTeamName,
    gameFormat,
    players,
    storeName,
    customExport,
    connection,
    degradedMessage = '',
    questionsPlayed,
    awaitingReview,
    snapshotError,
    operatorName = '',
    ready = false,
    readyAllowed = false,
    presence = null,
    helpRequest = null,
    helpBusy = false,
    onOperatorNameChange = () => undefined,
    onReadyChange = () => undefined,
    onRequestHelp = async () => undefined,
    onCancelHelp = async () => undefined,
    onChangeRoom,
    lifecycleNotice = '',
    conflictNotice = '',
    resultIsSaved = true,
    automaticDelivery = true,
    deliveryFailure = null,
    savedResults = null,
  } = props;

  const packet = buildScaffoldPacket(gameFormat) as unknown as IPacket;
  const online = connection !== RoomConnectionState.Offline;

  const inOvertime = questionsPlayed > gameFormat.regulationTossupCount;

  return (
    <div className="room-scoring">
      {/*
        Two sentences, and the second one is a claim about this device rather than about the
        network. It is only made when local persistence actually worked; a browser that refused the
        write gets told to get the file off the machine instead. And it only promises the game will
        be sent when something is actually going to send it — an emergency game has no session to be
        uploaded to, and telling that scorekeeper to wait would leave the result with nobody.
      */}
      {!online && (
        <div className="room-banner room-banner-warning">
          <strong>Offline &mdash; keep scoring.</strong> {offlineReassurance(resultIsSaved, automaticDelivery)}
        </div>
      )}
      {conflictNotice !== '' && (
        <div className="room-banner room-banner-error" role="alert">
          <strong>{conflictNotice}</strong>
        </div>
      )}
      {deliveryFailure}
      {/*
        Deliberately small, and deliberately not about the game. YellowFruit could not tell us what
        this room is meant to be doing; the game in MODAQ below is untouched by that, and saying so
        matters more than the failure does.
      */}
      {online && degradedMessage !== '' && (
        <div className="room-banner room-banner-warning room-banner-compact" role="status">
          <strong>{degradedMessage}</strong>
          <div>Keep scoring &mdash; this game is unaffected and is saved on this device.</div>
        </div>
      )}
      {snapshotError !== undefined && snapshotError !== '' && online && (
        <div className="room-banner room-banner-warning">
          The last automatic update didn&apos;t reach YellowFruit ({snapshotError}). Scoring is unaffected.
        </div>
      )}
      {lifecycleNotice !== '' && <div className="room-banner room-banner-info">{lifecycleNotice}</div>}

      <header className="room-statusbar">
        <div className="room-statusbar-main">
          {roomName !== undefined && <span className="room-statusbar-room">{roomName}</span>}
          <span className="room-statusbar-sep" aria-hidden="true">
            ·
          </span>
          <span>{roundName}</span>
          <span className="room-statusbar-sep" aria-hidden="true">
            ·
          </span>
          <span className="room-statusbar-teams">
            {leftTeamName} <span className="room-statusbar-vs">vs</span> {rightTeamName}
          </span>
        </div>

        <div className="room-statusbar-meta">
          {inOvertime && <span className="room-tag room-tag-overtime">Overtime</span>}
          {awaitingReview && <span className="room-tag room-tag-pending">Awaiting review</span>}
          <span className={connectionStatusClass(connection)}>
            <span className="room-status-dot" aria-hidden="true" />
            {describeConnection(connection)}
          </span>
        </div>
      </header>

      <p className="room-scoresheet-note">
        Digital scoresheet &mdash; questions are read externally. {describeScoringBands(gameFormat)}
      </p>

      {onChangeRoom && (
        <RoomOperatorControls
          compact
          operatorName={operatorName}
          ready={ready}
          readyAllowed={readyAllowed}
          presence={presence}
          helpRequest={helpRequest}
          helpBusy={helpBusy}
          onOperatorNameChange={onOperatorNameChange}
          onReadyChange={onReadyChange}
          onRequestHelp={onRequestHelp}
          onCancelHelp={onCancelHelp}
          onChangeRoom={onChangeRoom}
        />
      )}

      <div className="room-modaq">
        <ModaqControl
          players={players}
          gameFormat={gameFormat as IGameFormat}
          packet={packet}
          packetName={scaffoldPacketName}
          hideNewGame
          persistState
          storeName={storeName}
          customExport={customExport as any}
        />
      </div>

      {savedResults}
    </div>
  );
}
