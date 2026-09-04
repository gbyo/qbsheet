import { unzlibSync, zlibSync } from 'fflate';
import { IManualGameInput, defineManualGame } from './ManualGame';
import { maxAnswerTypes, maxPlayersPerTeam, maxTextLength } from './GamePackageValidation';
import { playerNameMaxLength, readRosterLines } from './Roster';
import { maximumRoomBreaks, maximumRoomBreakLabelLength } from '../scoring/RoomProcedure';
import { decodeBase45, encodeBase45 } from '../qr/Base45';
import { encodeQr, qrSvg } from '../qr/QrEncoding';

export const portableSetupPrefix = 'QBSHEET-SETUP:1:';
export const portableSetupLimits = {
  encodedCharacters: 8192,
  compressedBytes: 4096,
  decompressedBytes: 65536,
  // 105 modules plus quiet zone: about 5.6 pixels/module in the fallback's 640px frame.
  qrVersion: 22,
  numericMagnitude: 10000,
} as const;
export const portableSetupTooLarge =
  'This setup is too large for a reliable single QR code. Shorten unusually long roster or rule labels, or use another transfer method.';
const invalid = 'This game package is invalid. Ask for a new QR code.';
type Problem = { ok: false; message: string };
export type PortableSetupEncodeResult =
  Problem | { ok: true; text: string; svg: string; version: number; moduleCount: number };
export type PortableSetupParseResult = Problem | { ok: true; input: IManualGameInput };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalid);
  return value as Record<string, unknown>;
}
function string(value: unknown, limit = maxTextLength): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(invalid);
  return value;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(invalid);
  return value;
}

/** Copy only named scalar fields. Optional form fields stay absent; no invented rules/defaults. */
function fields(raw: Record<string, unknown>, numbers: string[], booleans: string[], strings: string[] = []) {
  const result: Record<string, unknown> = {};
  for (const key of numbers) {
    const value = raw[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      Math.abs(value) > portableSetupLimits.numericMagnitude
    )
      throw new Error(invalid);
    result[key] = value;
  }
  for (const key of booleans) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new Error(invalid);
    result[key] = raw[key];
  }
  for (const key of strings) if (raw[key] !== undefined) result[key] = string(raw[key]);
  return result;
}
function requiredBoolean(raw: Record<string, unknown>, key: string) {
  if (typeof raw[key] !== 'boolean') throw new Error(invalid);
}

/** Explicit projection also keeps credentials, identifiers and arbitrary nested data out of encoding. */
function readInput(value: unknown): IManualGameInput {
  const raw = object(value);
  const team = (value: unknown) => {
    const raw = object(value);
    const players = string(raw.players, maxPlayersPerTeam * (playerNameMaxLength + 2));
    const names = readRosterLines(players);
    if (names.length > maxPlayersPerTeam || names.some((name) => name.length > playerNameMaxLength))
      throw new Error(invalid);
    return { name: string(raw.name, playerNameMaxLength), players };
  };
  const rule = object(raw.rules);
  if (rule.mode !== 'basic' && rule.mode !== 'advanced') throw new Error(invalid);
  const values = object(rule[rule.mode]);
  requiredBoolean(values, 'useBonuses');
  const commonNumbers = [
    'pointsPerBonusPart',
    'partsPerBonus',
    'tossupCount',
    'maximumPlayersPerTeam',
    'overtimeQuestionCount',
    'lightningCountPerTeam',
    'lightningDivisor',
  ];
  const commonBooleans = [
    'useBonuses',
    'bonusesBounceBack',
    'overtimeIncludesBonuses',
    'useLightning',
    'timed',
  ];
  const rules = fields(
    values,
    [
      ...commonNumbers,
      ...(rule.mode === 'basic'
        ? ['tossupValue', 'powerValue', 'negValue']
        : [
            'maximumBonusScore',
            'bonusDivisor',
            'minimumPartsPerBonus',
            'maximumPartsPerBonus',
            'maximumTossupCount',
          ]),
    ],
    commonBooleans,
    ['name'],
  );
  if (rule.mode === 'advanced') {
    requiredBoolean(values, 'bonusesBounceBack');
    if (values.bonusStructure !== 'regular' && values.bonusStructure !== 'irregular')
      throw new Error(invalid);
    rules.bonusStructure = values.bonusStructure;
    rules.answerTypes = array(values.answerTypes, maxAnswerTypes).map((value) => {
      const row = object(value);
      requiredBoolean(row, 'awardsBonus');
      return {
        ...fields(row, ['value'], ['awardsBonus']),
        key: string(row.key),
        label: string(row.label),
        shortLabel: string(row.shortLabel),
      };
    });
    const keys = (rules.answerTypes as { key: string }[]).map((row) => row.key);
    if (new Set(keys).size !== keys.length) throw new Error(invalid);
  }
  const opts = object(raw.options);
  requiredBoolean(opts, 'halves');
  if (opts.substitutionPolicy !== 'any-boundary' && opts.substitutionPolicy !== 'breaks-timeouts-overtime')
    throw new Error(invalid);
  const options = {
    ...fields(opts, ['halfLengthMinutes', 'timeoutsPerTeam', 'timeoutDurationSeconds'], ['halves']),
    substitutionPolicy: opts.substitutionPolicy,
  } as Record<string, unknown>;
  if (opts.breaks !== undefined) {
    options.breaks = array(opts.breaks, maximumRoomBreaks).map((value) => {
      const row = object(value);
      return {
        ...fields(row, ['afterTossup'], []),
        key: string(row.key),
        label: string(row.label, maximumRoomBreakLabelLength),
      };
    });
    const keys = (options.breaks as { key: string }[]).map((row) => row.key);
    if (new Set(keys).size !== keys.length) throw new Error(invalid);
  }
  // All scalars/collections have been checked above; normal validation checks required numbers and semantics.
  const input = {
    gameLabel: string(raw.gameLabel),
    left: team(raw.left),
    right: team(raw.right),
    rules: { mode: rule.mode, [rule.mode]: rules },
    options,
  } as unknown as IManualGameInput;
  const result = defineManualGame(input);
  if (!result.ok) throw new Error(invalid);
  return input;
}

