import type { ImpositionPlan, PageSlot } from "./imposition.js";

/** 页位的紧凑文本表示：真实页 -> 数字；补白 -> 形如 (补白:B1) */
export function slotText(slot: PageSlot): string {
  return slot.kind === "real" ? String(slot.page) : `补白:${slot.label}`;
}

export interface FlatRow {
  signature: number;
  sheet: number;
  side: "front" | "back";
  sideCn: "正面" | "反面";
  left: string;
  right: string;
}

/** 拍平成逐面一行，便于 CSV / 表格输出 */
export function flatten(plan: ImpositionPlan): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      rows.push({
        signature: sig.index,
        sheet: sheet.index,
        side: "front",
        sideCn: "正面",
        left: slotText(sheet.front.left),
        right: slotText(sheet.front.right),
      });
      rows.push({
        signature: sig.index,
        sheet: sheet.index,
        side: "back",
        sideCn: "反面",
        left: slotText(sheet.back.left),
        right: slotText(sheet.back.right),
      });
    }
  }
  return rows;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCSV(plan: ImpositionPlan): string {
  const header = ["signature", "sheet", "side", "left", "right"];
  const lines = [header.join(",")];
  for (const row of flatten(plan)) {
    lines.push(
      [row.signature, row.sheet, row.side, csvEscape(row.left), csvEscape(row.right)].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function pad(value: string, width: number): string {
  const visible = value;
  return visible + " ".repeat(Math.max(0, width - visible.length));
}

/** 易读的等宽命令行表格（中文按两个显示宽度计） */
export function toTable(plan: ImpositionPlan): string {
  const displayWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) {
      w += /[^\x00-\xff]/.test(ch) ? 2 : 1;
    }
    return w;
  };
  const padCjk = (s: string, width: number): string =>
    s + " ".repeat(Math.max(0, width - displayWidth(s)));

  const rows = flatten(plan).map((r) => ({
    sig: String(r.signature),
    sheet: String(r.sheet),
    side: r.sideCn,
    left: r.left,
    right: r.right,
  }));
  const headers = { sig: "帖", sheet: "纸张", side: "面", left: "左页", right: "右页" };
  const widths = {
    sig: Math.max(displayWidth(headers.sig), ...rows.map((r) => displayWidth(r.sig))),
    sheet: Math.max(displayWidth(headers.sheet), ...rows.map((r) => displayWidth(r.sheet))),
    side: Math.max(displayWidth(headers.side), ...rows.map((r) => displayWidth(r.side))),
    left: Math.max(displayWidth(headers.left), ...rows.map((r) => displayWidth(r.left))),
    right: Math.max(displayWidth(headers.right), ...rows.map((r) => displayWidth(r.right))),
  };

  const line = (cells: string[]) =>
    "| " + cells.map((c, i) => {
      const w = [widths.sig, widths.sheet, widths.side, widths.left, widths.right][i];
      return padCjk(c, w ?? 0);
    }).join(" | ") + " |";
  const sep =
    "|-" +
    [widths.sig, widths.sheet, widths.side, widths.left, widths.right]
      .map((w) => "-".repeat(w))
      .join("-|-") +
    "-|";

  const out: string[] = [];
  out.push(`计划: ${plan.name || "(未命名)"}  总页=${plan.totalPages}  ` +
    `每帖上限=${plan.maxSignaturePages}  纸张=${plan.totalSheets}  补白=${plan.totalBlankPages}`);
  out.push(sep);
  out.push(line([headers.sig, headers.sheet, headers.side, headers.left, headers.right]));
  out.push(sep);
  let lastSig = "";
  for (const r of rows) {
    if (lastSig !== "" && r.sig !== lastSig) out.push(sep);
    out.push(line([r.sig, r.sheet, r.side, r.left, r.right]));
    lastSig = r.sig;
  }
  out.push(sep);
  return out.join("\n");
}

export function signatureSummary(plan: ImpositionPlan): string {
  return plan.signatures
    .map(
      (s) =>
        `第${s.index}帖: ${s.realPages}真实页+${s.blankPages}补白=` +
        `${s.size}页位, ${s.sheets.length}张纸, 真实页 ${s.firstRealPage}-${s.lastRealPage}`,
    )
    .join("\n");
}

void pad;


