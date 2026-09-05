/** Device preferences only. Never included in game recovery, tournament data, or QBJ. */
export const secretStorageKey = 'qbsheet.scorer.secrets.v1';
const rainbowKey = 'qbsheet.scorer.rainbow.v1';
export const rainbowChangeEvent = 'qbsheet:rainbow-change';
export const secretIds = ['rainbow-logo', 'dvd', 'dvd-corner', 'qbbird-command', 'snake-command'] as const;
export type SecretId = (typeof secretIds)[number];

export function loadSecrets(): SecretId[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(secretStorageKey) ?? '[]');
    return Array.isArray(stored) ? secretIds.filter((id) => stored.includes(id)) : [];
  } catch {
    return [];
  }
}

export function discoverSecret(id: SecretId, current: readonly SecretId[]): SecretId[] {
  const next = [...new Set([...loadSecrets(), ...current, id])];
  try {
    localStorage.setItem(secretStorageKey, JSON.stringify(next));
  } catch {
    /* A private/locked profile still gets discoveries for this mount. */
  }
  return next;
}

export function loadRainbow(): boolean {
  try {
    return sessionStorage.getItem(rainbowKey) === 'on';
  } catch {
    return false;
  }
}

export function saveRainbow(): void {
  try {
    sessionStorage.setItem(rainbowKey, 'on');
  } catch {
    /* Optional preference. */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(rainbowChangeEvent));
}

/** An eight-second rolling window; evaluating clicks needs no background timer. */
export function logoClickSequence(
  clicks: readonly number[],
  now: number,
): { clicks: number[]; unlocked: boolean } {
  const next = [...clicks.filter((time) => now - time <= 8000 && now >= time), now];
  return next.length >= 7 ? { clicks: [], unlocked: true } : { clicks: next, unlocked: false };
}

export const secretCommands = ['qbbird', 'snake', 'dvd', 'stats'] as const;
export type SecretCommand = (typeof secretCommands)[number];
export function matchSecretCommand(value: string): SecretCommand | null {
  return secretCommands.find((command) => command === value.trim().toLowerCase()) ?? null;
}
