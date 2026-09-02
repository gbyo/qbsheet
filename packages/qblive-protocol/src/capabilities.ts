import localCapabilities from './local-capabilities.json' with { type: 'json' };
import type { QbliveCapabilities } from './types.js';

/**
 * The capabilities implemented by Director's offline local-network server.
 *
 * Rust reads the same JSON file when it builds a manifest. Keeping the wire contract here prevents
 * Director's projection and its native server from advertising different endpoints.
 */
export const QBLIVE_LOCAL_CAPABILITIES: Readonly<QbliveCapabilities> = Object.freeze(
  localCapabilities as QbliveCapabilities,
);
