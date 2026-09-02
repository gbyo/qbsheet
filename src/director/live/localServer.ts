import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';

interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface LocalLiveServerStatus {
  running: boolean;
  address: string | null;
  port: number | null;
  publicationId: string | null;
  publicUrl: string | null;
  revision: number;
}

function bridge(): NativeBridge {
  const native = typeof window === 'undefined' ? null : window.__TAURI_INTERNALS__;
  if (!native) throw new Error('Local-network QBSheet Live requires the Director desktop app.');
  return native;
}

function statusFrom(value: unknown): LocalLiveServerStatus {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    running: record.running === true,
    address: typeof record.address === 'string' ? record.address : null,
    port: typeof record.port === 'number' ? record.port : null,
    publicationId: typeof record.publicationId === 'string' ? record.publicationId : null,
    publicUrl: typeof record.publicUrl === 'string' ? record.publicUrl : null,
    revision: typeof record.revision === 'number' ? record.revision : 0,
  };
}

export function localLiveOrigin(status: LocalLiveServerStatus): string {
  if (!status.running || !status.address || !status.port) {
    throw new Error('Director could not determine a reachable address for the local Live server.');
  }
  return `http://${status.address}:${status.port}`;
}

export async function startLocalLiveServer(): Promise<LocalLiveServerStatus> {
  const native = bridge();
  const current = statusFrom(await native.invoke('director_live_server_status'));
  const status = current.running
    ? current
    : statusFrom(await native.invoke('director_start_live_server', { port: 0 }));
  try {
    localLiveOrigin(status);
  } catch (reason) {
    if (status.running) await native.invoke('director_stop_live_server').catch(() => undefined);
    throw reason;
  }
  return status;
}

export async function publishLocalLive(snapshot: QbliveSnapshot): Promise<LocalLiveServerStatus> {
  const status = statusFrom(await bridge().invoke('director_publish_local_live', { snapshot }));
  localLiveOrigin(status);
  if (!status.publicUrl) throw new Error('The local Live server did not return a spectator link.');
  return status;
}

export async function clearLocalLive(rememberAsGone: boolean): Promise<LocalLiveServerStatus> {
  return statusFrom(
    await bridge().invoke('director_clear_local_live', {
      rememberAsGone,
    }),
  );
}

export async function stopLocalLiveServer(): Promise<LocalLiveServerStatus> {
  return statusFrom(await bridge().invoke('director_stop_live_server'));
}
