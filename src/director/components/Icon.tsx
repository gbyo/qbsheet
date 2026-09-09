import type { ReactNode } from 'react';

export type IconName =
  | 'activity'
  | 'alert'
  | 'arrow'
  | 'calendar'
  | 'check'
  | 'chevron'
  | 'clipboard'
  | 'clock'
  | 'copy'
  | 'danger'
  | 'drag'
  | 'download'
  | 'edit'
  | 'file'
  | 'filter'
  | 'flag'
  | 'format'
  | 'help'
  | 'history'
  | 'info'
  | 'inbox'
  | 'link'
  | 'lock'
  | 'minus'
  | 'more'
  | 'network'
  | 'pause'
  | 'play'
  | 'plus'
  | 'publish'
  | 'refresh'
  | 'rooms'
  | 'search'
  | 'server'
  | 'settings'
  | 'sort'
  | 'standings'
  | 'success'
  | 'teams'
  | 'tournament'
  | 'trash'
  | 'undo'
  | 'upload'
  | 'usb'
  | 'users'
  | 'warning'
  | 'x';

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };

  const paths: Record<IconName, ReactNode> = {
    activity: <path d="M3 12h4l2.2-6 4.2 12L16 12h5" />,
    alert: (
      <>
        <path d="M12 4 3.5 19h17L12 4Z" />
        <path d="M12 9v4M12 16h.01" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h15" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
        <path d="M7 3.5v3M17 3.5v3M3.5 9h17" />
      </>
    ),
    check: <path d="m5 12 4.2 4.2L19 6.5" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    clipboard: (
      <>
        <rect x="5" y="4.5" width="14" height="16" rx="1.5" />
        <path d="M9 4.5v-1h6v1M8.5 10h7M8.5 14h7M8.5 18h4" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M4 20h16" />
      </>
    ),
    edit: (
      <>
        <path d="m4 16-.8 4.8L8 20l10.6-10.6a2 2 0 0 0-2.8-2.8L5.2 17.2" />
        <path d="m14.5 7.5 2 2" />
      </>
    ),
    file: (
      <>
        <path d="M6 3.5h8l4 4V20.5H6z" />
        <path d="M14 3.5v4h4M8.5 12h7M8.5 16h7" />
      </>
    ),
    format: (
      <>
        <path d="M5 5h14M5 12h9M5 19h6" />
        <circle cx="17" cy="12" r="2" />
        <circle cx="14" cy="19" r="2" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.8 9a2.4 2.4 0 1 1 4 1.8c-1.3 1-1.8 1.4-1.8 3M12 17h.01" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 5v5h5M12 7v5l3 2" />
      </>
    ),
    inbox: (
      <>
        <path d="M4 5h16v14H4z" />
        <path d="M4 14h4l1.4 2h5.2l1.4-2h4" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
    pause: (
      <>
        <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
        <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
    play: <path d="m8 5 10 7-10 7z" fill="currentColor" stroke="none" />,
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    publish: (
      <>
        <path d="M12 16V4M7 9l5-5 5 5M5 14v5h14v-5" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14-4L4 9" />
        <path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2" />
        <path d="M20 20v-5h-5" />
      </>
    ),
    rooms: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    server: (
      <>
        <rect x="4" y="4" width="16" height="6" rx="1" />
        <rect x="4" y="14" width="16" height="6" rx="1" />
        <path d="M7 7h.01M7 17h.01M10 7h7M10 17h7" />
      </>
    ),
    /* Lucide Settings, ISC licensed: https://lucide.dev/icons/settings */
    settings: (
      <>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    standings: (
      <>
        <path d="M5 19V9M12 19V5M19 19v-8M3 19h18" />
      </>
    ),
    teams: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.4-3 2.2-4.5 5.5-4.5s5.1 1.5 5.5 4.5M15 5.5a3 3 0 0 1 0 5.8M17 14.7c2.1.6 3.2 2 3.5 4.3" />
      </>
    ),
    tournament: (
      <>
        <path d="M5 4h14v4a7 7 0 0 1-14 0zM8 20h8M12 15v5M5 6H3v1a4 4 0 0 0 4 4M19 6h2v1a4 4 0 0 1-4 4" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4M7 9l5-5 5 5M5 14v5h14v-5" />
      </>
    ),
    users: (
      <>
        <circle cx="8" cy="9" r="3" />
        <circle cx="17" cy="8" r="2.5" />
        <path d="M3.5 19c.3-3 1.8-4.5 4.5-4.5s4.2 1.5 4.5 4.5M14 14.5c2.8 0 4.3 1.5 4.5 4.5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="1.5" />
        <path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9" />
      </>
    ),
    danger: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 8v4.5M12 16h.01" />
      </>
    ),
    /* The reorder grip. Reordering is an explicit, keyboard-reachable mode, so
       this appears only inside it and never as permanent row chrome. */
    drag: (
      <>
        <circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    filter: <path d="M4 6h16l-6 7v6l-4-2v-4z" />,
    flag: (
      <>
        <path d="M6 21V4M6 4h11l-2 4 2 4H6" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
    link: (
      <>
        <path d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6L16.5 13" />
        <path d="M14 10a4 4 0 0 1 0 5.6L11.6 18A4 4 0 0 1 6 12.4L7.5 11" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
        <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
      </>
    ),
    minus: <path d="M5 12h14" />,
    network: (
      <>
        <rect x="3.5" y="14.5" width="5" height="5.5" rx="1" />
        <rect x="15.5" y="14.5" width="5" height="5.5" rx="1" />
        <rect x="9.5" y="4" width="5" height="5.5" rx="1" />
        <path d="M12 9.5v3M6 14.5v-2h12v2" />
      </>
    ),
    sort: (
      <>
        <path d="M8 5v14M8 19l-3-3M8 5l3 3M16 19V5M16 5l3 3M16 19l-3-3" />
      </>
    ),
    success: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.2 12.2 2.6 2.6 5-5.4" />
      </>
    ),
    trash: (
      <>
        <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5A1.5 1.5 0 0 0 8.9 21h6.2a1.5 1.5 0 0 0 1.5-1.5L17.5 7" />
        <path d="M10.5 11v6M13.5 11v6" />
      </>
    ),
    undo: (
      <>
        <path d="M9 7H4v-5" />
        <path d="M4 7c2.2-2.8 5-4 8.3-3.6 4.5.6 7.7 4.6 7.1 9.1-.6 4.5-4.6 7.7-9.1 7.1-2.2-.3-4.1-1.4-5.4-3" />
      </>
    ),
    usb: (
      <>
        <rect x="8.5" y="10" width="7" height="11" rx="1.5" />
        <path d="M12 10V4M9.5 6.5 12 4l2.5 2.5M11 14h2" />
      </>
    ),
    warning: (
      <>
        <path d="M12 4 3.5 19h17L12 4Z" />
        <path d="M12 9v4M12 16h.01" />
      </>
    ),
    x: (
      <>
        <path d="m6 6 12 12M18 6 6 18" />
      </>
    ),
  };

  return <svg {...common}>{paths[name]}</svg>;
}
