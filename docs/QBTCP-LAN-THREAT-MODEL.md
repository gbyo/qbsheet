# QBTCP LAN transport threat model

QBSheet intentionally permits a plain `http://` endpoint for Director's venue-LAN fallback. This is a deployment compatibility choice for controlled local networks; plain HTTP does **not** provide the confidentiality or integrity of authenticated HTTPS.

## Accepted trust assumption

A plain-HTTP LAN endpoint is appropriate only on a controlled, trusted venue network where the tournament operator accepts that a device able to observe or become an on-path peer can read or modify QBTCP traffic. That includes the pairing code and returned room capability during pairing, room and session bearer tokens, assignment/help/presence traffic, progress snapshots, and final-result writes.

Capability scoping, browser Local Network Access permission, CORS, and QBSheet's rules against logging/exporting credentials limit where credentials are used. They do not encrypt the transport and do not prevent a LAN man-in-the-middle attack.

## Networks outside that model

On a shared or otherwise untrusted network, the LAN endpoint must be exposed through authenticated HTTPS with a certificate the scoring device validates, or through an equivalent authenticated protected tunnel. If neither is available, do not configure the LAN fallback; use a protected tournament-control endpoint or continue scoring locally and hand off the saved result.

This assumption applies to every authenticated LAN request path, including pairing, room-token and session-token exchange, assignment and control requests, progress writes, recovery, and final-result submission.
