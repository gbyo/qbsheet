const STORAGE_KEY = 'qbsheet.operatorProfile.v1';

export interface OperatorProfile {
  displayName: string;
  role?: string;
}

const DEFAULT_PROFILE: OperatorProfile = {
  displayName: 'Director',
  role: 'Local operator',
};

function isProfile(value: unknown): value is OperatorProfile {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.displayName === 'string' && r.displayName.length > 0;
}

export function loadOperatorProfile(): OperatorProfile {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_PROFILE };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed: unknown = JSON.parse(raw);
    if (isProfile(parsed)) {
      return {
        displayName: parsed.displayName.trim() || DEFAULT_PROFILE.displayName,
        role: typeof parsed.role === 'string' ? parsed.role : DEFAULT_PROFILE.role,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_PROFILE };
}

export function saveOperatorProfile(profile: OperatorProfile): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // The profile is a local preference. Keep the active session usable when
    // browser storage is blocked, unavailable, or out of quota.
  }
}

export function operatorInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'D';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function operatorDisplayName(profile: OperatorProfile): string {
  return profile.displayName || DEFAULT_PROFILE.displayName;
}
