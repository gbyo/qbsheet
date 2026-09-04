import { describe, expect, test } from 'vitest';
import { zlibSync } from 'fflate';
import { decodeBase45, encodeBase45 } from '../src/qr/Base45';
import { defineManualGame } from '../src/game/ManualGame';
import {
  encodePortableGameSetup,
  parsePortableGameSetup,
  portableSetupLimits,
  portableSetupPrefix,
} from '../src/game/PortableGameSetup';
import { maxAnswerTypes, maxPlayersPerTeam } from '../src/game/GamePackageValidation';
import { maximumRoomBreaks } from '../src/scoring/RoomProcedure';
import { portableInput } from './portableSetupFixtures';

function wire(value: unknown) {
  return textWire(JSON.stringify(value));
}
function textWire(value: string) {
  return portableSetupPrefix + encodeBase45(zlibSync(new TextEncoder().encode(value)));
}

describe('Base45', () => {
  test.each([
    ['AB', 'BB8'],
    ['Hello!!', '%69 VD92EX0'],
    ['base-45', 'UJCLQE7W581'],
  ])('RFC vector %s', (value, encoded) => {
    expect(encodeBase45(new TextEncoder().encode(value))).toBe(encoded);
    expect(new TextDecoder().decode(decodeBase45(encoded)!)).toBe(value);
  });
  test.each(['A', 'AAAA', 'aa', '~~', '::', ':::'])('rejects malformed input %s', (value) =>
    expect(decodeBase45(value)).toBeNull(),
  );
  test('every byte including odd tails and trailing spaces survives', () => {
    for (let length = 0; length < 258; length++) {
      const data = Uint8Array.from({ length }, (_, i) => i % 256);
      expect(decodeBase45(encodeBase45(data))).toEqual(data);
    }
  });
});

