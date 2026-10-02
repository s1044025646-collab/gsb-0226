import type { Cell, ImpositionPlan } from './types.js';

export const cellText = (cell: Cell): string =>
  cell.type === 'real' ? String(cell.page) : cell.label;

export interface PlanRow {
  signatureIndex: number;
  sheetIndex: number;
  frontLeft: string;
  frontRight: string;
  backLeft: string;
  backRight: string;
}

export function toRows(plan: ImpositionPlan): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      rows.push({
        signatureIndex: sig.signatureIndex,
        sheetIndex: sheet.sheetIndex,
        frontLeft: cellText(sheet.front.left),
        frontRight: cellText(sheet.front.right),
        backLeft: cellText(sheet.back.left),
        backRight: cellText(sheet.back.right),
      });
    }
  }
  return rows;
}

const CSV_HEADER = 'signature,sheet,front_left,front_right,back_left,back_right';

export function toCSV(plan: ImpositionPlan): string {
  const lines = [CSV_HEADER];
  for (const row of toRows(plan)) {
    lines.push(
      [
        row.signatureIndex,
        row.sheetIndex,
        row.frontLeft,
        row.frontRight,
        row.backLeft,
        row.backRight,
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function pad(value: string, width: number): string {
  // 中文等宽环境下这里全部是 ASCII，直接 padEnd
  return value.padEnd(width, ' ');
}

/** 易读的命令行表格 */
export function toTable(plan: ImpositionPlan): string {
  const rows = toRows(plan);
  const header = {
    sig: '帖',
    sheet: '纸张',
    fl: '正面左',
    fr: '正面右',
    bl: '反面左',
    br: '反面右',
  };
  const data = rows.map((r) => ({
    sig: String(r.signatureIndex),
    sheet: String(r.sheetIndex),
    fl: r.frontLeft,
    fr: r.frontRight,
    bl: r.backLeft,
    br: r.backRight,
  }));
  const widths = {
    sig: 4,
    sheet: 4,
    fl: 6,
    fr: 6,
    bl: 6,
    br: 6,
  };
  for (const d of data) {
    widths.sig = Math.max(widths.sig, d.sig.length + 2);
    widths.sheet = Math.max(widths.sheet, d.sheet.length + 2);
    widths.fl = Math.max(widths.fl, d.fl.length + 2);
    widths.fr = Math.max(widths.fr, d.fr.length + 2);
    widths.bl = Math.max(widths.bl, d.bl.length + 2);
    widths.br = Math.max(widths.br, d.br.length + 2);
  }

  const border =
    '+' +
    ['-'.repeat(widths.sig), '-'.repeat(widths.sheet), '-'.repeat(widths.fl), '-'.repeat(widths.fr), '-'.repeat(widths.bl), '-'.repeat(widths.br)].join('+') +
    '+';

  const formatRow = (c: { sig: string; sheet: string; fl: string; fr: string; bl: string; br: string }) =>
    `| ${pad(c.sig, widths.sig - 2)} | ${pad(c.sheet, widths.sheet - 2)} | ${pad(c.fl, widths.fl - 2)} | ${pad(c.fr, widths.fr - 2)} | ${pad(c.bl, widths.bl - 2)} | ${pad(c.br, widths.br - 2)} |`;

  const lines: string[] = [
    border,
    formatRow(header),
    border,
    ...data.map(formatRow),
    border,
  ];
  return lines.join('\n');
}

export function toJSON(plan: ImpositionPlan): string {
  return JSON.stringify(plan, null, 2);
}
