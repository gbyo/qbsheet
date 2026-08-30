import { useRef, useState } from 'react';
import {
  SpreadsheetClipboardResult,
  needsSpreadsheetClipboardFallback,
  writeSpreadsheetClipboard,
} from './SpreadsheetClipboard';

export interface ISpreadsheetCopyPanelProps {
  /** The complete canonical payload for the current game. */
  tsv: string;
  /** Human-readable identity and score shown after the copy. */
  gameLabel: string;
  /** Cosmetic suggestion only; parsers never depend on it. */
  suggestedTabName?: string;
  /** A final result with blockers is not a legitimate tournament-spreadsheet export. */
  disabled?: boolean;
}

function selectTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.focus();
  textarea.select();
}

/**
 * The small, user-facing delivery surface for a canonical spreadsheet copy.
 *
 * Clipboard permission is requested only from the button handler. The TSV is deliberately not
 * displayed unless the browser cannot write it, keeping implementation details out of the normal
 * scorekeeper flow while preserving a complete manual recovery path.
 */
export default function SpreadsheetCopyPanel(props: ISpreadsheetCopyPanelProps) {
  const { tsv, gameLabel, suggestedTabName, disabled = false } = props;
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<SpreadsheetClipboardResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const copy = async () => {
    if (copying || disabled) return;
    setCopying(true);
    setResult(null);
    try {
      setResult(await writeSpreadsheetClipboard(tsv));
    } catch {
      // The helper normally returns a discriminated result. Keep the UI usable if an unusual
      // browser implementation throws before it reaches that boundary.
      setResult({
        status: 'fallback',
        reason: 'write-failed',
        manualText: tsv,
        tsv,
      });
    } finally {
      setCopying(false);
    }
  };

  return (
    <section className="scorer-spreadsheet-copy" aria-label="Tournament spreadsheet copy">
      <button
        type="button"
        className="scorer-action"
        onClick={() => void copy()}
        disabled={disabled || copying}
      >
        {copying ? 'Copying…' : 'Copy game for tournament spreadsheet'}
      </button>

      {result?.status === 'success' && (
        <div className="scorer-spreadsheet-success" role="status" aria-live="polite">
          <p>
            <strong>Game copied</strong>: {gameLabel}
          </p>
          <p>
            Create a <strong>NEW BLANK TAB</strong> in the tournament spreadsheet, click <strong>A1</strong>,
            and paste.
          </p>
          <p className="scorer-spreadsheet-sequence">
            <strong>NEW TAB → A1 → PASTE</strong>
          </p>
          <p>
            <strong>Never paste into a tab that already contains a QBSheet game.</strong>
          </p>
          {suggestedTabName && (
            <p className="scorer-spreadsheet-suggestion">
              Suggested tab name: {suggestedTabName} (cosmetic only)
            </p>
          )}
        </div>
      )}

      {result && needsSpreadsheetClipboardFallback(result) && (
        <div className="scorer-spreadsheet-fallback" role="alert">
          <p>
            This browser could not place the game on the clipboard. Select the complete text below, copy it,
            then create a <strong>NEW BLANK TAB</strong>, click <strong>A1</strong>, and paste.
          </p>
          <p>
            <strong>Never paste into a tab that already contains a QBSheet game.</strong>
          </p>
          <label htmlFor="scorer-spreadsheet-manual-copy">Game text to copy manually</label>
          <textarea
            id="scorer-spreadsheet-manual-copy"
            ref={textareaRef}
            value={result.manualText}
            readOnly
            rows={8}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="scorer-action" onClick={() => selectTextarea(textareaRef.current)}>
            Select game text
          </button>
        </div>
      )}

      {result?.status === 'error' && (
        <p className="scorer-complete-warning" role="alert">
          The spreadsheet copy could not be prepared. Finish the game review and try again.
        </p>
      )}
    </section>
  );
}