describe('portable manual setup', () => {
  test.each([false, true])(
    'round trips basic/advanced=%s with Unicode, literal roster punctuation, and active procedures',
    (advanced) => {
      const input = portableInput(advanced);
      const encoded = encodePortableGameSetup(input);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;
      expect(encoded.text).toMatch(/^QBSHEET-SETUP:1:[0-9A-Z $%*+\-./:]+$/);
      const parsed = parsePortableGameSetup(encoded.text);
      expect(parsed).toEqual({ ok: true, input });
      if (parsed.ok) expect(defineManualGame(parsed.input)).toEqual(defineManualGame(input));
    },
  );
  test('spreadsheet tabs and blank roster lines are preserved as entered', () => {
    const input = portableInput();
    input.left.players = 'Smith, John\tGrade 9\r\n\r\nZoë\tGrade 10\n';
    const encoded = encodePortableGameSetup(input);
    expect(encoded.ok && parsePortableGameSetup(encoded.text)).toEqual({ ok: true, input });
  });
  test.each(['2', '01', '', '1.0', '1:2'])('rejects unsupported envelope %s', (version) => {
    expect(parsePortableGameSetup(`QBSHEET-SETUP:${version}:AB`)).toMatchObject({ ok: false });
  });
  test.each([
    'unrelated',
    'qbsheet-setup:1:AB',
    ' QBSHEET-SETUP:1:AB',
    'QBSHEET-SETUP:1:!',
    'QBSHEET-SETUP:1:aa',
    'QBSHEET-SETUP:1:AAA',
  ])('rejects malformed scan without throwing: %s', (text) => {
    expect(parsePortableGameSetup(text)).toMatchObject({ ok: false });
  });
  test('bounds both encoded length and compressed bytes', () => {
    expect(
      parsePortableGameSetup(portableSetupPrefix + 'A'.repeat(portableSetupLimits.encodedCharacters)),
    ).toMatchObject({ ok: false });
    expect(
      parsePortableGameSetup(
        portableSetupPrefix + encodeBase45(new Uint8Array(portableSetupLimits.compressedBytes + 1)),
      ),
    ).toMatchObject({ ok: false });
  });
  test('rejects decompression bombs using a bounded output buffer', () => {
    const compressed = zlibSync(new Uint8Array(8 * 1024 * 1024).fill(65), { level: 9 });
    // A smaller bomb fits the compressed cap and must hit the decompressed cap.
    const small = textWire('A'.repeat(portableSetupLimits.decompressedBytes * 8));
    expect(parsePortableGameSetup(small)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/too large/),
    });
    expect(parsePortableGameSetup(portableSetupPrefix + encodeBase45(compressed))).toMatchObject({
      ok: false,
    });
  });
  test('rejects invalid compression, truncated streams, and checksum corruption', () => {
    const bytes = zlibSync(new TextEncoder().encode(JSON.stringify(portableInput())));
    for (const bad of [
      new Uint8Array(50).fill(255),
      bytes.slice(0, -8),
      Uint8Array.from(bytes, (b, i) => (i === bytes.length - 1 ? b ^ 1 : b)),
    ]) {
      expect(parsePortableGameSetup(portableSetupPrefix + encodeBase45(bad))).toMatchObject({ ok: false });
    }
  });
  test.each(['{', 'undefined', 'null', '[]', '"setup"', '['.repeat(2000) + '0' + ']'.repeat(2000)])(
    'rejects JSON that is not a setup',
    (json) => {
      expect(parsePortableGameSetup(textWire(json))).toMatchObject({ ok: false });
    },
  );
  test.each([
    (v: ReturnType<typeof portableInput>) => {
      v.left.name = '';
    },
    (v: ReturnType<typeof portableInput>) => {
      v.right.name = v.left.name;
    },
    (v: ReturnType<typeof portableInput>) => {
      v.left.players = '';
    },
    (v: ReturnType<typeof portableInput>) => {
      v.left.players = 'A'.repeat(201);
    },
    (v: ReturnType<typeof portableInput>) => {
      v.left.players = Array.from({ length: maxPlayersPerTeam + 1 }, (_, i) => `Player ${i}`).join('\n');
    },
    (v: ReturnType<typeof portableInput>) => {
      v.options.timeoutsPerTeam = 10;
    },
    (v: ReturnType<typeof portableInput>) => {
      v.options.breaks = Array.from({ length: maximumRoomBreaks + 1 }, (_, i) => ({
        key: String(i),
        afterTossup: i + 1,
        label: '',
      }));
    },
    (v: ReturnType<typeof portableInput>) => {
      if (v.rules.mode === 'basic') v.rules.basic.tossupValue = undefined;
    },
    (v: ReturnType<typeof portableInput>) => {
      if (v.rules.mode === 'basic') v.rules.basic.tossupCount = 0;
    },
  ])('rejects semantically invalid games on encode and decode', (mutate) => {
    const input = portableInput();
    mutate(input);
    expect(encodePortableGameSetup(input).ok).toBe(false);
    expect(parsePortableGameSetup(wire(input)).ok).toBe(false);
  });
  test.each([
    { rules: { mode: 'future', basic: {} } },
    { rules: { mode: 'basic', basic: {} } },
    { left: { name: {}, players: [] } },
    { options: { halves: 'yes' } },
  ])('does not turn malformed fields into default games', (patch) => {
    expect(parsePortableGameSetup(wire({ ...portableInput(), ...patch })).ok).toBe(false);
  });
  test('bounds answer types, checks each row, and rejects wrong scalar types', () => {
    const input = portableInput(true);
    if (input.rules.mode !== 'advanced') return;
    const rules = input.rules.advanced;
    for (const answerTypes of [
      Array(maxAnswerTypes + 1).fill(rules.answerTypes[0]),
      [null],
      [{ ...rules.answerTypes[0], awardsBonus: 'true' }],
      [{ ...rules.answerTypes[0], label: [] }],
    ]) {
      expect(
        parsePortableGameSetup(
          wire({ ...input, rules: { mode: 'advanced', advanced: { ...rules, answerTypes } } }),
        ).ok,
      ).toBe(false);
    }
  });
  test('projects only manual fields, excluding unknown credentials and identifiers', () => {
    const input = portableInput();
    const encoded = encodePortableGameSetup({
      ...input,
      roomToken: 'secret',
      startingLineups: ['invented'],
      deviceId: 'secret',
    } as typeof input);
    expect(encoded.ok && parsePortableGameSetup(encoded.text)).toEqual({ ok: true, input });
  });
});
