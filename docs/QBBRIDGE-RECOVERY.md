# QBBridge controller recovery

QBBridge can provision one named backup controller for a tournament relay. This is an incident
handoff, not a second copy of the primary laptop: the backup receives its own independently
revocable management credential and becomes authoritative only after an explicit takeover.

## Create the recovery package

On the connected primary QBBridge profile:

1. Open **Tournament → Encrypted backup control**.
2. Enter a name for the backup laptop and a recovery passphrase of at least 12 characters.
3. Choose **Create encrypted backup package…** and select a folder.
4. Move the resulting `qbsheet-recovery.qbr` file to the backup operator through a separate
   channel from the passphrase.

The package uses PBKDF2-SHA-256 (210,000 iterations) and AES-256-GCM. The file's outer JSON has
only encryption parameters and ciphertext. The primary management credential is never copied into
the package; the encrypted payload contains the backup credential and the local recovery state.

QBBridge writes the primary or backup bearer to the operating system's secure credential store,
not to the profile's localStorage state. It never puts management credentials in a QBJ, YFT,
room sheet, pairing URL, QR code, log, notice, diagnostics bundle, or ordinary result backup.

## Take over after a primary failure

On the backup laptop:

1. Open QBBridge and choose **Open encrypted recovery package…**.
2. Enter the passphrase. Importing does not change relay authority.
3. Reload the authoritative `.yft` and review the recovered rooms and results.
4. Choose **Take over tournament control** only when the primary is no longer publishing.

Takeover increments the relay's director epoch and resets the mirror revision. The relay rejects
the old primary's mirror, acknowledgment, revoke, close, chaos, destroy, help-resolution, and
credential-rotation writes with `409 superseded`. A repeated takeover request with the same ID is
idempotent, so losing the response does not create another epoch. Read-only health and retained
result reads remain available for diagnosis and recovery.

The backup operator should publish the recovered state only after checking the epoch shown by the
relay. A stale primary must not be allowed to resume publishing; it needs an explicit transfer back
from the active controller.

## Return control and revoke access

When the primary laptop is available again, the active backup chooses **Transfer control back to
primary**. This advances the epoch again and makes the backup read-only. The original primary
profile must then choose **Refresh relay position** in **Tournament → Relay → Primary recovery**
before publishing: the refresh reads relay health, transactionally updates only the local epoch
and revision, and locks publishing until the operator reviews the recovered room state and
confirms with **Room state reviewed — unlock publishing**. The lock engages even when the
refresh happens while still superseded, and it survives restarts, so a stale pre-takeover room
snapshot can never silently overwrite the backup's newer mirror on handback. The refresh never
overwrites rooms, plans, results, or the tournament file, and a still-superseded primary is
told it cannot publish yet rather than being handed write authority. A health response that
arrives after the relay was replaced is discarded, never committed.

From the active primary, **Revoke backup access…** invalidates the backup credential without
deleting rooms, assignments, retained results, or the primary credential. If a package was lost,
or its passphrase may have leaked, revoke the backup and create a new package. A forgotten
passphrase cannot be recovered from the relay.
