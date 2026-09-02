/**
 * Tab bar icons.
 *
 * Inline SVG rather than an icon font or a package: five glyphs are a few hundred bytes here, and
 * anything else is a network request a phone on congested WiFi has to wait for. `currentColor`
 * throughout, so the selected state is a colour change on the button.
 */

export type IconName = 'home' | 'schedule' | 'standings' | 'stats' | 'updates';

const paths: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  schedule: 'M7 2v3M17 2v3M3.5 9h17M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  standings: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  stats: 'M3 3v18h18M7 15l4-5 3 3 5-7',
  updates: 'M12 3a6 6 0 0 0-6 6c0 4-1.5 5.5-2 6h16c-.5-.5-2-2-2-6a6 6 0 0 0-6-6zM10 20a2 2 0 0 0 4 0',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
