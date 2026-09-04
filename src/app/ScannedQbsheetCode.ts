import { IManualGameInput } from '../game/ManualGame';
import { parsePortableGameSetup } from '../game/PortableGameSetup';
import { IPairingLaunchIntent, parsePairingLaunchUrl } from './PairingLaunch';

export type ScannedQbsheetCode =
  | { kind: 'pairing'; intent: IPairingLaunchIntent }
  | { kind: 'game-setup'; input: IManualGameInput }
  | { kind: 'problem'; message: string }
  | { kind: 'other' };

export function parseScannedQbsheetCode(text: string): ScannedQbsheetCode {
  if (text.startsWith('QBSHEET-SETUP:')) {
    const parsed = parsePortableGameSetup(text);
    return parsed.ok
      ? { kind: 'game-setup', input: parsed.input }
      : { kind: 'problem', message: parsed.message };
  }
  const pairing = parsePairingLaunchUrl(text);
  return pairing.kind === 'intent'
    ? { kind: 'pairing', intent: pairing.intent }
    : pairing.kind === 'problem'
      ? pairing
      : { kind: 'other' };
}

export function readScannedQbsheetCode(
  text: string,
  setScanning: (value: boolean) => void,
  onPairing: (intent: IPairingLaunchIntent) => void,
  onSetup: (input: IManualGameInput) => void,
): string | null {
  const result = parseScannedQbsheetCode(text);
  if (result.kind === 'problem') return result.message;
  if (result.kind === 'other')
    return 'That is not a QBSheet pairing code or game package. Look for a QR code from QBSheet or tournament control.';
  setScanning(false);
  if (result.kind === 'pairing') onPairing(result.intent);
  else onSetup(result.input);
  return null;
}
