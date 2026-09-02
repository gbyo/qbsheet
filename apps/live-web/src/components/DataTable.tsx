/**
 * A Director-defined table, rendered without understanding it.
 *
 * The client knows nothing about what the columns mean. It knows how to align a number, how to
 * highlight the followed team, and how to fall back to the server's `display` string for a column
 * kind it has never heard of — which is what lets a new Director statistic appear here without a
 * release. See `docs/QBLIVE.md#10-dynamic-tables`.
 */

import type { QbliveColumn, QbliveDataTable } from '@qbsheet/qblive-protocol';
import { cellText } from '../state/format';

const numericKinds = new Set(['integer', 'decimal', 'percentage', 'record', 'rank', 'score']);

function alignmentClass(column: QbliveColumn): string {
  if (column.alignment === 'trailing') return 'numeric';
  if (column.alignment === 'center') return 'center';
  // Unknown kinds fall through to leading, which is the safe default for arbitrary text.
  return numericKinds.has(column.kind) ? 'numeric' : '';
}

export function DataTable({
  table,
  followedTeamId,
  selectedPlayerId,
}: {
  table: QbliveDataTable;
  followedTeamId: string | null;
  selectedPlayerId: string | null;
}) {
  if (table.rows.length === 0) {
    return <p className="empty">No {table.title.toLowerCase()} yet.</p>;
  }
  return (
    // A wide statistics table scrolls horizontally, and a scroll container that cannot take focus
    // cannot be scrolled from a keyboard at all. `role="region"` with a label is the pattern the
    // ARIA authoring practices give for exactly this; the lint rule only knows that a `div` is not
    // natively interactive.
    <div
      className="table-wrap"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label={table.scopeLabel ? `${table.title}, ${table.scopeLabel}` : table.title}
    >
      <table>
        <caption className="skip-link">
          {table.scopeLabel ? `${table.title} — ${table.scopeLabel}` : table.title}
        </caption>
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th
                key={column.id}
                scope="col"
                className={`${alignmentClass(column)} ${index === 0 ? 'sticky-name' : ''}`.trim()}
                title={column.description}
                abbr={column.description}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => {
            const highlighted =
              (row.teamId !== undefined && row.teamId === followedTeamId) ||
              (row.playerId !== undefined && row.playerId === selectedPlayerId);
            return (
              <tr key={row.id} className={highlighted ? 'is-followed' : undefined}>
                {row.cells.map((cell, index) => {
                  const column = table.columns[index];
                  return (
                    <td
                      key={column?.id ?? index}
                      className={`${alignmentClass(column ?? { id: '', label: '', kind: 'text' })} ${index === 0 ? 'sticky-name' : ''}`.trim()}
                    >
                      {cellText(cell, column?.precision)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A row of scope chips, for tables published at more than one scope. */
export function ScopePicker({
  tables,
  scope,
  onScope,
}: {
  tables: QbliveDataTable[];
  scope: string;
  onScope: (scope: string) => void;
}) {
  const scopes = [
    ...new Map(tables.map((table) => [table.scope, table.scopeLabel ?? table.scope])).entries(),
  ];
  if (scopes.length <= 1) return null;
  return (
    <div className="scopes" role="group" aria-label="Scope">
      {scopes.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={id === scope} onClick={() => onScope(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
