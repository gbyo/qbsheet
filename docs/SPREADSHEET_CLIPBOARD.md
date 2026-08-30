# Tournament spreadsheet game export

This document describes QBSheet's first-class one-game tournament-spreadsheet export. The core
serializer/parser lives in [`src/scoring/SpreadsheetGame.ts`](../src/scoring/SpreadsheetGame.ts) and
the browser delivery layer lives in [`src/scorer/SpreadsheetClipboard.ts`](../src/scorer/SpreadsheetClipboard.ts).
The completed-game review renders the exact **Copy game for tournament spreadsheet** action through
[`src/scorer/SpreadsheetCopyPanel.tsx`](../src/scorer/SpreadsheetCopyPanel.tsx).

The export does not create a second game model. QBSheet's ordered `ScoreEvent[]` history remains the
source of truth. The serializer turns the existing game package, setup, scorekeeper format,
procedure, record metadata, and ordered event history into a versioned, self-contained TSV range;
the parser validates that range and reconstructs the same snapshot without depending on workbook
state.

## Purpose and boundaries

The intended workflow is deliberately simple:

1. Finish or review the game in QBSheet.
2. Click **Copy game for tournament spreadsheet**.
3. In the already-shared tournament workbook, create a **NEW BLANK TAB**.
4. Click **A1** and paste.

Each tab contains one complete game. The tab name, workbook name, tab order, colors, fonts, and
other spreadsheet formatting are cosmetic. The durable game identity is data in the pasted range.

This feature is an additional collection/archive path. It does not replace QBJ download, QBJ
recovery, QBTCP submission, or the ordinary submission/review flow. It is available from the
completed scorer review, and it remains disabled while the review has blockers or is submitting.

There is deliberately no Google integration:

- no OAuth, Sheets API, Drive API, Apps Script, service account, or Google-specific request;
- no automatic tab creation, workbook discovery, sharing, or permission management;
- no server, database, token, credential, or session-secret transport.

The same plain TSV behavior is intended to be useful with other spreadsheet applications too.

## API for the parent UI

The module is [`src/scorer/SpreadsheetClipboard.ts`](../src/scorer/SpreadsheetClipboard.ts). The
smallest integration is:

```ts
const result = await writeSpreadsheetClipboard(canonicalTsv);

if (result.status === 'success') {
  // Tell the scorekeeper: NEW BLANK TAB -> A1 -> PASTE.
}

if (needsSpreadsheetClipboardFallback(result)) {
  // Render a textarea with result.manualText and an easy select/copy instruction.
}
```

`writeSpreadsheetClipboard` should be called directly from the click/activation handler. It does
not schedule the write or wait for a later effect, because browsers commonly grant clipboard
permission only to the active user gesture.

The result is discriminated by `status`:

- `success` has `method: 'rich' | 'text'` and the exact `tsv` supplied by the caller. A rich result
  also carries the generated `html` for diagnostics or tests.
- `fallback` has `reason: 'unsupported' | 'write-failed'`, plus both `tsv` and `manualText`.
  `manualText` is always the complete, unmodified canonical TSV and is ready for a textarea.
- `error` is reserved for invalid runtime input. It still returns a structured value rather than
  throwing, although there is no valid payload to put in a textarea for that case.

The grid helpers are intentionally presentation helpers, not a game parser:

- `spreadsheetTsvToGrid` / `parseSpreadsheetTsv` split canonical TSV into rows and cells;
- `spreadsheetGridToHtml` renders a grid as an HTML table;
- `spreadsheetTsvToHtml` combines those operations;
- `escapeSpreadsheetHtmlText` escapes text-node content.

The helpers preserve empty cells and normalize CRLF/CR to LF. A single final line ending is ignored,
because a clipboard implementation may append one to a selected range. The canonical serializer is
expected to emit a rectangular grid and not depend on trailing blank rows.

## Clipboard behavior

The write order is:

1. If `navigator.clipboard.write`, `ClipboardItem`, and `Blob` are available, write one item with:
   - `text/plain`: the exact canonical TSV, authoritative;
   - `text/html`: an escaped `<table>` generated from that same grid, optional presentation.
2. If rich writing is unavailable or rejected, call `navigator.clipboard.writeText` with the exact
   same TSV.
3. If no write succeeds, return `status: 'fallback'` and the complete TSV in `manualText`.

