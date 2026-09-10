interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: NativeBridge;
  }
}

export interface NativeRelayScorerOriginProbe {
  status: number;
  allowOrigin?: string;
  allowMethods?: string;
  allowHeaders?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ask the native Director shell to send the scorer's real CORS preflight shape.
 *
 * Browser/WebView fetch owns the `Origin` header, so setup cannot prove the deployed relay
 * accepts `https://qbsheet.com` from renderer JavaScript. The native command sends the probe
 * without any scorer or management credential and returns only status/CORS response headers.
 */
export async function probeNativeRelayScorerOrigin(
  baseUrl: string,
  tournamentId: string,
): Promise<NativeRelayScorerOriginProbe | null> {
  const bridge = typeof window === 'undefined' ? null : (window.__TAURI_INTERNALS__ ?? null);
  if (!bridge) return null;

  const value = await bridge.invoke('director_probe_relay_scorer_origin', {
    baseUrl,
    tournamentId,
  });
  if (!isRecord(value) || typeof value.status !== 'number') {
    throw new Error('The native scorer-origin probe returned an invalid response.');
  }
  return {
    status: value.status,
    ...(typeof value.allowOrigin === 'string' ? { allowOrigin: value.allowOrigin } : {}),
    ...(typeof value.allowMethods === 'string' ? { allowMethods: value.allowMethods } : {}),
    ...(typeof value.allowHeaders === 'string' ? { allowHeaders: value.allowHeaders } : {}),
  };
}
