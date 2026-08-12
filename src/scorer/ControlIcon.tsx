export type ControlIconName =
  | 'undo'
  | 'redo'
  | 'players'
  | 'flag'
  | 'game'
  | 'note'
  | 'issue'
  | 'details'
  | 'review'
  | 'lightning'
  | 'clock'
  | 'play'
  | 'pause'
  | 'replace'
  | 'stop'
  | 'download'
  | 'upload'
  | 'adjust'
  | 'forfeit'
  | 'settings';

const paths: Record<ControlIconName, React.ReactNode> = {
  undo: (
    <>
      <path d="M9 6 5 10l4 4" />
      <path d="M5 10h7a5 5 0 0 1 5 5v1" />
    </>
  ),
  redo: (
    <>
      <path d="m15 6 4 4-4 4" />
      <path d="M19 10h-7a5 5 0 0 0-5 5v1" />
    </>
  ),
  players: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19" />
      <path d="M15 5.5a3 3 0 0 1 0 5.5M17 13a4.5 4.5 0 0 1 3.5 4.4V19" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V4" />
      <path d="M6 5h10l-1.5 3L16 11H6" />
    </>
  ),
  game: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  note: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4M9 12h6M9 16h6" />
    </>
  ),
  issue: (
    <>
      <path d="M12 3.5 21 20H3z" />
      <path d="M12 9v4M12 16.5v.5" />
    </>
  ),
  details: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 10.5v5M12 7.5v.5" />
    </>
  ),
  review: (
    <>
      <rect x="5.5" y="3.5" width="13" height="17" rx="1.5" />
      <path d="m8.5 9 1.5 1.5 3-3M8.5 14h7M8.5 17h7" />
    </>
  ),
  lightning: <path d="m13.5 2.5-8 11h6l-1 8 8-11h-6z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  play: <path d="m9 6 9 6-9 6z" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  replace: (
    <>
      <path d="M20 11a8 8 0 0 0-14.5-4L4 9" />
      <path d="M4 5v4h4M4 13a8 8 0 0 0 14.5 4l1.5-2" />
      <path d="M20 19v-4h-4" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  download: (
    <>
      <path d="M12 4v10M8 10l4 4 4-4M5 20h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 20V10M8 14l4-4 4 4M5 4h14" />
    </>
  ),
  adjust: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="1.5" fill="var(--room-surface)" />
      <circle cx="15" cy="12" r="1.5" fill="var(--room-surface)" />
      <circle cx="11" cy="17" r="1.5" fill="var(--room-surface)" />
    </>
  ),
  forfeit: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="7" />
      <path d="M12 5V3M12 21v-2M19 12h2M3 12h2" />
      <path d="m16.95 7.05 1.41-1.41M5.64 18.36l1.41-1.41M16.95 16.95l1.41 1.41M5.64 5.64l1.41 1.41" />
    </>
  ),
};

/** Decorative line icons used beside scorer controls and Game menu labels. */
export default function ControlIcon(props: { name: ControlIconName }) {
  return (
    <svg
      className="scorer-control-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[props.name]}
    </svg>
  );
}
