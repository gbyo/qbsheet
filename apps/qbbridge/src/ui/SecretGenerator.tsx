/**
 * Generate a value the operator has to paste somewhere, and help them paste it.
 *
 * Used on the help page for the relay's setup token. The alternative the page used to offer was
 * "any long random string", which in practice means a tired person typing something short and
 * memorable into the one credential that lets a stranger claim their relay.
 *
 * # It is never stored
 *
 * The value lives in this component's state and nowhere else — not in `localStorage`, not in the
 * persisted bridge state, not in a log. Leaving the help page discards it, which is correct: by
 * then it has been pasted into `wrangler` and into the claim, and after the claim it is worthless
 * anyway. Nothing here writes it anywhere QBBridge could later leak it from.
 */

import { useState } from 'react';
import { Button } from '@qbsheet/ui';

type CopyState = 'idle' | 'copied' | 'failed';

export default function SecretGenerator({
  label,
  generate,
  describedBy,
}: {
  /** What this value is, for the button and the read-only field's accessible name. */
  label: string;
  generate: () => string;
  describedBy?: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyState>('idle');

  const copy = async (): Promise<void> => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied('copied');
    } catch {
      // A webview can refuse the clipboard. Say so rather than showing a button that lied, and
      // leave the value selectable so the operator can copy it by hand.
      setCopied('failed');
    }
  };

  return (
    <div className="secret-generator">
      <div className="row">
        <Button
          onPress={() => {
            setValue(generate());
            setCopied('idle');
          }}
        >
          {value === null ? `Generate ${label}` : `Generate another`}
        </Button>
        {value !== null ? (
          <>
            {/* Read-only rather than disabled: the operator must still be able to select it. */}
            <input
              type="text"
              readOnly
              className="secret-generator__value"
              aria-label={label}
              aria-describedby={describedBy}
              value={value}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button onPress={() => void copy()}>Copy</Button>
          </>
        ) : null}
      </div>
      {/* Polite: the operator pressed the button, so they are looking at it already. */}
      <p className="faint" role="status">
        {copied === 'copied'
          ? 'Copied to the clipboard.'
          : copied === 'failed'
            ? 'Could not reach the clipboard — select the text above and copy it.'
            : ''}
      </p>
    </div>
  );
}
