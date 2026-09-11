# QBBridge Tournament Readiness

One button proves the actual tournament setup before Round 1. Setup view →
**Tournament readiness** → **Run readiness test**. The report is one green/red record
with an actionable fix per failed check, persisted locally as `qbbridge.readiness.last`
and never sent anywhere.

## What it exercises

| Check                         | Proves                                                                                         | Skipped when            |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| Bridge build and state schema | The installed build reports a release version and understands the state schema                 | never                   |
| YellowFruit tournament        | A file is loaded, has teams and rounds, and carries no compatibility warnings                  | never (fails instead)   |
| Relay connection              | https URL, reachable, correct tournament id, management credential accepted, controller active | no relay connected      |
| Scorer pairing path           | The pinned `https://qbsheet.com` origin can pair, with the relay's own message on failure      | no healthy relay        |
| Relay position                | Live epoch/revision match this Bridge; movement is reported, never adopted                     | health failed           |
| Assignment build round-trip   | A synthetic probe assignment builds twice with a stable fingerprint; nothing published         | no file loaded          |
| Probe identities              | Every probe id carries the synthetic marker and matches no live identity                       | never                   |
| Result destination            | Exclusive write, fsync, rename, byte readback, delete, plus ≥100 MB free                       | no folder / browser run |
| Credential store              | A synthetic entry is stored, read back, compared, and deleted                                  | browser run             |
| Recovery crypto               | A synthetic package encrypts and decrypts in memory; nothing written                           | never                   |

A red report names the first fix in the notice and every fix in the panel. Re-running after
each fix converges: checks are independent reads plus two self-cleaning probes.

## Safety rules

- **Synthetic only.** Probe rooms, credential keys, and recovery payloads carry the
  `readiness-probe` marker; the runner refuses to proceed if one collides with a live
  tournament or relay id. No publish, save, ACK, or real-name write happens during a run.
- **Redacted by construction.** Relay connections stay behind closures, so management
  tokens, pairing codes, passphrases, QBJ documents, and team/player names cannot reach
  the report. Details carry counts, epochs, origins, and byte sizes. `readiness.test.ts`
  plants hostile names through every input and asserts none survive.
- **Report, never adopt.** A moved relay, a blocked Scorer origin, or a full disk fails
  with a review fix. The runner changes no epoch, revision, plan, or assignment.

Out of scope on purpose: live synthetic results through the relay (no isolated test path
exists in the relay protocol; delivering a fake final to production rooms to test delivery
would be the incident), YellowFruit file staleness versus disk (#1007), recovery-package
freshness (#1009), and Scorer build pinning (#1010).

## Release gate

`cross-repo-tournament-torture.yml` runs weekly **and** as a required promotion gate:
`qbbridge-release.yml` calls it on every tag (`interop` job) and `publish` needs it, so no
Bridge release ships without proving the exact published tree interoperates with
YellowFruit, the relay contract, and the Scorer transport. There is no Scorer release
workflow in this repository; gating a Scorer deploy the same way belongs to the pinning
work (#1010).

## Fault-injection matrix

Seeded, deterministic, and runnable offline unless noted. New rows from this change are
marked ★.

| Boundary                          | Coverage                                                                                        | Location                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Unwritable result folder          | ★ probe rejects → red report with the OS reason                                                 | `readiness.test.ts`, `commands.rs` probe tests           |
| Disk full / vanished folder       | ★ probe write fails; <100 MB free fails                                                         | same as above                                            |
| Bad CORS / blocked Scorer         | ★ `canPair: false` → red with the relay's message                                               | `readiness.test.ts`                                      |
| Wrong relay URL / tournament id   | ★ mismatch and unreachable → red, position skipped                                              | `readiness.test.ts`                                      |
| Incompatible Scorer build         | ★ blocked pairing fails (pinning itself: #1010)                                                 | `readiness.test.ts`                                      |
| Stale YellowFruit warnings        | ★ warnings fail before Round 1 (disk staleness: #1007)                                          | `readiness.test.ts`                                      |
| Stale relay position              | ★ epoch/revision movement reported, never adopted                                               | `readiness.test.ts`                                      |
| Keychain failure                  | ★ round-trip rejects → red before the tournament needs it                                       | `readiness.test.ts`                                      |
| Corrupt local state               | Unknown shapes read as "never ran"; unparseable states replaced, not repaired                   | `useBridge.ts` loader, `persistence.test.ts`             |
| Corrupt YellowFruit file          | Bad replacement cannot unload the last working tournament                                       | `bridge.integration.test.tsx` corrupt-file test          |
| Duplicate / correction finals     | Two finals for one match are both retained, never overwritten                                   | `bridge.integration.test.tsx` correction test            |
| Response loss after server commit | ACK is idempotent; failed ACKs retry after restart, file stays safe                             | `bridge.integration.test.tsx` ACK tests                  |
| 429 / 5xx / 1027 quota refusal    | Director classifies retryable statuses; Bridge surfaces relay errors without adopting state     | `relaySync.ts`, `relayDegradation.ts`, `publish.test.ts` |
| Sleep / wake / restart mid-poll   | Generation fenced resume reconcile; stale responses cannot land post-resume                     | #1015 sleep/wake suite                                   |
| DNS / network loss                | Unreachable relay fails with a network fix; ordinary play never depends on Cloudflare once open | `readiness.test.ts`, offline-first Scorer path           |
| Stale recovery package            | Freshness gating and explicit fenced recovery                                                   | #1009                                                    |

Artifacts on failure: the redacted readiness record persists in the Bridge profile for
operator diagnostics; CI torture failures upload the standard workflow logs.
