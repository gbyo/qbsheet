import { describe, expect, test } from 'vitest';
import { emptyState } from './persistence';
import {
  decryptRecoveryPackage,
  encryptRecoveryPackage,
  recoveryPackageState,
  type RecoveryPackageState,
} from './recovery';

const primaryToken = 'primary-management-secret';
const backupToken = 'backup-management-secret';

function stateWithRelay() {
  return {
    ...emptyState(),
    relay: {
      baseUrl: 'https://relay.example.workers.dev',
      tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
      managementToken: primaryToken,
      epoch: 4,
      revision: 12,
      controllerRole: 'primary' as const,
    },
    tournamentName: 'Spring Invitational',
  };
}

describe('encrypted recovery packages', () => {
  test('encrypts only an opaque envelope and restores backup access', async () => {
    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    const contents = await encryptRecoveryPackage(payload, 'correct horse battery staple');
    const envelope = JSON.parse(contents) as Record<string, unknown>;

    expect(envelope).toMatchObject({
      format: 'qbsheet-bridge-recovery',
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 210000 },
      cipher: { name: 'AES-GCM' },
    });
    expect(contents).not.toContain(primaryToken);
    expect(contents).not.toContain(backupToken);
    expect(contents).not.toContain('Spring Invitational');

    const restored = await decryptRecoveryPackage(contents, 'correct horse battery staple');
    expect(restored.state.relay).toMatchObject({
      baseUrl: stateWithRelay().relay.baseUrl,
      tournamentId: stateWithRelay().relay.tournamentId,
      managementToken: backupToken,
      controllerRole: 'backup',
      controllerId: 'backup-123',
      controllerLabel: 'Backup laptop',
      epoch: 4,
      revision: 12,
    });
    expect(restored.state.relay?.managementToken).not.toBe(primaryToken);
  });

  test('rejects a wrong passphrase and tampering', async () => {
    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    const contents = await encryptRecoveryPackage(payload, 'correct horse battery staple');
    await expect(decryptRecoveryPackage(contents, 'wrong passphrase')).rejects.toThrow(
      /could not be decrypted/i,
    );

    const envelope = JSON.parse(contents) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(
      decryptRecoveryPackage(JSON.stringify(envelope), 'correct horse battery staple'),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  test('requires a relay, a backup credential, and a strong passphrase', async () => {
    expect(() =>
      recoveryPackageState(emptyState(), {
        managementToken: backupToken,
        controllerId: 'backup-123',
        label: 'Backup laptop',
      }),
    ).toThrow(/connect a relay/i);

    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    await expect(encryptRecoveryPackage(payload, 'short')).rejects.toThrow(/12 characters/i);

    const notBackup = {
      ...payload,
      state: { ...payload.state, relay: { ...payload.state.relay!, controllerRole: 'primary' as const } },
    } as RecoveryPackageState;
    const contents = await encryptRecoveryPackage(notBackup, 'correct horse battery staple');
    await expect(decryptRecoveryPackage(contents, 'correct horse battery staple')).rejects.toThrow(
      /backup controller credential/i,
    );
  });
});
