/**
 * Standings and Stats.
 *
 * Both render whatever tables Director published, at whatever scopes it advertised. Neither knows
 * what a column means. Adding a statistic in Director makes it appear here with no change to this
 * file, which is the point of the dynamic table.
 */

import { useState } from 'react';
import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import { DataTable, ScopePicker } from '../components/DataTable';

export function Standings({
  snapshot,
  followedTeamId,
}: {
  snapshot: QbliveSnapshot;
  followedTeamId: string | null;
}) {
  const [scope, setScope] = useState<string>('overall');
  const tables = snapshot.standings;
  const table = tables.find((entry) => entry.scope === scope) ?? tables[0];

  if (!table) return <p className="empty">Standings have not been published.</p>;
  return (
    <>
      <h2 className="skip-link">Standings</h2>
      <ScopePicker tables={tables} scope={table.scope} onScope={setScope} />
      <section>
        <DataTable table={table} followedTeamId={followedTeamId} selectedPlayerId={null} />
      </section>
    </>
  );
}

export function Stats({
  snapshot,
  followedTeamId,
  selectedPlayerId,
}: {
  snapshot: QbliveSnapshot;
  followedTeamId: string | null;
  selectedPlayerId: string | null;
}) {
  const [scope, setScope] = useState<string>('overall');
  const tables = snapshot.statistics;
  if (tables.length === 0) return <p className="empty">Statistics have not been published.</p>;

  // Grouped by title, so "Team statistics" and "Individual statistics" become separate sections and
  // the scope chips apply within each. A tournament that publishes neither shows neither.
  const titles = [...new Set(tables.map((table) => table.title))];
  return (
    <>
      <h2 className="skip-link">Statistics</h2>
      <ScopePicker tables={tables} scope={scope} onScope={setScope} />
      {titles.map((title) => {
        const forTitle = tables.filter((table) => table.title === title);
        const table = forTitle.find((entry) => entry.scope === scope) ?? forTitle[0];
        return (
          <section key={title}>
            <h2>{title}</h2>
            <DataTable table={table} followedTeamId={followedTeamId} selectedPlayerId={selectedPlayerId} />
          </section>
        );
      })}
    </>
  );
}
