import type { ReactNode } from 'react';

/**
 * The one page-header grammar.
 *
 * Every primary destination uses this, including the ones that used to be
 * special: Tournament day had its own `director-workspace-header`, and Overview
 * used the tournament name as its `<h1>` — so the page you landed on named the
 * tournament rather than telling you where you were, and the tournament name
 * appeared three times on screen.
 *
 * The rules:
 *
 *   - `title` is the destination's name, and it is the *same string* the
 *     sidebar uses. Both come from `labelForSection`.
 *   - `description` is one line about what the operator does here. It is
 *     optional and it is not a place for implementation notes.
 *   - `status` carries a page-level badge — "Public", "Round 4 in progress" —
 *     when the destination has a single overall state worth stating.
 *   - `actions` holds at most one primary action plus its companions; longer
 *     lists belong in an `ActionMenu`.
 *
 * `eyebrow` exists for the rare case where a page genuinely sits inside
 * something the title cannot express. It is deliberately not used by ordinary
 * destinations: a tiny uppercase label above every heading in the application
 * stopped conveying hierarchy long ago.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  status,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="director-page-header">
      <div>
        {eyebrow && <p className="director-eyebrow">{eyebrow}</p>}
        <div className="director-page-title-row">
          <h1>{title}</h1>
          {status}
        </div>
        {description && <p className="director-page-description">{description}</p>}
      </div>
      {actions && <div className="director-page-actions">{actions}</div>}
    </div>
  );
}
