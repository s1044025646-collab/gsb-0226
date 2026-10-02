/**
 * 外部页序计划核验。
 *
 * 核验输入为一个布局对象（与 generatePlan 的输出结构一致）。核验维度：
 *  1. 参数合法（totalPages / maxSignaturePages）。
 *  2. 帖、纸张数量正确。
 *  3. 每个真实页 1..totalPages 恰好出现一次（漏页、重页都拒绝）。
 *  4. 补白数量正确，且不占用真实页号。
 *  5. 每张纸正反面的左右页位关系符合一般折叠规则。
 *
 * 注意：仅页码总和相等不代表合法（交换两页总和不变，但页序错误）。
 */
import { generatePlan } from "./imposition.js";
import type { ImpositionPlan, PageSlot } from "./imposition.js";

export interface VerificationIssue {
  code:
    | "INVALID_PARAM"
    | "SIGNATURE_COUNT"
    | "SHEET_COUNT"
    | "POSITION_MISMATCH"
    | "MISSING_PAGE"
    | "DUPLICATE_PAGE"
    | "OUT_OF_RANGE"
    | "BLANK_COUNT"
    | "MALFORMED";
  message: string;
  where?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface VerificationResult {
  valid: boolean;
  totalPages: number;
  maxSignaturePages: number;
  expectedSheets: number;
  actualSheets: number;
  expectedBlankPages: number;
  actualBlankPages: number;
  missingPages: number[];
  duplicatePages: number[];
  issues: VerificationIssue[];
}

interface LooseSlot {
  kind?: unknown;
  page?: unknown;
  label?: unknown;
}
interface LooseSheet {
  front?: { left?: LooseSlot; right?: LooseSlot };
  back?: { left?: LooseSlot; right?: LooseSlot };
}
interface LooseSignature {
  sheets?: LooseSheet[];
}
export interface LoosePlan {
  totalPages?: unknown;
  maxSignaturePages?: unknown;
  signatures?: LooseSignature[];
}

function slotKey(slot: PageSlot): string {
  return slot.kind === "real" ? `P${slot.page}` : slot.label;
}

export function verifyPlan(input: unknown): VerificationResult {
  const issues: VerificationIssue[] = [];
  const loose = (input ?? {}) as LoosePlan;

  let expected: ImpositionPlan;
  try {
    expected = generatePlan({
      totalPages: loose.totalPages,
      maxSignaturePages: loose.maxSignaturePages,
      name: "verify",
    });
  } catch {
    issues.push({
      code: "INVALID_PARAM",
      message: "totalPages 必须为正整数；maxSignaturePages 必须为 >=4 的正整数",
      actual: { totalPages: loose.totalPages, maxSignaturePages: loose.maxSignaturePages },
    });
    return finalize(issues, 0, 0, 0, loose);
  }

  const sigs = Array.isArray(loose.signatures) ? loose.signatures : [];

  if (sigs.length !== expected.signatures.length) {
    issues.push({
      code: "SIGNATURE_COUNT",
      message: `帖数量不符：期望 ${expected.signatures.length}，实际 ${sigs.length}`,
      expected: expected.signatures.length,
      actual: sigs.length,
    });
  }

  const seenReal = new Map<number, number>();
  let actualBlank = 0;
  let actualSheets = 0;

  const normSlot = (s: LooseSlot | undefined): PageSlot | null => {
    if (!s || typeof s !== "object") return null;
    if (s.kind === "real") {
      if (typeof s.page !== "number" || !Number.isInteger(s.page)) return null;
      return { kind: "real", page: s.page };
    }
    if (s.kind === "blank") {
      if (typeof s.label !== "string") return null;
      return { kind: "blank", label: s.label };
    }
    return null;
  };

  sigs.forEach((sig, si) => {
    const expSig = expected.signatures[si];
    const sheets = Array.isArray(sig?.sheets) ? sig.sheets : [];
    actualSheets += sheets.length;
    if (expSig && sheets.length !== expSig.sheets.length) {
      issues.push({
        code: "SHEET_COUNT",
        message: `第 ${si + 1} 帖纸张数不符：期望 ${expSig.sheets.length}，实际 ${sheets.length}`,
        where: `signature[${si}]`,
        expected: expSig.sheets.length,
        actual: sheets.length,
      });
    }
    sheets.forEach((sheet, hi) => {
      const positions: Array<[
        "front.left" | "front.right" | "back.left" | "back.right",
        LooseSlot | undefined,
        PageSlot | undefined,
      ]> = [
        ["front.left", sheet?.front?.left, expSig?.sheets[hi]?.front.left],
        ["front.right", sheet?.front?.right, expSig?.sheets[hi]?.front.right],
        ["back.left", sheet?.back?.left, expSig?.sheets[hi]?.back.left],
        ["back.right", sheet?.back?.right, expSig?.sheets[hi]?.back.right],
      ];
      for (const [pos, rawSlot, want] of positions) {
        const got = normSlot(rawSlot);
        if (!got) {
          issues.push({
            code: "MALFORMED",
            message: `第 ${si + 1} 帖第 ${hi + 1} 张 ${pos} 页位格式非法`,
            where: `signature[${si}].sheets[${hi}].${pos}`,
          });
          continue;
        }
        if (got.kind === "real") {
          seenReal.set(got.page, (seenReal.get(got.page) ?? 0) + 1);
        } else {
          actualBlank++;
        }
        if (want && slotKey(got) !== slotKey(want)) {
          issues.push({
            code: "POSITION_MISMATCH",
            message: `第 ${si + 1} 帖第 ${hi + 1} 张 ${pos} 页位错误：期望 ${slotKey(want)}，实际 ${slotKey(got)}`,
            where: `signature[${si}].sheets[${hi}].${pos}`,
            expected: slotKey(want),
            actual: slotKey(got),
          });
        }
      }
    });
  });

  const missing: number[] = [];
  const duplicates: number[] = [];
  for (let p = 1; p <= expected.totalPages; p++) {
    const count = seenReal.get(p) ?? 0;
    if (count === 0) missing.push(p);
    else if (count > 1) duplicates.push(p);
  }
  for (const [page, count] of seenReal) {
    if (page < 1 || page > expected.totalPages) {
      issues.push({ code: "OUT_OF_RANGE", message: `出现超出范围的真实页 ${page}`, actual: page });
    } else if (count > 1 && !duplicates.includes(page)) {
      duplicates.push(page);
    }
  }
  if (missing.length) {
    issues.push({ code: "MISSING_PAGE", message: `缺少真实页: ${missing.join(", ")}`, actual: missing });
  }
  if (duplicates.length) {
    issues.push({ code: "DUPLICATE_PAGE", message: `重复真实页: ${duplicates.join(", ")}`, actual: duplicates });
  }
  if (actualBlank !== expected.totalBlankPages) {
    issues.push({
      code: "BLANK_COUNT",
      message: `补白页数不符：期望 ${expected.totalBlankPages}，实际 ${actualBlank}`,
      expected: expected.totalBlankPages,
      actual: actualBlank,
    });
  }

  return {
    valid: issues.length === 0,
    totalPages: expected.totalPages,
    maxSignaturePages: expected.maxSignaturePages,
    expectedSheets: expected.totalSheets,
    actualSheets,
    expectedBlankPages: expected.totalBlankPages,
    actualBlankPages: actualBlank,
    missingPages: missing,
    duplicatePages: duplicates,
    issues,
  };
}

function finalize(
  issues: VerificationIssue[],
  totalPages: number,
  maxSig: number,
  expectedSheets: number,
  loose: LoosePlan,
): VerificationResult {
  let actualSheets = 0;
  let actualBlank = 0;
  for (const sig of Array.isArray(loose.signatures) ? loose.signatures : []) {
    for (const sheet of Array.isArray(sig?.sheets) ? sig.sheets : []) {
      actualSheets++;
      for (const side of [sheet?.front, sheet?.back] as const) {
        for (const pos of ["left", "right"] as const) {
          if (side?.[pos]?.kind === "blank") actualBlank++;
        }
      }
    }
  }
  return {
    valid: false,
    totalPages,
    maxSignaturePages: maxSig,
    expectedSheets,
    actualSheets,
    expectedBlankPages: 0,
    actualBlankPages: actualBlank,
    missingPages: [],
    duplicatePages: [],
    issues,
  };
}

