import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Disclosure } from './Disclosure';

/**
 * Page composition.
 *
 * # The anti-card rule
 *
 * Director's default answer to "these things are related" used to be another
 * white bordered rectangle, which is why pages had eight of them and no
 * hierarchy. The components here give three graded answers instead:
 *
 *   `Section`  a heading and content. No border. The default.
 *   `Panel`    a bordered container, for a body of content that needs an edge —
 *              a table, a list, a form. One to three per page.
 *   `Inset`    a recessed group *inside* one of those, for "these fields belong
 *              together" without a second frame.
 *
 * Tinted surfaces come from the status model and mean a status. Nothing is
 * tinted for variety.
 */

export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`director-page ${className}`.trim()}>{children}</div>;
}

export function Stack({
  children,
  gap = 'md',
  className = '',
}: {
  children: ReactNode;
  gap?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div
      className={[
        'director-stack',
        gap === 'sm' ? 'director-stack-tight' : gap === 'lg' ? 'director-stack-loose' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

/** Main column plus a narrower rail that drops below it on narrow windows. */
export function Split({ children }: { children: ReactNode }) {
  return <div className="director-split">{children}</div>;
}

export function Section({
  title,
  description,
  actions,
  children,
  level = 2,
  divided = false,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  level?: 2 | 3;
  /** A rule above, used instead of wrapping sibling sections in cards. */
  divided?: boolean;
  id?: string;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section id={id} className={`director-section ${divided ? 'director-section-divided' : ''}`.trim()}>
      {(title || actions) && (
        <div className="director-section-header">
          <div>
            {title && <Heading>{title}</Heading>}
            {description && <p className="director-section-description">{description}</p>}
          </div>
          {actions && <div className="director-section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  footer,
  tone,
  flush = false,
  className = '',
  id,
  level = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Only when the panel's own subject is in this state. Not for emphasis. */
  tone?: 'info' | 'warning' | 'danger';
  /** No body padding — for a table or list that should reach the panel edge. */
  flush?: boolean;
  className?: string;
  id?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section id={id} className={`director-panel ${className}`.trim()} data-tone={tone}>
      {(title || actions) && (
        <div className="director-panel-header">
          <div>
            {title && <Heading>{title}</Heading>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="director-panel-actions">{actions}</div>}
        </div>
      )}
      {children != null && (flush ? children : <div className="director-panel-body">{children}</div>)}
      {footer && <div className="director-panel-footer">{footer}</div>}
    </section>
  );
}

/** A recessed group inside a panel or section. */
export function Inset({
  children,
  quiet = false,
  className = '',
}: {
  children: ReactNode;
  quiet?: boolean;
  className?: string;
}) {
  return (
    <div
      className={['director-inset', quiet ? 'director-inset-quiet' : '', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- Summary lists */

/**
 * The list-of-objects layout, used where a table is the wrong shape: rounds,
 * rooms, staff, transfer locations, packets in a picker.
 *
 * A stable title line, a summary that reads at a glance, a status, and one
 * primary action with everything else in an `ActionMenu`. The summary and the
 * action position do not move as the object's state changes — which was the
 * main reason the round rows were unreadable.
 */
export function SummaryList({
  children,
  ariaLabel,
  className = '',
}: {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={`director-list ${className}`.trim()} role="list" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function SummaryItem({
  title,
  summary,
  status,
  actions,
  selected = false,
  id,
  className = '',
  children,
}: {
  title: ReactNode;
  /** The one-glance line: what this object is and where it stands. */
  summary?: ReactNode;
  status?: ReactNode;
  /** One primary action plus an overflow menu. Not a toolbar. */
  actions?: ReactNode;
  selected?: boolean;
  id?: string;
  className?: string;
  /** Expanded read-only detail. Editing belongs in a dialog. */
  children?: ReactNode;
}) {
  return (
    <div
      id={id}
      role="listitem"
      className={`director-list-item ${className}`.trim()}
      data-selected={selected || undefined}
    >
      <div className="director-list-main">
        <div className="director-list-title">
          {title}
          {status}
        </div>
        {summary && <div className="director-list-summary">{summary}</div>}
        {children}
      </div>
      {actions && <div className="director-list-actions">{actions}</div>}
    </div>
  );
}

/* --------------------------------------------------------- Metadata surfaces */

/**
 * A term/value grid for detail surfaces.
 *
 * This is where identifiers, revisions, and telemetry live: reachable when the
 * operator needs them, out of the way when they do not. `mono` for anything
 * that is a raw identifier, so it reads as machine data rather than as
 * tournament information.
 */
export function Specs({
  items,
  className = '',
}: {
  items: { term: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={`director-specs ${className}`.trim()}>
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.term}</dt>
          <dd className={item.mono ? 'director-mono' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A compact inline run of metadata: counts, timestamps, sources. */
export function MetaRow({ items }: { items: ReactNode[] }) {
  return (
    <p className="director-meta-row">
      {items.filter(Boolean).map((item, index) => (
        <span key={index}>{item}</span>
      ))}
    </p>
  );
}

/**
 * Diagnostics: session ids, protocol versions, storage backends, schema
 * versions, revision counters.
 *
 * Always behind a disclosure labelled as diagnostics, so the operator knows
 * they have left the ordinary workflow — and so the ordinary workflow is not
 * competing with a schema version for attention.
 */
export function Diagnostics({
  label = 'Diagnostics',
  hint,
  items,
  children,
  defaultOpen = false,
  standalone = true,
}: {
  label?: string;
  hint?: ReactNode;
  items?: { term: ReactNode; value: ReactNode; mono?: boolean }[];
  children?: ReactNode;
  defaultOpen?: boolean;
  standalone?: boolean;
}) {
  return (
    <Disclosure label={label} icon="settings" hint={hint} defaultOpen={defaultOpen} standalone={standalone}>
      <div className="director-diagnostics">
        {items && items.length > 0 && <Specs items={items} />}
        {children}
      </div>
    </Disclosure>
  );
}

/** An advanced surface: reachable, clearly labelled as beyond routine work. */
export function AdvancedSection({
  label,
  hint,
  children,
  icon = 'settings',
  defaultOpen = false,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  icon?: IconName;
  defaultOpen?: boolean;
}) {
  return (
    <Disclosure label={label} hint={hint} icon={icon} standalone defaultOpen={defaultOpen}>
      {children}
    </Disclosure>
  );
}

/** A short bulleted run of facts, in the secondary register. */
export function FactList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="director-fact-list">
      {items.map((item, index) => (
        <li key={index}>
          <Icon name="check" size={14} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
