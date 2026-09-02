/**
 * Updates: Director announcements.
 *
 * Rendered as plain text. Never `dangerouslySetInnerHTML`, never a Markdown renderer: this string
 * came from a tournament backend somebody else operates, and rendering a stranger's markup in a
 * page a few hundred people have open is not a risk worth a bold word. Line breaks survive via
 * `white-space: pre-wrap` in CSS.
 */

import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import { announcementsForTeam, teamName } from '../state/derive';
import { formatTime } from '../state/format';

export function Updates({
  snapshot,
  followedTeamId,
  now,
}: {
  snapshot: QbliveSnapshot;
  followedTeamId: string | null;
  now: Date;
}) {
  const announcements = announcementsForTeam(snapshot, followedTeamId, now);
  const zone = snapshot.tournament.timeZone;

  if (announcements.length === 0) {
    return (
      <>
        <h2 className="skip-link">Updates</h2>
        <p className="empty">No announcements yet.</p>
      </>
    );
  }

  return (
    <>
      <h2 className="skip-link">Updates</h2>
      {announcements.map((announcement) => (
        <section key={announcement.id}>
          <article className="card announcement" data-severity={announcement.severity}>
            <h3>{announcement.title}</h3>
            <p>{announcement.body}</p>
            <p className="faint">
              {formatTime(announcement.publishedAt, zone)}
              {announcement.audienceTeamIds.length > 0 &&
                ` · ${announcement.audienceTeamIds.map((id) => teamName(snapshot, id)).join(', ')}`}
              {announcement.updatedAt && ' · edited'}
            </p>
          </article>
        </section>
      ))}
    </>
  );
}
