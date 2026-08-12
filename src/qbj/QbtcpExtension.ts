/**
 * The `_qbtcp` extension: operational information that standard QBJ cannot represent.
 *
 * # The rule this file exists to enforce
 *
 * Nothing goes in here that QBJ can already say. Not the tournament name, not `Match.id`, not team
 * or player names, not the room display name that `Match.location` carries, not the packet, not a
 * standard scoring-rule value, not the round name. Every one of those has a standard field, and
 * duplicating it creates two places for it to disagree — with the copy a generic consumer ignores
 * being the one that goes stale.
 *
 * What is left is genuinely five things: which issue of a round's pairings this came from, a stable
 * room id where that differs in kind from a display name, how the room conducts the game, what to do
 * with the finished file, and whether the round is timed. QBJ has no field for any of them.
 *
 * # A constraint discovered in the reference parser, not guessed at
 *
 * The reference tournament-control implementation runs `snakeCaseToCamelCase` over every parsed QBJ
 * document. It converts an explicit table of known QBJ key names to camelCase and deletes the
 * snake_case originals — and it recurses into every nested object, including this one.
 *
 * Unknown keys survive untouched, which is why `_qbtcp` arrives intact. But a key *inside* this
 * extension whose name collides with that table would be silently rewritten and the original
 * deleted. So the field names below are checked against it, and any field added later must be too.
 * `round_revision`, `room_id`, `handoff_instruction`, `procedure` and `timed` are all absent from
 * that table and are therefore safe.
 *
 * This is a documented compatibility compromise with a deployed parser, not a preference.
 *
 * # Non-secret, by construction
 *
 * There is no field here for a token, a pairing code, a device id, a server address, or a session.
 * A QBJ document travels by USB stick and email; see `PortableQbj` for the boundary that enforces
 * this on the way out.
 */
import { IRoomProcedure, isKnownRoomProcedureVersion, readRoomProcedure } from '../scoring/RoomProcedure';
import { QbjObject, isPlainObject, nonBlankString } from './QbjSerialization';

/** The extension namespace. One key, attached to the Match. */
export const qbtcpExtensionKey = '_qbtcp';

/** Bumped only if the block's shape changes incompatibly. An unknown version is ignored, not refused. */
export const qbtcpExtensionVersion = 1;

const maxHandoffInstructionLength = 2000;

/** Scoring semantics QBJ genuinely cannot express. Exactly one, and it stays that way by design. */
export interface IQbtcpScorekeeper {
  /**
   * Whether rounds run on a clock.
   *
   * `IQbjScoringRules` has no field for this; the reference implementation keeps it outside QBJ in
   * its own file extension. A timed round ends when the moderator calls time rather than after a
   * fixed tossup count, so a scorer that assumes wrong either stops a game early or runs past it.
   */
  timed?: boolean;
}

export interface IQbtcpExtension {
  version: number;
  /**
   * Which issue of this round's pairings the assignment came from.
   *
   * QBJ has no concept of a pairing being redrawn. Without this, a result scored against a bracket
   * that has since been rebuilt is indistinguishable from a current one, and tournament control has
   * to ask the room which it was.
   */
  roundRevision?: number;
  /** A stable room identity, which survives "Room 204" being renamed to "Library". */
  roomId?: string;
  /** Halves, clock and timeouts. Operations, not scoring; QBJ models scoring. */
  procedure?: IRoomProcedure;
  /**
   * A `procedure` that was sent but written in a shape this build cannot interpret, by its version.
   *
   * Separate from `procedure` being absent, and the distinction is the point. Absent means the
   * tournament stated no procedural rules, and scoring without enforcement is exactly right. This
   * means the tournament stated some and they did not arrive — and the two must not lead to the same
   * place, because the default when no procedure is present is `any-boundary`, the *permissive*
   * substitution policy. Collapsing the second case into the first is how a room running an old
   * build gets more freedom than the tournament granted it, silently, on the strength of being out
   * of date. See `unsupportedProcedureMessage` for what a room is told.
   */
  unsupportedProcedureVersion?: number;
  /** What the room should do with the finished file, in the tournament's own words. */
  handoffInstruction?: string;
  scorekeeper?: IQbtcpScorekeeper;
}

/**
 * Read the extension from any QBJ object that might carry one.
 *
 * Never throws and never refuses the document: an unreadable extension means the operational extras
 * are unavailable, which degrades to a perfectly scoreable generic QBJ. Refusing a whole assignment
 * over a malformed optional block would be the wrong trade every time.
 *
 * `procedure` is the one field that does not degrade quietly, because it is the one field whose
 * absence is *more* permissive than its presence. A version this build does not know is reported as
 * `unsupportedProcedureVersion` and left for the caller to refuse rather than dropped here.
 */
