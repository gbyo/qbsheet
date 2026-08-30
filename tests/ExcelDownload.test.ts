import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test, vi } from 'vitest';
import { IStoredGameRecord } from '../src/game/GameStore';
import {
  downloadExcelScoresheet,
  excelFileName,
  excelWorkbookBytes,
} from '../src/integrations/file/ExcelDownload';
import { IDownloadEnvironment } from '../src/integrations/file/QbjDownload';
import { validPackage } from './packages';

function completedRecord(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  const packageValue = validPackage({
    tournament: { key: 'spring-2026', name: 'Spring & Summer Invitational' },
  });
  const [power, correct, neg] = packageValue.scorekeeperFormat.answerTypes;
  return {
    version: 1,
    id: 'excel-result',
    identity: 'excel-result',
    attempt: 1,
    gameKey: 'excel-session',
    package: packageValue,
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: false,
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:30:00.000Z',
    completedAt: '2026-08-12T12:30:00.000Z',
    finalScore: { left: 35, right: 5 },
    finalQbj: {
      tossups_read: 2,
      moderator: 'Pat <Reader>',
      scorekeeper: 'Alex & Casey',
      match_teams: [
        {
          team: { name: 'Ninety Six A' },
          points: 35,
          match_players: [
            {
              player: { name: 'Sarah Mitchell' },
              tossups_heard: 2,
              answer_counts: [
                { number: 1, answer_type: { id: power.qbjId, value: power.value } },
                { number: 1, answer_type: { id: neg.qbjId, value: neg.value } },
              ],
            },
          ],
        },
        {
          team: { name: 'Greenwood' },
          points: 5,
          match_players: [
            {
              player: { name: 'Emma Chen' },
              tossups_heard: 2,
              answer_counts: [{ number: 1, answer_type: { id: correct.qbjId, value: correct.value } }],
            },
          ],
        },
      ],
      match_questions: [
        {
          question_number: 1,
          buzzes: [
            { team: { name: 'Ninety Six A' }, player: { name: 'Sarah Mitchell' }, result: { value: 15 } },
          ],
          bonus_points: 20,
        },
        {
          question_number: 2,
          buzzes: [
            { team: { name: 'Ninety Six A' }, player: { name: 'Sarah Mitchell' }, result: { value: -5 } },
            { team: { name: 'Greenwood' }, player: { name: 'Emma Chen' }, result: { value: 10 } },
          ],
          tossup_question: { type: 'replacement' },
        },
      ],
    },
    serverDelivery: 'none',
    ...overrides,
  };
}

function xmlFile(files: Record<string, Uint8Array>, path: string): string {
  const file = files[path];
  expect(file, `${path} should be in the workbook`).toBeDefined();
  return strFromU8(file);
}

describe('completed-game Excel export', () => {
  test('builds a real XLSX package with summary, player and question sheets', () => {
    const files = unzipSync(excelWorkbookBytes(completedRecord()));

    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/styles.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
        'xl/worksheets/sheet3.xml',
      ]),
    );

    const workbook = xmlFile(files, 'xl/workbook.xml');
    expect(workbook).toContain('name="Summary"');
    expect(workbook).toContain('name="Players"');
    expect(workbook).toContain('name="Questions"');

    const summary = xmlFile(files, 'xl/worksheets/sheet1.xml');
    expect(summary).toContain('Spring &amp; Summer Invitational');
    expect(summary).toContain('Pat &lt;Reader&gt;');
    expect(summary).toContain('Alex &amp; Casey');
    expect(summary).toContain('<v>35</v>');
    expect(summary).toContain('<v>5</v>');
    expect(summary).toContain('s="5"');

    const players = xmlFile(files, 'xl/worksheets/sheet2.xml');
    expect(players).toContain('Sarah Mitchell');
    expect(players).toContain('Emma Chen');
    expect(players).toContain('>+15<');
    expect(players).toContain('>−5<');
    expect(players).toContain('<f>');

    const questions = xmlFile(files, 'xl/worksheets/sheet3.xml');
    expect(questions).toContain('Ninety Six A — Sarah Mitchell +15');
    expect(questions).toContain('Replacement question');
    expect(questions).toContain('<f>C4+D4+E4</f>');
  });

  test('uses a useful, filesystem-safe Excel filename', () => {
    expect(excelFileName(completedRecord())).toBe('R07_Room-204_Ninety-Six-A_vs_Greenwood_scoresheet.xlsx');
  });

  test('downloads the XLSX bytes with the Excel media type', () => {
    let blob: Blob | undefined;
    const click = vi.fn();
    const anchor = { href: '', download: '', rel: '', click };
    const environment: IDownloadEnvironment = {
      createObjectURL: (candidate) => {
        blob = candidate;
        return 'blob:excel';
      },
      revokeObjectURL: vi.fn(),
      createAnchor: () => anchor as unknown as HTMLAnchorElement,
    };

    expect(downloadExcelScoresheet(completedRecord(), environment)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('R07_Room-204_Ninety-Six-A_vs_Greenwood_scoresheet.xlsx');
    expect(blob?.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blob!.size).toBeGreaterThan(0);
  });

  test('refuses an Excel download when the finished QBJ is absent', () => {
    const createObjectURL = vi.fn();
    expect(
      downloadExcelScoresheet(completedRecord({ finalQbj: undefined }), {
        createObjectURL,
        revokeObjectURL: vi.fn(),
        createAnchor: vi.fn(),
      }),
    ).toBe(false);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
