/**
 * How a protest survives the trip from a room to tournament control.
 *
 * # Why it travels as text
 *
 * Because `Match` has exactly one free-text field and no structured place for a protest, and adding
 * one would mean changing the file format, the QBJ projection and the match editor for something
 * that has to work at a tournament this weekend. `Match.notes` is read, kept, and shown; a line in
 * it reaches control intact.
 *
 * What that costs is machine-readability, which is exactly what control needs in order to warn
 * somebody before they accept a game with an argument still running in it. So the line has a shape,
 * written in one place and read in one place, and the shape is legible to a human who never learns
 * it exists — which a JSON blob in a notes field would not be.
 */

/** Every protest line starts with this, so the notes field can be scanned without parsing it. */
export const protestNotePrefix = 'PROTEST';

/** The word an unresolved protest carries. Deliberately shouted: it is the one that stops an accept. */
export const unresolvedProtestMarker = 'UNRESOLVED';

export interface IProtestNotice {
  questionNumber: number;
  teamName: string;
  /** `UNRESOLVED`, or what was decided. */
  status: string;
  subject: string;
  description: string;
  resolution?: string;
}

/** One protest, as a line of `Match.notes`. */
export function protestNoteLine(notice: IProtestNotice): string {
  const resolution = notice.resolution ? ` — ${notice.resolution}` : '';
  return [
    protestNotePrefix,
    `Q${notice.questionNumber}`,
    notice.teamName,
    notice.status,
    `${notice.subject}: ${notice.description}${resolution}`,
  ].join(' · ');
}

/** Protest lines in a notes field, in the order they appear. */
export function protestNoteLines(notes: string | undefined): string[] {
  if (!notes) return [];
  return notes.split('\n').filter((line) => line.startsWith(`${protestNotePrefix} ·`));
}

/**
 * Protests nobody has decided yet.
 *
 * A game with one of these is still a legitimate result and control may well accept it — the score
 * is what it is until somebody rules otherwise. What it may not be is accepted by accident.
 */
export function unresolvedProtestLines(notes: string | undefined): string[] {
  return protestNoteLines(notes).filter((line) => line.includes(` · ${unresolvedProtestMarker} · `));
}