The sidecar does not use `document.execCommand`, hidden DOM nodes, network calls, or a best-effort
partial copy. A caller can use the optional `SpreadsheetClipboardEnvironment` argument to test the
browser branches without changing global browser state.

The HTML fragment has no user-controlled tag names, attributes, event handlers, or styles. Cell
text is escaped for `&`, `<`, `>`, `"`, and `'`. HTML is only a presentation flavor: consumers and
future importers must use `text/plain`/TSV as the canonical content and must not rely on rich-paste
formatting.

## Schema v1 contract

The core serializer owns the independently versioned spreadsheet schema. The canonical v1 payload
starts with these visible rows and then contains the named sections below:

```text
QBSHEET_GAME    1    <game-id>
⚠ THIS TAB IS OCCUPIED — ONE QBSHEET GAME PER TAB — DO NOT PASTE ANOTHER GAME HERE
Round ...
If you are trying to paste a different game, create a NEW BLANK TAB first.

SECTION    GAME    1    <game-id>
...
SECTION    RECORD    1    <game-id>
...
SECTION    TEAMS    1    <game-id>
...
SECTION    PLAYERS    1    <game-id>
...
SECTION    SCORING_RULES    1    <game-id>
...
SECTION    PROCEDURE    1    <game-id>
...
SECTION    EVENTS    1    <game-id>
...
QBSHEET_END    1    <game-id>    <event-count>
```

The exact row positions are not semantic. `parseSpreadsheetGame` identifies sections by their marker
and stable headers, tolerates harmless blank rows and trimmed trailing empty cells, and rejects
ambiguous structure. In particular, every section marker and the end marker repeat the same game ID
and schema version; a mixed tab is rejected instead of guessed. `GAME`, `TEAMS`, `PLAYERS`,
`SCORING_RULES`, and `EVENTS` are required. `RECORD` is optional metadata, and `PROCEDURE` is
optional when the package has no room procedure; the serializer emits both sections so the exported
range is explicit.

The first cell at A1 is the stable machine marker. The warning rows are deliberately plain text so
they remain visible when an application pastes only the plain TSV flavor. They are an overwrite
prevention aid, not a lock: a clipboard-only feature cannot inspect the selected tab before paste.

Schema version is the spreadsheet schema version, not the QBSheet application version and not the
`GameDefinition` TypeScript shape. A parser should branch explicitly on version `1` and return an
informative unsupported-version error for a newer version.

## Identity and duplicate games

The core serializer chooses a durable ID from existing QBSheet identity data, in this order when
available:

1. the QBJ match identity (`qbjIdentity.matchId`);
2. the scheduled match identity (`scheduledMatchId`);
3. the existing stable local game/record identity for an unscheduled game.

The sidecar treats the resulting ID as opaque text. It must not derive one from a tab name, team-name
concatenation, round display text, filename, or current time. Re-copying one unchanged game must
therefore repeat the same ID, allowing a future workbook importer to recognize `Sheet 17` and
`R07 Cornell-Chicago` as duplicate views of one game.

Identity is not a deduplication write operation. QBSheet cannot see other tabs and does not silently
remove or merge duplicates. A future importer should group repeated IDs, show the duplicate tabs to
tournament control, and require an explicit choice when their contents differ.

## Canonical state and source of truth

The spreadsheet representation is built from the canonical game snapshot, not only from a final QBJ
projection or `IDerivedGame`. The current room architecture stores the setup/package data and derives
scores and readable questions from the ordered event history. The serializer preserves, where present:

- game, tournament, round/revision, packet, room, team, player, registration, and QBJ identity
  metadata;
- initial rosters and starting lineups;
- the complete scorekeeper format, including answer types/indices/values, bonus and bounceback
  rules, regulation, overtime/sudden-death, lightning, active-player limits, and total divisor;
- room procedure, breaks/halves, timeouts, protest checkpoints, substitution policy, and handoff
  instructions that QBSheet intentionally persists;
- every event in order, including its event ID, question number, team/player, answer type, points,
  bonus parts, bouncebacks, active lineup, timestamps, reasons, descriptions, statuses, resolutions,
  scopes, flags, and other event-specific fields;
- operator/scorekeeper and other persistable game-record metadata, while excluding transient UI and
  network/session state.

`ScoreEvent[]` is the audit history. Displayed totals are derived again after a future spreadsheet
import; a stale summary row must never override edited canonical event cells. This keeps corrections
to player attribution, answer type, bonus points, notes, and metadata understandable and auditable.

