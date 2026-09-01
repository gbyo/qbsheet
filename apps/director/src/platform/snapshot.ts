export interface DirectorShellSnapshot {
  schemaVersion: 1;
  product: 'QBSheet Director';
  generatedAt: string;
  purpose: 'desktop-shell-checkpoint';
}

/**
 * The first persistence hook is intentionally a small, portable JSON checkpoint. The Director UI
 * remains the source of truth for its future tournament model; this file gives the native shell a
 * stable hand-off format before that model is moved into the SQLite store.
 */
export function createDirectorShellSnapshot(now: Date = new Date()): DirectorShellSnapshot {
  return {
    schemaVersion: 1,
    product: 'QBSheet Director',
    generatedAt: now.toISOString(),
    purpose: 'desktop-shell-checkpoint',
  };
}

export function snapshotFileName(now: Date = new Date()): string {
  return `qbsheet-director-${now.toISOString().slice(0, 10)}.json`;
}
