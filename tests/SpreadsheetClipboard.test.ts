import { describe, expect, test, vi } from 'vitest';
import {
  escapeSpreadsheetHtmlText,
  needsSpreadsheetClipboardFallback,
  spreadsheetGridToHtml,
  spreadsheetHtmlMimeType,
  spreadsheetPlainTextMimeType,
  spreadsheetTsvToGrid,
  spreadsheetTsvToHtml,
  SpreadsheetClipboardEnvironment,
  writeSpreadsheetClipboard,
} from '../src/scorer/SpreadsheetClipboard';

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read test blob.'));
    reader.readAsText(blob);
  });
}

describe('spreadsheet clipboard grid helpers', () => {
  test('escapes every HTML-sensitive character in user-controlled cell text', () => {
    const cell = `<script>alert("x")</script> & 'quoted'`;

    expect(escapeSpreadsheetHtmlText(cell)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;',
    );
  });

  test('renders the same rows and cells as the input grid', () => {
    const grid = [
      ['QBSHEET_GAME', '1', 'game-1'],
      ['key', 'value'],
      ['empty', ''],
    ];

    const html = spreadsheetGridToHtml(grid);

    expect(html).toBe(
      '<table data-qbsheet-clipboard="1"><tbody>' +
        '<tr><td>QBSHEET_GAME</td><td>1</td><td>game-1</td></tr>' +
        '<tr><td>key</td><td>value</td></tr>' +
        '<tr><td>empty</td><td></td></tr>' +
        '</tbody></table>',
    );
  });

  test('normalizes browser line endings and ignores one clipboard terminal line ending', () => {
    expect(spreadsheetTsvToGrid('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('escapes a TSV-derived HTML table without changing formula-looking or encoded text', () => {
    // The core serializer supplies encoded control characters. This fixture intentionally keeps
    // the encoded tab/newline visible so this layer cannot accidentally split or decode it.
    const encodedTabAndNewline = 'tab\\tinside\\nline two';
    const tsv = [
      'field\tvalue',
      'formula\t=1+1',
      `literal\t${encodedTabAndNewline}`,
      'markup\t<script>alert(1)</script>',
    ].join('\n');

    const html = spreadsheetTsvToHtml(tsv);

    expect(spreadsheetTsvToGrid(tsv)[1][1]).toBe('=1+1');
    expect(spreadsheetTsvToGrid(tsv)[2][1]).toBe(encodedTabAndNewline);
    expect(html).toContain('<td>=1+1</td>');
    expect(html).toContain('<td>tab\\tinside\\nline two</td>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('writeSpreadsheetClipboard', () => {
  test('uses ClipboardItem with authoritative text/plain and an escaped HTML flavor', async () => {
    const tsv = 'label\tvalue\nunsafe\t<script>alert(1)</script>';
    let copiedItems: ClipboardItems | undefined;
    const write = vi.fn<(items: ClipboardItems) => Promise<void>>(async (items) => {
      copiedItems = items;
    });
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);

    class TestClipboardItem {
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
    }

    const environment: SpreadsheetClipboardEnvironment = {
      clipboard: { write, writeText },
      ClipboardItem: TestClipboardItem as unknown as typeof ClipboardItem,
      Blob,
    };

    const result = await writeSpreadsheetClipboard(tsv, environment);

    expect(result).toMatchObject({ status: 'success', method: 'rich', tsv });
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(copiedItems).toHaveLength(1);

    const item = copiedItems?.[0] as unknown as TestClipboardItem;
    const plainText = item.data[spreadsheetPlainTextMimeType] as Blob;
    const html = item.data[spreadsheetHtmlMimeType] as Blob;
    expect(await readBlob(plainText)).toBe(tsv);
    expect(await readBlob(html)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('falls back to writeText when rich clipboard support is unavailable', async () => {
    const tsv = 'QBSHEET_GAME\t1\tgame-1';
    const write = vi.fn<(items: ClipboardItems) => Promise<void>>();
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const environment: SpreadsheetClipboardEnvironment = {
      clipboard: { write, writeText },
      ClipboardItem: undefined,
      Blob: undefined,
    };

    const result = await writeSpreadsheetClipboard(tsv, environment);

    expect(result).toEqual({ status: 'success', method: 'text', tsv });
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(tsv);
  });

  test('tries writeText after a rich write fails', async () => {
    const tsv = 'QBSHEET_GAME\t1\tgame-1';
    const write = vi.fn<(items: ClipboardItems) => Promise<void>>(async () => {
      throw new Error('permission denied');
    });
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);

    class TestClipboardItem {
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
    }

    const result = await writeSpreadsheetClipboard(tsv, {
      clipboard: { write, writeText },
      ClipboardItem: TestClipboardItem as unknown as typeof ClipboardItem,
      Blob,
    });

    expect(result).toEqual({ status: 'success', method: 'text', tsv });
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(tsv);
  });

  test('returns the complete manual-copy state when every write fails', async () => {
    const tsv = 'note\t=1+1\nliteral\ttab\\tinside\\nline two';
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
      throw new Error('clipboard blocked');
    });
    const environment: SpreadsheetClipboardEnvironment = {
      clipboard: { writeText },
      ClipboardItem: undefined,
      Blob: undefined,
    };

    const result = await writeSpreadsheetClipboard(tsv, environment);

    expect(result).toEqual({
      status: 'fallback',
      reason: 'write-failed',
      manualText: tsv,
      tsv,
    });
    expect(needsSpreadsheetClipboardFallback(result)).toBe(true);
  });

  test('returns an unsupported fallback when no clipboard API exists', async () => {
    const tsv = 'QBSHEET_GAME\t1\tgame-1';

    const result = await writeSpreadsheetClipboard(tsv, {
      clipboard: null,
      ClipboardItem: undefined,
      Blob: undefined,
    });

    expect(result).toEqual({
      status: 'fallback',
      reason: 'unsupported',
      manualText: tsv,
      tsv,
    });
  });

  test('reports invalid runtime input without throwing', async () => {
    const result = await writeSpreadsheetClipboard(undefined as unknown as string, {
      clipboard: null,
      ClipboardItem: undefined,
      Blob: undefined,
    });

    expect(result).toEqual({
      status: 'error',
      reason: 'invalid-input',
      message: 'Spreadsheet clipboard content must be canonical TSV text.',
      manualText: '',
      tsv: '',
    });
  });
});
