export type ControlIconName = 'undo' | 'redo' | 'players' | 'flag' | 'game';

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
};

/** Decorative line icons used beside the footer's always-visible text labels. */
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
