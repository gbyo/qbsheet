import type { HTMLAttributes, ReactNode } from 'react';

/**
 * The shared Director table contract.
 *
 * # The problem this solves
 *
 * Every table in Director was `min-width: 900px` plus `white-space: nowrap`,
 * which is a spreadsheet, not a table: in anything narrower than a maximised
 * window the operator scrolled sideways to read a team name. The Rooms table
 * had eight columns — Room, Location, Moderator, Scorekeeper, Equipment,
 * Status, QBTCP, Actions — of which two were what anyone came to see.
 *
 * # Column priority
 *
 * Each column declares a priority, and low priorities are dropped by the
 * stylesheet as the window narrows rather than pushing the table into a scroll
 * container. Anything hidden is still reachable in the row's detail surface, so
 * nothing becomes unavailable — it stops being permanently on screen.
 *
 *   1  identity. Never hidden.
 *   2  what the page is *for*: the record, the state, the score.
 *   3  useful context.
 *   4  telemetry and secondary detail. First to go.
 *
 * `optional` columns are off by default and turned on by the operator; when on,
 * they stay visible at any width, because then the scroll is a choice.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** 1 = identity, 4 = telemetry. Defaults to 3. */
  priority?: 1 | 2 | 3 | 4;
  numeric?: boolean;
  nowrap?: boolean;
  /** Explicit text alignment for data whose reading order benefits from it. */
  align?: 'left' | 'center' | 'right';
  /** An action column: shrink to content and right-align. */
  actions?: boolean;
  render: (item: T) => ReactNode;
  headerScope?: 'col';
  ariaSort?: 'ascending' | 'descending' | 'none';
  onSort?: () => void;
  /** Off by default; when enabled it ignores the width rules. */
  optional?: boolean;
}

/** The small set of row attributes shared by tables that support deep links or selection. */
export type DataTableRowProps = Pick<HTMLAttributes<HTMLTableRowElement>, 'className' | 'tabIndex'> & {
  'data-selected'?: boolean;
  'data-director-navigation-id'?: string;
  'data-director-navigation-focus'?: boolean;
};

export function DataTable<T>({
  items,
  columns,
  rowKey,
  caption,
  ariaLabel,
  rowId,
  rowProps,
  rowDetail,
  empty,
  dense = false,
  enabledOptionalColumns,
}: {
  items: T[];
  columns: Column<T>[];
  rowKey: (item: T) => string;
  caption?: ReactNode;
  ariaLabel?: string;
  /** DOM id for the row, so deep links and search highlighting can find it. */
  rowId?: (item: T) => string | undefined;
  rowProps?: (item: T) => DataTableRowProps;
  /** Read-only detail rendered under the row. Editing belongs in a dialog. */
  rowDetail?: (item: T) => ReactNode;
  empty?: ReactNode;
  dense?: boolean;
  enabledOptionalColumns?: string[];
}) {
  const optional = new Set(enabledOptionalColumns ?? []);
  const visible = columns.filter((column) => !column.optional || optional.has(column.key));

  return (
    <div className="director-table-wrap">
      <table
        className={`director-table ${dense ? 'director-table-dense' : ''}`.trim()}
        aria-label={ariaLabel}
      >
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {visible.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-priority={column.priority ?? 3}
                data-pinned={column.optional && optional.has(column.key) ? true : undefined}
                data-numeric={column.numeric || undefined}
                data-align={column.align}
                aria-sort={column.ariaSort}
                className={column.actions ? 'director-cell-actions' : undefined}
              >
                {column.onSort ? (
                  <button type="button" onClick={column.onSort}>
                    {column.header}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={visible.length}>{empty}</td>
            </tr>
          ) : (
            items.flatMap((item) => {
              const key = rowKey(item);
              const extra = rowProps?.(item) ?? {};
              const detail = rowDetail?.(item);
              const rows = [
                <tr
                  key={key}
                  id={rowId?.(item)}
                  className={extra.className}
                  data-selected={extra['data-selected'] || undefined}
                  data-director-navigation-id={extra['data-director-navigation-id']}
                  data-director-navigation-focus={extra['data-director-navigation-focus'] || undefined}
                  tabIndex={extra.tabIndex}
                >
                  {visible.map((column) => (
                    <td
                      key={column.key}
                      data-priority={column.priority ?? 3}
                      data-pinned={column.optional && optional.has(column.key) ? true : undefined}
                      data-numeric={column.numeric || undefined}
                      data-align={column.align}
                      className={
                        [
                          column.actions ? 'director-cell-actions' : '',
                          column.nowrap ? 'director-cell-nowrap' : '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                    >
                      {column.actions ? <div>{column.render(item)}</div> : column.render(item)}
                    </td>
                  ))}
                </tr>,
              ];
              if (detail) {
                rows.push(
                  <tr key={`${key}-detail`} data-detail-row="true">
                    <td colSpan={visible.length}>{detail}</td>
                  </tr>,
                );
              }
              return rows;
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The identity cell: a title with the context that used to need its own column. */
export function IdentityCell({ title, detail, id }: { title: ReactNode; detail?: ReactNode; id?: string }) {
  return (
    <span className="director-cell-identity" id={id}>
      <strong>{title}</strong>
      {detail && <small>{detail}</small>}
    </span>
  );
}

/** Read-only detail under a row: specs, diagnostics, history. */
export function RowDetail({ children }: { children: ReactNode }) {
  return <div className="director-row-detail">{children}</div>;
}
