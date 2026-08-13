/**
 * A readable Excel copy of a finished scoresheet.
 *
 * QBJ remains the interchange and recovery format. This projection is for the coach, director or
 * scorekeeper who wants to open the result directly in Excel: a compact summary, player totals and
 * the question log already frozen into the completed QBJ. It deliberately reads `finalQbj` rather
 * than deriving the event journal again, so the workbook cannot disagree with the result that was
 * submitted or handed over.
 *
 * An `.xlsx` file is a ZIP of small OOXML documents. Building those documents here keeps the
 * browser export offline-first and avoids shipping a general spreadsheet engine for three simple
 * tables. `fflate` supplies only the standards-compliant ZIP container.
 */
import { strToU8, zipSync } from 'fflate';
import { IStoredGameRecord } from '../../game/GameStore';
import { sanitizeFileNamePart, downloadFile, IDownloadEnvironment } from './QbjDownload';

type QbjObject = Record<string, unknown>;
type Cell = string | number | boolean | null | FormulaCell | DateCell;

interface FormulaCell {
  formula: string;
  value: number;
}

interface DateCell {
  excelDate: number;
}

interface SheetDefinition {
  name: string;
  rows: Cell[][];
  columnWidths: number[];
  mergedCells?: string[];
  freezeRows?: number;
  autoFilter?: string;
  titleRow?: number;
  sectionRows?: number[];
  headerRows?: number[];
}

const excelMediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const millisecondsPerDay = 86_400_000;

function objectValue(value: unknown): QbjObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as QbjObject) : null;
}