export function readQbtcpExtension(value: unknown): IQbtcpExtension | null {
  if (!isPlainObject(value)) return null;
  const raw = value[qbtcpExtensionKey];
  if (!isPlainObject(raw)) return null;

  const version = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 0;
  if (version < 1 || version > qbtcpExtensionVersion) return null;

  const extension: IQbtcpExtension = { version };

  if (Number.isInteger(raw.round_revision) && Number(raw.round_revision) >= 1) {
    extension.roundRevision = Number(raw.round_revision);
  }
  if (nonBlankString(raw.room_id)) extension.roomId = raw.room_id;
  if (typeof raw.handoff_instruction === 'string' && raw.handoff_instruction.length <= maxHandoffInstructionLength) {
    if (raw.handoff_instruction.trim() !== '') extension.handoffInstruction = raw.handoff_instruction;
  }
  if (isPlainObject(raw.procedure)) {
    if (isKnownRoomProcedureVersion(raw.procedure.version)) {
      extension.procedure = readRoomProcedure(raw.procedure);
    } else {
      // Zero for a procedure with no usable version on it at all, which is the same problem: rules
      // were sent and this build cannot tell what they say.
      const stated = raw.procedure.version;
      extension.unsupportedProcedureVersion = typeof stated === 'number' && Number.isFinite(stated) ? stated : 0;
    }
  }
  if (isPlainObject(raw.scorekeeper) && typeof raw.scorekeeper.timed === 'boolean') {
    extension.scorekeeper = { timed: raw.scorekeeper.timed };
  }

  return extension;
}

/**
 * What a room is told when an assignment states procedure rules this build cannot read.
 *
 * Names the version and says what fixes it, because the two things a scorekeeper standing in a room
 * needs are "this is not my mistake" and "who do I go to". It deliberately does not offer to score
 * the game without the rules: that offer is the permissive fallback this whole path exists to
 * prevent, and it is tournament control's call to make, not a busy room's.
 *
 * Worded to match `GamePackageValidation`, which has always refused an unknown procedure version in a
 * `.qbg` file — and so has the pre-QBTCP connected path, which runs through the same validation. This
 * is that same rule reaching the one route that was missing it.
 */
export function unsupportedProcedureMessage(version: number): string {
  const which = version > 0 ? `version ${version}` : 'a version it does not state';
  return (
    `This game's tournament procedure is written in ${which}, which this scoresheet does not know how ` +
    'to read. Update QBSheet, or ask tournament control for an assignment this build can enforce. ' +
    'Scoring it without those rules could allow substitutions the tournament does not.'
  );
}

/**
 * Build the extension block, or null when there is nothing operational to say.
 *
 * Returning null rather than an empty object matters: an assignment with no extras should carry no
 * extension at all, so that a generic consumer sees plain QBJ and a reader here does not have to
 * distinguish "absent" from "present but empty".
 */
export function buildQbtcpExtension(extension: Omit<IQbtcpExtension, 'version'>): QbjObject | null {
  const block: QbjObject = { version: qbtcpExtensionVersion };
  let carriesSomething = false;

  if (extension.roundRevision !== undefined && Number.isInteger(extension.roundRevision)) {
    block.round_revision = extension.roundRevision;
    carriesSomething = true;
  }
  if (nonBlankString(extension.roomId)) {
    block.room_id = extension.roomId;
    carriesSomething = true;
  }
  if (extension.procedure) {
    block.procedure = extension.procedure as unknown as QbjObject;
    carriesSomething = true;
  }
  if (nonBlankString(extension.handoffInstruction, maxHandoffInstructionLength)) {
    block.handoff_instruction = extension.handoffInstruction;
    carriesSomething = true;
  }
  if (extension.scorekeeper?.timed !== undefined) {
    block.scorekeeper = { timed: extension.scorekeeper.timed };
    carriesSomething = true;
  }

  return carriesSomething ? block : null;
}

/** Attach the extension to a QBJ object, when there is one to attach. */
export function withQbtcpExtension(target: QbjObject, extension: Omit<IQbtcpExtension, 'version'>): QbjObject {
  const block = buildQbtcpExtension(extension);
  if (!block) return target;
  return { ...target, [qbtcpExtensionKey]: block };
}
