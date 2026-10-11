// A minimal .xlsx writer: one sheet, a few fixed cell styles and, optionally,
// one filterable table. Only what the sales export needs, kept to the plain
// core of the format so Excel, Google Sheets and LibreOffice all open it.

/** How a cell looks. Dates are whole days; money is shown with thousands separators. */
export type CellStyle = 'title' | 'bold' | 'money' | 'moneyBold' | 'date';
export type CellValue = string | number | null;
export type Cell = CellValue | { value: CellValue; style: CellStyle };

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Column widths in characters, from column A. */
  widths?: number[];
  /**
   * Rows from `headerRow` (index into `rows`) to the last one form a table:
   * that row holds the column names, which must be distinct, non-empty texts.
   */
  table?: { name: string; headerRow: number };
  /** Show two decimals in money cells instead of none. */
  moneyDecimals?: boolean;
}

/** A local calendar day (yyyy-mm-dd) as the day number spreadsheets store. */
export function dateSerial(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000 + 25_569;
}

const STYLE_INDEX: Record<CellStyle, number> = { title: 1, bold: 2, money: 3, date: 4, moneyBold: 5 };
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function esc(text: string): string {
  return text
    // Control characters are not allowed in XML at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A1-style column letters for a zero-based index. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

const rels = (items: [type: string, target: string][]) =>
  `${DECL}<Relationships xmlns="${PKG_REL}">${items
    .map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;

function stylesXml(moneyDecimals: boolean): string {
  // 3, 4 and 14 are built-in formats: #,##0, #,##0.00 and the reader's own short date.
  const money = moneyDecimals ? 4 : 3;
  const xf = (numFmt: number, font: number) =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="0" borderId="0" xfId="0"` +
    `${numFmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}/>`;
  const font = (size: number, bold: boolean) =>
    `<font>${bold ? '<b/>' : ''}<sz val="${size}"/><name val="Calibri"/><family val="2"/></font>`;
  return (
    `${DECL}<styleSheet xmlns="${MAIN}">` +
    `<fonts count="3">${font(11, false)}${font(11, true)}${font(16, true)}</fonts>` +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    // In the order of STYLE_INDEX, after the default style.
    `<cellXfs count="6">${xf(0, 0)}${xf(0, 2)}${xf(0, 1)}${xf(money, 0)}${xf(14, 0)}${xf(money, 1)}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

export function xlsx(sheet: Sheet): Uint8Array {
  const strings = new Map<string, number>();
  const shared = (text: string) => {
    let index = strings.get(text);
    if (index === undefined) strings.set(text, (index = strings.size));
    return index;
  };

  let width = 0;
  const rowsXml = sheet.rows.map((row, r) => {
    width = Math.max(width, row.length);
    const cells = row.map((cell, c) => {
      const { value, style } =
        cell !== null && typeof cell === 'object' ? cell : { value: cell, style: undefined };
      if (value === null || value === '') return '';
      const at = `r="${columnName(c)}${r + 1}"${style ? ` s="${STYLE_INDEX[style]}"` : ''}`;
      return typeof value === 'number'
        ? `<c ${at}><v>${value}</v></c>`
        : `<c ${at} t="s"><v>${shared(value)}</v></c>`;
    });
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  });

  const table = sheet.table;
  const cols = (sheet.widths ?? [])
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const sheetXml =
    `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : '') +
    '</worksheet>';

  const files: [path: string, content: string][] = [
    [
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/xl/workbook.xml" ContentType="${TYPE}.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${TYPE}.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="${TYPE}.styles+xml"/>` +
        `<Override PartName="/xl/sharedStrings.xml" ContentType="${TYPE}.sharedStrings+xml"/>` +
        (table ? `<Override PartName="/xl/tables/table1.xml" ContentType="${TYPE}.table+xml"/>` : '') +
        '</Types>',
    ],
    ['_rels/.rels', rels([['officeDocument', 'xl/workbook.xml']])],
    [
      'xl/workbook.xml',
      `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        `<sheet name="${esc(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      rels([
        ['worksheet', 'worksheets/sheet1.xml'],
        ['styles', 'styles.xml'],
        ['sharedStrings', 'sharedStrings.xml'],
      ]),
    ],
    ['xl/worksheets/sheet1.xml', sheetXml],
    ['xl/styles.xml', stylesXml(sheet.moneyDecimals ?? false)],
  ];

  if (table) {
    const header = sheet.rows[table.headerRow]!;
    const ref = `A${table.headerRow + 1}:${columnName(header.length - 1)}${sheet.rows.length}`;
    const columns = header.map((name, i) => `<tableColumn id="${i + 1}" name="${esc(String(name))}"/>`);
    files.push(
      ['xl/worksheets/_rels/sheet1.xml.rels', rels([['table', '../tables/table1.xml']])],
      [
        'xl/tables/table1.xml',
        `${DECL}<table xmlns="${MAIN}" id="1" name="${table.name}" displayName="${table.name}" ref="${ref}" totalsRowShown="0">` +
          `<autoFilter ref="${ref}"/>` +
          `<tableColumns count="${columns.length}">${columns.join('')}</tableColumns>` +
          '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>' +
          '</table>',
      ],
    );
  }

  // Written last: only now are all the texts known.
  const texts = [...strings.keys()].map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`);
  files.push([
    'xl/sharedStrings.xml',
    `${DECL}<sst xmlns="${MAIN}" count="${texts.length}" uniqueCount="${texts.length}">${texts.join('')}</sst>`,
  ]);

  return zip(files);
}

// ------------------------------------------------------------------- zip
// An .xlsx is a zip archive. Entries are stored uncompressed, which every
// reader accepts and needs no compressor here.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: [path: string, content: string][]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map(([path, content]) => {
    const data = encoder.encode(content);
    return { name: encoder.encode(path), data, crc: crc32(data), offset: 0 };
  });
  const size = entries.reduce((sum, e) => sum + 30 + 46 + 2 * e.name.length + e.data.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (n: number) => (view.setUint16(at, n, true), (at += 2));
  const u32 = (n: number) => (view.setUint32(at, n, true), (at += 4));
  const raw = (bytes: Uint8Array) => (out.set(bytes, at), (at += bytes.length));
  /** The fields a local header and its central directory record share. */
  const common = (e: (typeof entries)[number]) => {
    u16(20); // version needed
    u16(0); // flags
    u16(0); // method: stored
    u16(0); // time 00:00
    u16(0x21); // date 1980-01-01: the archive carries no real timestamps
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra field length
  };

  for (const e of entries) {
    e.offset = at;
    u32(0x04034b50);
    common(e);
    raw(e.name);
    raw(e.data);
  }
  const directory = at;
  for (const e of entries) {
    u32(0x02014b50);
    u16(20); // version made by
    common(e);
    u16(0); // comment length
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    raw(e.name);
  }
  const directorySize = at - directory;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(directorySize);
  u32(directory);
  u16(0);
  return out;
}
