/**
 * Browser-only delivery for the canonical spreadsheet representation.
 *
 * The serializer that owns the spreadsheet schema is deliberately not imported here. This layer
 * receives its already-canonical TSV, keeps that exact text as the authoritative clipboard flavor,
 * and optionally derives an HTML table for applications that know how to paste rich clipboard data.
 * Keeping this boundary small means the completed-game UI can call it directly from a click without
 * giving the clipboard path a second game model or a Google-specific dependency.
 */

export const spreadsheetPlainTextMimeType = 'text/plain';
export const spreadsheetHtmlMimeType = 'text/html';

/** A row-oriented view of the canonical TSV, used only to build the optional HTML flavor. */
export type SpreadsheetGrid = ReadonlyArray<ReadonlyArray<string>>;

/** The subset of the browser clipboard API needed by this sidecar. */
export interface SpreadsheetClipboardEnvironment {
  /** Pass `null` to test or force an environment with no clipboard API. */
  clipboard?: (Pick<Clipboard, 'writeText'> & Partial<Pick<Clipboard, 'write'>>) | null;
  ClipboardItem?: typeof ClipboardItem | null;
  Blob?: typeof Blob | null;
}

export interface SpreadsheetClipboardSuccess {
  status: 'success';
  /** `rich` writes both MIME flavors; `text` used the plain-text fallback. */
  method: 'rich' | 'text';
  /** The exact canonical text supplied by the caller. */
  tsv: string;
  /** Present when the rich ClipboardItem path succeeded. */
  html?: string;
}

export interface SpreadsheetClipboardFallback {
  status: 'fallback';
  /** Why the caller should show its manual textarea. */
  reason: 'unsupported' | 'write-failed';
  /** The exact value suitable for a manual select-and-copy textarea. */
  manualText: string;
  /** Kept separately so callers need not infer the fallback value from the status. */
  tsv: string;
}

export interface SpreadsheetClipboardError {
  status: 'error';
  reason: 'invalid-input';
  message: string;
  /** Empty because there was no valid canonical payload to preserve. */
  manualText: string;
  tsv: string;
}

export type SpreadsheetClipboardResult =
  SpreadsheetClipboardSuccess | SpreadsheetClipboardFallback | SpreadsheetClipboardError;

/** Narrow a result before rendering the manual-copy UI. */
export function needsSpreadsheetClipboardFallback(
  result: SpreadsheetClipboardResult,
): result is SpreadsheetClipboardFallback {
  return result.status === 'fallback';
}

const htmlEscapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML text node. No caller-provided value is used as markup or an attribute. */
export function escapeSpreadsheetHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

/** Short alias for callers that only need the escaping primitive. */
export const escapeHtml = escapeSpreadsheetHtmlText;

/**
 * Split canonical TSV into the logical rows/cells needed by the HTML presentation.
 *
 * The core serializer owns the reversible cell codec. Therefore tabs and CR/LF characters in this
 * input are structural separators by contract; embedded user text must already be encoded by that
 * serializer. A single terminal line ending is ignored because clipboard implementations commonly
 * append one when copying a selected range.
 */
export function spreadsheetTsvToGrid(tsv: string): string[][] {
  const normalizedLineEndings = tsv.replace(/\r\n?/g, '\n');
  const withoutTerminalLineEnding = normalizedLineEndings.endsWith('\n')
    ? normalizedLineEndings.slice(0, -1)
    : normalizedLineEndings;

  return withoutTerminalLineEnding.split('\n').map((row) => row.split('\t'));
}

/** Short alias for grid-oriented callers and tests. */
export const tsvToGrid = spreadsheetTsvToGrid;
export const parseSpreadsheetTsv = spreadsheetTsvToGrid;

/**
 * Render the exact rows/cells in a grid as a clipboard HTML fragment.
 *
 * This is presentation only. It deliberately contains no formulas, script, event handlers, or
 * user-controlled attributes. The plain TSV flavor remains authoritative for correctness.
 */
export function spreadsheetGridToHtml(grid: SpreadsheetGrid): string {
  const rows = grid
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeSpreadsheetHtmlText(cell)}</td>`).join('')}</tr>`)
    .join('');

  return `<table data-qbsheet-clipboard="1"><tbody>${rows}</tbody></table>`;
}

/** Build an HTML flavor from the same canonical TSV that will be written as text/plain. */
export function spreadsheetTsvToHtml(tsv: string): string {
  return spreadsheetGridToHtml(spreadsheetTsvToGrid(tsv));
}

export const gridToHtml = spreadsheetGridToHtml;
export const tsvToHtml = spreadsheetTsvToHtml;

function browserClipboardEnvironment(): SpreadsheetClipboardEnvironment {
  let clipboard: SpreadsheetClipboardEnvironment['clipboard'];
  try {
    clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  } catch {
    clipboard = undefined;
  }

  return {
    clipboard,
    ClipboardItem: typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined,
    Blob: typeof Blob !== 'undefined' ? Blob : undefined,
  };
}

/**
 * Write canonical spreadsheet text from a user activation.
 *
 * The caller should invoke this function from the button's click handler. It attempts the rich
 * ClipboardItem form first when all required browser primitives exist, then tries writeText. Every
 * failed path returns the exact TSV in `manualText`; clipboard permission failures are not allowed
 * to strand the scorekeeper behind an exception.
 */
export async function writeSpreadsheetClipboard(
  tsv: string,
  environment?: SpreadsheetClipboardEnvironment,
): Promise<SpreadsheetClipboardResult> {
  const candidate: unknown = tsv;
  if (typeof candidate !== 'string') {
    return {
      status: 'error',
      reason: 'invalid-input',
      message: 'Spreadsheet clipboard content must be canonical TSV text.',
      manualText: '',
      tsv: '',
    };
  }

  const text = candidate;
  const browserEnvironment = environment ?? browserClipboardEnvironment();
  let attemptedWrite = false;

  try {
    const clipboard = browserEnvironment.clipboard;
    const ClipboardItemConstructor = browserEnvironment.ClipboardItem;
    const BlobConstructor = browserEnvironment.Blob;

    if (
      clipboard &&
      typeof clipboard.write === 'function' &&
      ClipboardItemConstructor != null &&
      BlobConstructor != null
    ) {
      attemptedWrite = true;
      try {
        const html = spreadsheetTsvToHtml(text);
        const item = new ClipboardItemConstructor({
          [spreadsheetPlainTextMimeType]: new BlobConstructor([text], { type: spreadsheetPlainTextMimeType }),
          [spreadsheetHtmlMimeType]: new BlobConstructor([html], { type: spreadsheetHtmlMimeType }),
        });

        await clipboard.write([item]);
        return { status: 'success', method: 'rich', tsv: text, html };
      } catch {
        // A browser can expose ClipboardItem but reject HTML writes. Try the plain API below.
      }
    }

    if (clipboard && typeof clipboard.writeText === 'function') {
      attemptedWrite = true;
      try {
        await clipboard.writeText(text);
        return { status: 'success', method: 'text', tsv: text };
      } catch {
        // Return the manual-copy state below. The caller still has the complete canonical payload.
      }
    }
  } catch {
    // A hostile or partially implemented browser API must have the same usable manual fallback.
    attemptedWrite = true;
  }

  return {
    status: 'fallback',
    reason: attemptedWrite ? 'write-failed' : 'unsupported',
    manualText: text,
    tsv: text,
  };
}