Known event properties have named columns. Only genuinely unknown remaining properties go in an
`extras` cell, in deterministic order. The serializer must not place a full duplicate raw event
beside editable columns, because two contradictory copies create an ambiguous human edit.

## TSV encoding and spreadsheet coercion

The clipboard layer deliberately does not decode or rewrite cells. It receives canonical TSV and
passes that exact text to both clipboard paths. The core serializer applies a deterministic,
reversible cell codec to untrusted string fields before the transport sees them.

That codec must make all of the following safe and lossless:

- tabs and CR/LF inside a name, note, description, reason, ID, or other string;
- backslashes and escape-looking text;
- formula-looking strings such as `=1+1`, `+SUM(A1:A2)`, `-1+1`, `@foo`, and their full-width
  variants;
- number/date-looking identifiers such as `00123`, `1/2`, and `1-2`;
- arbitrary Unicode, including accents, CJK text, emoji, and combining characters.

Raw tabs and line endings in the final TSV are structural separators. Embedded logical tabs/newlines
must already be represented by the core codec, so they cannot create a new column or row. Numeric,
boolean, null, and optional values should have an explicit schema representation rather than relying
on a spreadsheet application to infer a type. In particular, a leading apostrophe is not by itself a
portable round-trip codec.

The HTML helper escapes markup but does not invent a second cell codec. If a raw formula-looking
string is handed to it, it remains the same text in the HTML cell; the serializer, not the clipboard
transport, owns the stronger guarantee that a spreadsheet will not execute it as a formula. This
assumption is intentional so the text/plain grid and future parser have one canonical truth.

## Corruption and overwrite handling

The core parser rejects, with structured errors suitable for UI:

- a wrong or missing A1 marker;
- an unsupported schema version;
- missing, duplicate, or malformed required sections;
- a section or end marker with a different game ID/version;
- a missing or mismatched `QBSHEET_END` marker/event count;
- duplicate event IDs, malformed event order, invalid typed cells, malformed numbers/booleans, and
  malformed JSON-valued complex cells;
- a truncated or visibly mixed clipboard payload.

It should not require absolute row numbers, formatting, tab names, workbook names, or sheet order.
It may accept harmless blank rows and trailing empty cells trimmed by spreadsheet copy when the
remaining structure is unambiguous. It should never silently choose between conflicting known cells
and `extras`.

The occupied warning reduces accidental pasting into a populated QBSheet tab. It cannot recover a
game whose entire used range was later overwritten: once the cells are replaced, a clipboard-only
implementation has no access to the old content or to the workbook history. That is why the workflow
always says **NEW BLANK TAB → A1 → PASTE** and why QBJ backup/recovery remains available.

## Schema evolution

Version `1` is a stable spreadsheet contract. Additive changes that preserve the v1 parser's
meaning may be documented as compatible only when they do not change the meaning of an existing
header, cell type, marker, or section. Any incompatible change—different cell encoding, changed
identity semantics, altered event interpretation, renamed required headers, or changed marker/end
rules—requires a new schema version and an explicit parser branch.

Do not tie schema version to the app build. A later QBSheet build should continue to parse v1 when it
can do so without guessing; a newer unsupported version should be refused clearly rather than
silently downgraded.

## Security and privacy

All names, notes, IDs, descriptions, reasons, and metadata are untrusted strings. The HTML path
uses text-node escaping and never interpolates user text into markup or attributes. The TSV path
does not evaluate formulas or run code; its safety against spreadsheet coercion depends on the core
serializer's reversible string codec described above.

Only game-record data belongs in the canonical payload. Do not pass authentication material, room or
session tokens, device secrets, credentials, network headers, DOM state, open-modal state, scroll
position, or other transient browser state to the serializer. The clipboard is easy to paste into a
different document, so a payload that is safe to archive is still sensitive game information and
should be handled according to tournament policy.

## Future import

The eventual import surface can accept the TSV copied from a selected game range and call the same
schema parser used for other sources. It need not know the tab name or workbook context. A workbook
reader, if one is ever added, can enumerate tabs, find A1 `QBSHEET_GAME`, parse each independent
range, group by durable game ID, and report duplicates or conflicts.

An importer that enumerates workbook tabs is intentionally out of scope. No Google API or hidden
workbook metadata is needed: the portable contract is the visible, versioned, self-contained range
itself.
