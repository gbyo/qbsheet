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
 * `round_revision`, `assignment_revision`, `room_id`, `handoff_instruction`, `procedure` and `timed`
 * are all absent from that table and are therefore safe. `definition_revision` and
 * `definition_digest` are equally novel: standard QBJ has no definition keys (a Match cannot name
 * the revision of the competitive truth it was scored under), so there is nothing in a known-key
 * table for them to collide with.
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
  /** Which issue of this room's assignment was sent, separate from the round's pairing revision. */
  assignmentRevision?: number;
  /**
   * Which issued competitive-definition revision the room scored under (#670).
   *
   * QBJ cannot express "the second issue of the rules for this game" canonically: the pairing
   * can be current while the scoring definition differs, so overloading `assignment_revision`
   * would conflate two independent staleness axes.
   */
  definitionRevision?: number;
  /**
   * Digest over the canonical competitive semantics actually used (#667).
   *
   * The revision is convenient and auditable; the digest proves equality. A result that echoes
   * a digest Director never issued is review-required, never silently equivalent.
   */
  definitionDigest?: string;
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
  /**
   * What this file is: an unplayed assignment, a mid-game copy, or a finished result.
   *
   * Declared by the writer at the moment of writing — never inferred from the score by the
   * reader. A forfeit or a game ended early is still `complete` when it leaves through the
   * finished path, and a blowout is still `partial` when it leaves through the mid-game path.
   * Consumers that cannot see a state they understand treat the file as not-a-result rather
   * than guessing.
   */
  fileState?: FileState;
  scorekeeper?: IQbtcpScorekeeper;
}

/** The lifecycle state of a file-handoff document. Novel key, like the rest of this block. */
export type FileState = 'assignment' | 'partial' | 'complete';

/**
 * Read the extension from any QBJ object that might carry one.
 *
 * Never throws and never refuses the document: an unreadable extension means the operational extras
 * are unavailable, which degrades to a perfectly scoreable generic QBJ. Refusing a whole assignment
 * over a malformed optional block would be the wrong trade every time.
 *
 * `procedure` is the one field that does not degrade quietly, because it is the one field whose
 * absence is *more* permissive than its presence. A version this build does not know is reported as
 * `unsupportedProcedureVersion` and left for the caller to refuse rather than dropped here — and so is
 * a `procedure` that is present but unreadable in any other way, since "no rules were sent" and "the
 * rules were unreadable" must not arrive at the caller as the same thing.
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
  if (Number.isInteger(raw.assignment_revision) && Number(raw.assignment_revision) >= 1) {
    extension.assignmentRevision = Number(raw.assignment_revision);
  }
  if (Number.isInteger(raw.definition_revision) && Number(raw.definition_revision) >= 1) {
    extension.definitionRevision = Number(raw.definition_revision);
  }
  if (nonBlankString(raw.definition_digest)) extension.definitionDigest = raw.definition_digest;
  if (nonBlankString(raw.room_id)) extension.roomId = raw.room_id;
  if (
    typeof raw.handoff_instruction === 'string' &&
    raw.handoff_instruction.length <= maxHandoffInstructionLength
  ) {
    if (raw.handoff_instruction.trim() !== '') extension.handoffInstruction = raw.handoff_instruction;
  }
  if (isPlainObject(raw.procedure)) {
    if (isKnownRoomProcedureVersion(raw.procedure.version)) {
      extension.procedure = readRoomProcedure(raw.procedure);
    } else {
      // Zero for a procedure with no usable version on it at all, which is the same problem: rules
      // were sent and this build cannot tell what they say.
      const stated = raw.procedure.version;
      extension.unsupportedProcedureVersion =
        typeof stated === 'number' && Number.isFinite(stated) ? stated : 0;
    }
  } else if (raw.procedure !== undefined) {
    // Present but not an object at all — null, an array, a string. Every other field here degrades to
    // absent when it arrives malformed, and this is the one field where that is the wrong trade: rules
    // were sent, this build cannot read a word of them, and dropping the block leaves the room with the
    // permissive no-procedure defaults. The same zero an unversioned procedure reports.
    extension.unsupportedProcedureVersion = 0;
  }
  if (isPlainObject(raw.scorekeeper) && typeof raw.scorekeeper.timed === 'boolean') {
    extension.scorekeeper = { timed: raw.scorekeeper.timed };
  }
  if (raw.file_state === 'assignment' || raw.file_state === 'partial' || raw.file_state === 'complete') {
    extension.fileState = raw.file_state;
  }

  return extension;
}

/**
 * Stamp a completion state onto a Match or a whole QBJ document's matches.
 *
 * Merges into any `_qbtcp` already present, preserving every other key, so stamping the
 * finished path never drops the room, revision, or handoff context the assignment carried.
 * Anything that is not a match-shaped object passes through untouched.
 */
export function withFileState(value: unknown, state: FileState): unknown {
  if (Array.isArray(value)) return value.map((entry) => withFileState(entry, state));
  if (!isPlainObject(value)) return value;
  if (Array.isArray((value as QbjObject).objects)) {
    return {
      ...(value as QbjObject),
      objects: withFileState((value as QbjObject).objects, state),
    };
  }
  if (!Array.isArray((value as QbjObject).match_teams)) return value;
  const raw: QbjObject = isPlainObject((value as QbjObject)[qbtcpExtensionKey])
    ? { ...((value as QbjObject)[qbtcpExtensionKey] as QbjObject) }
    : { version: qbtcpExtensionVersion };
  raw.file_state = state;
  if (typeof raw.version !== 'number') raw.version = qbtcpExtensionVersion;
  return { ...(value as QbjObject), [qbtcpExtensionKey]: raw };
}

/** Read the declared lifecycle state of a Match, if it states a known one. */
export function readFileState(match: unknown): FileState | null {
  if (!isPlainObject(match)) return null;
  const raw = match[qbtcpExtensionKey];
  if (!isPlainObject(raw)) return null;
  const state = (raw as QbjObject).file_state;
  return state === 'assignment' || state === 'partial' || state === 'complete' ? state : null;
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

/** The durable, plain-language audit note attached after a moderator explicitly continues. */
export function procedureOverrideMessage(version: number): string {
  const which = version > 0 ? `procedure version ${version}` : 'an unknown procedure version';
  return `Automatic room procedure enforcement was unavailable for ${which}; the room continued using the moderator's instructions.`;
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
  if (extension.assignmentRevision !== undefined && Number.isInteger(extension.assignmentRevision)) {
    block.assignment_revision = extension.assignmentRevision;
    carriesSomething = true;
  }
  if (extension.definitionRevision !== undefined && Number.isInteger(extension.definitionRevision)) {
    block.definition_revision = extension.definitionRevision;
    carriesSomething = true;
  }
  if (nonBlankString(extension.definitionDigest)) {
    block.definition_digest = extension.definitionDigest;
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
  if (
    extension.fileState === 'assignment' ||
    extension.fileState === 'partial' ||
    extension.fileState === 'complete'
  ) {
    block.file_state = extension.fileState;
    carriesSomething = true;
  }
  if (extension.scorekeeper?.timed !== undefined) {
    block.scorekeeper = { timed: extension.scorekeeper.timed };
    carriesSomething = true;
  }

  return carriesSomething ? block : null;
}

/** Attach the extension to a QBJ object, when there is one to attach. */
export function withQbtcpExtension(
  target: QbjObject,
  extension: Omit<IQbtcpExtension, 'version'>,
): QbjObject {
  const block = buildQbtcpExtension(extension);
  if (!block) return target;
  return { ...target, [qbtcpExtensionKey]: block };
}