function objectArray(value: unknown): QbjObject[] {
  return Array.isArray(value) ? value.map(objectValue).filter((entry): entry is QbjObject => entry !== null) : [];
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function teamName(team: QbjObject, fallback: string): string {
  return textValue(objectValue(team.team)?.name) ?? fallback;
}

function teamScore(team: QbjObject, fallback: number | undefined): number | null {
  return numberValue(team.points) ?? fallback ?? null;
}

function xmlText(value: unknown): string {
  return String(value ?? '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlAttribute(value: unknown): string {
  return xmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function excelLocalDate(iso: string | undefined): DateCell | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const localAsUtc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
  return { excelDate: localAsUtc / millisecondsPerDay + 25_569 };
}

function isFormulaCell(cell: Cell): cell is FormulaCell {
  return objectValue(cell) !== null && 'formula' in (cell as FormulaCell);
}

function isDateCell(cell: Cell): cell is DateCell {
  return objectValue(cell) !== null && 'excelDate' in (cell as DateCell);
}

function cellXml(cell: Cell, reference: string, style: number): string {
  if (cell === null || cell === '') return `<c r="${reference}"${style ? ` s="${style}"` : ''}/>`;
  if (isFormulaCell(cell)) {
    return `<c r="${reference}"${style ? ` s="${style}"` : ''}><f>${xmlText(cell.formula)}</f><v>${cell.value}</v></c>`;
  }
  if (isDateCell(cell)) return `<c r="${reference}" s="5"><v>${cell.excelDate}</v></c>`;
  if (typeof cell === 'number') return `<c r="${reference}"${style ? ` s="${style}"` : ''}><v>${cell}</v></c>`;
  if (typeof cell === 'boolean') return `<c r="${reference}" t="b"${style ? ` s="${style}"` : ''}><v>${cell ? 1 : 0}</v></c>`;
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
}

function sheetXml(sheet: SheetDefinition): string {
  const titleRows = new Set(sheet.titleRow ? [sheet.titleRow] : []);
  const sectionRows = new Set(sheet.sectionRows ?? []);
  const headerRows = new Set(sheet.headerRows ?? []);
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const number = rowIndex + 1;
      const style = titleRows.has(number) ? 1 : sectionRows.has(number) ? 2 : headerRows.has(number) ? 3 : 0;
      const cells = row.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${number}`, style)).join('');
      const height = titleRows.has(number) ? ' ht="28" customHeight="1"' : headerRows.has(number) ? ' ht="22" customHeight="1"' : '';
      return `<row r="${number}"${height}>${cells}</row>`;
    })
    .join('');
  const columnWidths = sheet.columnWidths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');
  const merges = sheet.mergedCells?.length
    ? `<mergeCells count="${sheet.mergedCells.length}">${sheet.mergedCells.map((range) => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>`
    : '';
  const pane = sheet.freezeRows
    ? `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/>`
    : '';
  const autoFilter = sheet.autoFilter ? `<autoFilter ref="${xmlAttribute(sheet.autoFilter)}"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columnWidths}</cols>
  <sheetData>${rows}</sheetData>
  ${merges}
  ${autoFilter}
  <pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.2" footer="0.2"/>
</worksheet>`;
}

interface AnswerType {
  key: string;
  label: string;
  value: number;
}

function signedPoints(value: number): string {
  return value > 0 ? `+${value}` : String(value).replace('-', '−');
}

function answerTypeKey(id: string | undefined, value: number): string {
  // Both fields matter: separate rulings can legitimately carry the same value or the same id.
  return `${id ?? ''}\u001f${value}`;
}

function answerTypeLabel(id: string | undefined, value: number): string {
  const points = signedPoints(value);
  if (!id || id === String(value) || id === points) return points;
  const readableId = id
    ?.replace(/^AnswerType[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return readableId ? `${readableId} (${points})` : points;
}

function answerTypes(record: IStoredGameRecord, teams: QbjObject[]): AnswerType[] {
  const found = new Map<string, AnswerType>();
  for (const type of record.package.scorekeeperFormat.answerTypes) {
    const key = answerTypeKey(type.qbjId, type.value);
    found.set(key, { key, value: type.value, label: answerTypeLabel(type.label, type.value) });
  }
  for (const team of teams) {
    for (const player of objectArray(team.match_players)) {
      for (const count of objectArray(player.answer_counts)) {
        const answerType = objectValue(count.answer_type);
        const value = numberValue(answerType?.value);
        if (value === undefined) continue;
        const id = textValue(answerType?.id);
        const key = answerTypeKey(id, value);
        if (!found.has(key)) {
          found.set(key, { key, value, label: answerTypeLabel(id, value) });
        }
      }
    }
  }
  return [...found.values()].sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
}

function countFor(player: QbjObject, answerType: AnswerType): number {
  for (const count of objectArray(player.answer_counts)) {
    const candidate = objectValue(count.answer_type);
    const id = textValue(candidate?.id);
    const value = numberValue(candidate?.value);
    if (value !== undefined && answerTypeKey(id, value) === answerType.key) return numberValue(count.number) ?? 0;
  }
  return 0;
}

function formulaFromCounts(row: number, firstColumn: number, counts: number[], types: AnswerType[]): FormulaCell {
  const terms = types.map((type, index) => `${columnName(firstColumn + index)}${row}*(${type.value})`);
  return {
    formula: terms.length > 0 ? terms.join('+') : '0',
    value: counts.reduce((total, count, index) => total + count * types[index].value, 0),
  };
}

function resultLabel(score: number | null, otherScore: number | null): string {
  if (score === null || otherScore === null) return '';
  if (score === otherScore) return 'Tie';
  return score > otherScore ? 'Win' : 'Loss';
}

function summarySheet(record: IStoredGameRecord, qbj: QbjObject, teams: QbjObject[]): SheetDefinition {
  const leftScore = teamScore(teams[0] ?? {}, record.finalScore?.left);
  const rightScore = teamScore(teams[1] ?? {}, record.finalScore?.right);
  const leftName = teamName(teams[0] ?? {}, record.package.left.name);
  const rightName = teamName(teams[1] ?? {}, record.package.right.name);
  return {
    name: 'Summary',
    columnWidths: [22, 28, 22, 28],
    mergedCells: ['A1:D1', 'A2:D2', 'A4:D4', 'A12:D12'],
    titleRow: 1,
    sectionRows: [4, 12],
    headerRows: [13],
    rows: [
      ['QBSheet game result', null, null, null],
      [`${leftName} vs ${rightName}`, null, null, null],
      [],
      ['Game', null, null, null],
      ['Tournament', record.package.tournament.name, 'Packet', record.package.round.packetName ?? ''],
      ['Round', record.package.round.name, 'Round number', record.package.round.number],
      ['Room', record.package.room?.name ?? '', 'Completed', excelLocalDate(record.completedAt)],
      ['Moderator', textValue(qbj.moderator) ?? '', 'Scorekeeper', textValue(qbj.scorekeeper) ?? ''],
      ['Tossups read', numberValue(qbj.tossups_read) ?? null, 'Overtime tossups', numberValue(qbj.overtime_tossups_read) ?? 0],
      ['Notes', textValue(qbj.notes) ?? '', null, null],
      [],
      ['Final score', null, null, null],
      ['Team', 'Score', 'Result', 'Forfeit'],
      [leftName, leftScore, resultLabel(leftScore, rightScore), booleanValue(teams[0]?.forfeit_loss) ? 'Yes' : 'No'],
      [rightName, rightScore, resultLabel(rightScore, leftScore), booleanValue(teams[1]?.forfeit_loss) ? 'Yes' : 'No'],
    ],
  };
}

function playersSheet(record: IStoredGameRecord, teams: QbjObject[]): SheetDefinition {
  const types = answerTypes(record, teams);
  const headers = ['Team', 'Player', 'Tossups heard', ...types.map((type) => type.label), 'Tossup points'];
  const rows: Cell[][] = [['Player statistics', ...Array.from({ length: headers.length - 1 }, () => null)], [], headers];
  for (const [teamIndex, team] of teams.entries()) {
    const name = teamName(team, teamIndex === 0 ? record.package.left.name : record.package.right.name);
    for (const player of objectArray(team.match_players)) {
      const counts = types.map((type) => countFor(player, type));
      const rowNumber = rows.length + 1;
      rows.push([
        name,
        textValue(objectValue(player.player)?.name) ?? 'Unknown player',
        numberValue(player.tossups_heard) ?? 0,
        ...counts,
        formulaFromCounts(rowNumber, 3, counts, types),
      ]);
    }
  }
  if (rows.length === 3) rows.push(['No player statistics were recorded.', ...Array.from({ length: headers.length - 1 }, () => null)]);
  return {
    name: 'Players',
    columnWidths: [24, 24, 16, ...types.map(() => 15), 18],
    mergedCells: [`A1:${columnName(headers.length - 1)}1`],
    freezeRows: 3,
    autoFilter: `A3:${columnName(headers.length - 1)}${rows.length}`,
    titleRow: 1,
    headerRows: [3],
    rows,
  };
}

function buzzText(question: QbjObject): string {
  return objectArray(question.buzzes)
    .map((buzz) => {
      const team = textValue(objectValue(buzz.team)?.name) ?? 'Unknown team';
      const player = textValue(objectValue(buzz.player)?.name);
      const points = numberValue(objectValue(buzz.result)?.value);
      const signedPoints = points === undefined ? '' : ` ${points > 0 ? '+' : ''}${points}`;
      return `${team}${player ? ` — ${player}` : ''}${signedPoints}`;
    })
    .join('; ');
}

function questionsSheet(qbj: QbjObject): SheetDefinition {
  const headers = ['Question', 'Buzzes', 'Tossup points', 'Controlled bonus', 'Bounceback bonus', 'Total awarded', 'Note'];
  const rows: Cell[][] = [['Question log', null, null, null, null, null, null], [], headers];
  for (const question of objectArray(qbj.match_questions)) {
    const buzzPoints = objectArray(question.buzzes).reduce(
      (total, buzz) => total + (numberValue(objectValue(buzz.result)?.value) ?? 0),
      0,
    );
    const controlled = numberValue(question.bonus_points) ?? 0;
    const bounceback = numberValue(question.bonus_bounceback_points) ?? 0;
    const rowNumber = rows.length + 1;
    const replacement = textValue(objectValue(question.tossup_question)?.type) === 'replacement';
    rows.push([
      numberValue(question.question_number) ?? null,
      buzzText(question),
      buzzPoints,
      controlled,
      bounceback,
      { formula: `C${rowNumber}+D${rowNumber}+E${rowNumber}`, value: buzzPoints + controlled + bounceback },
      replacement ? 'Replacement question' : '',
    ]);
  }
  if (rows.length === 3) rows.push(['No question-level detail was recorded.', null, null, null, null, null, null]);
  return {
    name: 'Questions',
    columnWidths: [12, 54, 16, 18, 18, 16, 24],
    mergedCells: ['A1:G1'],
    freezeRows: 3,
    autoFilter: `A3:G${rows.length}`,
    titleRow: 1,
    headerRows: [3],
    rows,
  };
}

function workbookXml(sheets: SheetDefinition[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets>${sheets.map((sheet, index) => `<sheet name="${xmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
}

function workbookRelationships(sheets: SheetDefinition[]): string {
  const sheetRelationships = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRelationships}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function contentTypes(sheets: SheetDefinition[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm"/></numFmts>
  <fonts count="3">
    <font><sz val="10"/><color rgb="FF172033"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/><family val="2"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF174EA6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2F6FD0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD5DEED"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function coreProperties(record: IStoredGameRecord): string {
  const completed = record.completedAt && Number.isFinite(new Date(record.completedAt).getTime())
    ? new Date(record.completedAt).toISOString()
    : new Date(0).toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlText(`${record.package.left.name} vs ${record.package.right.name}`)}</dc:title>
  <dc:creator>QBSheet</dc:creator>
  <cp:lastModifiedBy>QBSheet</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${completed}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${completed}</dcterms:modified>
</cp:coreProperties>`;
}

function appProperties(sheets: SheetDefinition[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>QBSheet</Application>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) => `<vt:lpstr>${xmlText(sheet.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts>
</Properties>`;
}

/** Produce the exact bytes downloaded by the completion screen. Exported for compact file tests. */
export function excelWorkbookBytes(record: IStoredGameRecord): Uint8Array {
  const qbj = objectValue(record.finalQbj) ?? {};
  const teams = objectArray(qbj.match_teams);
  const sheets = [summarySheet(record, qbj, teams), playersSheet(record, teams), questionsSheet(qbj)];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(sheets)),
    '_rels/.rels': strToU8(rootRelationships),
    'docProps/core.xml': strToU8(coreProperties(record)),
    'docProps/app.xml': strToU8(appProperties(sheets)),
    'xl/workbook.xml': strToU8(workbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelationships(sheets)),
    'xl/styles.xml': strToU8(stylesXml),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
}

export function excelFileName(record: IStoredGameRecord): string {
  const parts = [`R${String(Math.trunc(record.package.round.number)).padStart(2, '0')}`];
  const room = record.package.room?.name;
  if (room && room.trim() !== '') parts.push(sanitizeFileNamePart(room, 'Room'));
  parts.push(sanitizeFileNamePart(record.package.left.name, 'Team-1'));
  parts.push('vs');
  parts.push(sanitizeFileNamePart(record.package.right.name, 'Team-2'));
  parts.push('scoresheet');
  return `${parts.join('_')}.xlsx`;
}

/** Download a human-readable workbook. This never satisfies the separate QBJ handoff requirement. */
export function downloadExcelScoresheet(
  record: IStoredGameRecord,
  environment?: IDownloadEnvironment | null,
): boolean {
  if (!record.finalQbj) return false;
  const bytes = new Uint8Array(excelWorkbookBytes(record));
  return downloadFile(bytes, excelFileName(record), environment, excelMediaType);
}
