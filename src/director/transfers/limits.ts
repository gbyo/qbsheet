/**
 * The bounds that apply to anything Director reads from a filesystem it does not own.
 *
 * Gathered in one file so that "what does Director refuse" is a question with one answer, and so
 * that the native side and the web side cannot drift into two different definitions of too big.
 *
 * The numbers are chosen against the worst realistic tournament rather than the worst imaginable
 * one: a 200-team event with two hundred rooms is inside every bound here, and a drive that busts
 * one of them is a drive holding something that is not a tournament.
 */

/** Largest document Director will read as QBJ. Matches the scorer's `maxQbjBytes`. */
export const maxQbjBytes = 8 * 1024 * 1024;

/**
 * Most files Director will look at in one transfer directory.
 *
 * A cap rather than a page, deliberately: past this point the directory is not a QBSheet exchange
 * folder, and continuing to read it would be Director crawling somebody's media library.
 */
export const maxFilesPerDirectory = 500;

/** Most files Director will parse in one import batch, whether dropped, picked or scanned. */
export const maxFilesPerBatch = 200;

/**
 * Most entries Director will look at in the root of a removable drive.
 *
 * The root is scanned at all only because a scorekeeper who was told to "put it on the stick" put
 * it on the stick rather than in `QBSheet/Results`. That is worth one shallow, bounded look and
 * nothing more.
 */
export const maxRemovableRootEntries = 200;

/**
 * How deep below a chosen transfer root Director will descend.
 *
 * `QBSheet/Assignments/Round 5` is depth three, which is the deepest the layout goes. Nothing here
 * recurses to an arbitrary depth, on any media, ever.
 */
export const maxScanDepth = 3;

/** Largest file Director will read while scanning. Bigger files are listed and skipped, not read. */
export const maxScanFileBytes = maxQbjBytes;

/** How often a watched folder is re-read when the platform cannot tell Director it changed. */
export const folderPollIntervalMs = 5_000;

/** How often removable volumes are re-enumerated when native change events are unavailable. */
export const volumePollIntervalMs = 4_000;
