# qblive-server

Hosting-neutral QBLive v1 server core for issue #777.

A standalone native QBServer (#778), Director local mode where behavior
overlaps, and tests/conformance fixtures all build on this crate. The
protocol — not Cloudflare and not Director process memory — is the source of
truth for server behavior.

- `protocol`: publication-id validation, protocol version, bounds mirrored
  from `packages/qblive-protocol`, section extraction, capability profiles,
  manifest endpoints, WebSocket frames.
- `replay`: cursor parsing, limit clamping, resync calculation.
- `storage`: the minimum storage interface (`PublicationStorage`) plus the
  reference in-memory implementation (`MemoryStorage`). Mutations are atomic;
  an implementation must never acknowledge success until durable per its
  backend contract.
- `routes`: Axum route composition. `public_router` serves the
  unauthenticated surface only; `full_router` adds authenticated management.
  Local-only mode mounts public routes and exposes no management authority.

See `docs/QBLIVE_SERVER_CONTRACT.md` for the normative route, lifecycle,
and durability contracts.