// fflate deliberately does not verify zlib's checksum. Verify it before accepting corrupted data.
function adler32(bytes: Uint8Array): number {
  let a = 1,
    b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function encodePortableGameSetup(input: IManualGameInput): PortableSetupEncodeResult {
  try {
    const canonical = readInput(input);
    const json = new TextEncoder().encode(JSON.stringify(canonical));
    if (json.length > portableSetupLimits.decompressedBytes)
      return { ok: false, message: portableSetupTooLarge };
    const compressed = zlibSync(json, { level: 9 });
    if (compressed.length > portableSetupLimits.compressedBytes)
      return { ok: false, message: portableSetupTooLarge };
    const text = portableSetupPrefix + encodeBase45(compressed);
    if (text.length > portableSetupLimits.encodedCharacters)
      return { ok: false, message: portableSetupTooLarge };
    try {
      const qr = encodeQr(text, portableSetupLimits.qrVersion);
      return {
        ok: true,
        text,
        svg: qrSvg(text, { size: 640 }),
        version: qr.version,
        moduleCount: qr.moduleCount,
      };
    } catch {
      return { ok: false, message: portableSetupTooLarge };
    }
  } catch {
    return {
      ok: false,
      message:
        'This setup is invalid or exceeds the portable field limits. Check the teams, rosters, and game settings.',
    };
  }
}

/** Never throws for camera input. Neither parsing nor validation writes any state. */
export function parsePortableGameSetup(text: string): PortableSetupParseResult {
  try {
    if (text.length > portableSetupLimits.encodedCharacters)
      return { ok: false, message: portableSetupTooLarge };
    if (!text.startsWith('QBSHEET-SETUP:'))
      return { ok: false, message: 'That is not a QBSheet game package.' };
    if (!text.startsWith(portableSetupPrefix))
      return {
        ok: false,
        message: 'This game package version is not supported. Update QBSheet or ask for a version 1 package.',
      };
    const payload = text.slice(portableSetupPrefix.length);
    if (Math.floor((payload.length * 2) / 3) > portableSetupLimits.compressedBytes)
      return { ok: false, message: portableSetupTooLarge };
    const compressed = decodeBase45(payload);
    if (!compressed || compressed.length < 6) return { ok: false, message: invalid };
    // A supplied output buffer disables fflate growth. The extra byte detects overflow even though
    // fflate truncates writes outside the buffer. Compressed input also bounds inflation CPU work.
    const json = unzlibSync(compressed, { out: new Uint8Array(portableSetupLimits.decompressedBytes + 1) });
    if (json.length > portableSetupLimits.decompressedBytes)
      return { ok: false, message: portableSetupTooLarge };
    const checksum = new DataView(
      compressed.buffer,
      compressed.byteOffset + compressed.length - 4,
      4,
    ).getUint32(0);
    if (checksum !== adler32(json)) return { ok: false, message: invalid };
    const input = readInput(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)));
    return { ok: true, input };
  } catch {
    return { ok: false, message: invalid };
  }
}
