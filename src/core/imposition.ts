/**
 * 拼版核心类型与算法。
 *
 * 装订模型（范围限定）：
 *  - 左侧装订（对折线在左，书口在右）。
 *  - 每张纸（sheet）正反两面，每面并排两页：正面(front) / 反面(back)，
 *    每面给出"正向观看时"的左页(left)与右页(right)。
 *  - 一张纸对折后承载 4 个页位；多张贴叠在一起对折，用骑缝订合成一"帖"。
 *  - 帖(signature)是一个独立折叠、装订的小册单元，页数必须为 4 的倍数。
 *
 * 基准（8 页一帖，由外到内）：
 *  - 外张 正面 8(左) / 1(右)，反面 2(左) / 7(右)
 *  - 内张 正面 6(左) / 3(右)，反面 4(左) / 5(右)
 *
 * 一般规则：一帖共 size 个页位（含补白），第 k 张（k 从 1 开始，由外到内）
 *  的四个页位依次为：
 *    正面左 = size - 2(k-1)
 *    正面右 = 2(k-1) + 1
 *    反面左 = 2(k-1) + 2
 *    反面右 = size - 2(k-1) - 1
 *  页位号在 1..realPages 之间为真实页（贯穿各帖连续编号），其余为补白(blank)。
 */

export type PageSlot =
  | { kind: "real"; page: number }
  | { kind: "blank"; label: string };

export interface Side {
  /** 正向观看时的左页 */
  left: PageSlot;
  /** 正向观看时的右页 */
  right: PageSlot;
}

export interface Sheet {
  /** 帖内序号，1 起，由外到内 */
  index: number;
  /** 正面（纸张的一面） */
  front: Side;
  /** 反面（纸张的另一面） */
  back: Side;
}

export interface Signature {
  /** 文档内帖序号，1 起 */
  index: number;
  /** 该帖页位总数（4 的倍数，含补白） */
  size: number;
  /** 该帖包含的真实页数 */
  realPages: number;
  /** 该帖补白页数 */
  blankPages: number;
  /** 该帖真实页范围（贯穿全文档连续编号） */
  firstRealPage: number;
  lastRealPage: number;
  /** 是否为最后一帖（可能含补白） */
  isLast: boolean;
  sheets: Sheet[];
}

export interface ImpositionPlan {
  totalPages: number;
  maxSignaturePages: number;
  name: string;
  totalSheets: number;
  totalBlankPages: number;
  signatures: Signature[];
}

export interface PlanInput {
  totalPages: number;
  maxSignaturePages: number;
  name: string;
}

/**
 * 校验并规整输入参数。
 *  - totalPages：正整数（>=1）。
 *  - maxSignaturePages：>=4 的正整数，表示每帖页位上界；实际每帖大小取
 *    不超过该上界的最大 4 的倍数（例如 14 表示每帖最多 12 页）。
 */
export function validateParams(raw: {
  totalPages: unknown;
  maxSignaturePages: unknown;
  name?: unknown;
}): PlanInput {
  const totalPages = toPositiveInt(raw.totalPages, "totalPages");
  const maxRaw = toPositiveInt(raw.maxSignaturePages, "maxSignaturePages");
  if (maxRaw < 4) {
    throwRange("maxSignaturePages", "必须是 >=4 的正整数");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return { totalPages, maxSignaturePages: maxRaw, name };
}

function toPositiveInt(value: unknown, field: string): number {
  if (typeof value === "boolean" || value === null) {
    throwRange(field, "必须是正整数");
  }
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isInteger(n) || n <= 0) {
    throwRange(field, "必须是正整数");
  }
  return n;
}

function throwRange(field: string, msg: string): never {
  const err = new Error(`${field}: ${msg}`);
  (err as Error & { code?: string }).code = "INVALID_PARAM";
  throw err;
}

/**
 * 计算每帖承载的真实页数列表。
 * 除最后一帖外都填满到"不超过上限的最大 4 的倍数"；最后一帖取余数。
 */
export function signatureRealCounts(
  totalPages: number,
  maxSignaturePages: number,
): number[] {
  const full = maxSignaturePages - (maxSignaturePages % 4);
  const counts: number[] = [];
  let remaining = totalPages;
  while (remaining > full) {
    counts.push(full);
    remaining -= full;
  }
  counts.push(remaining);
  return counts;
}

/** 一帖总页位：真实页数向上取整到 4 的倍数 */
function padTo4(real: number): number {
  return Math.ceil(real / 4) * 4;
}

function makeSlot(localPos: number, realPages: number, base: number): PageSlot {
  if (localPos <= realPages) {
    return { kind: "real", page: base + localPos };
  }
  return { kind: "blank", label: `B${localPos - realPages}` };
}

function buildSignature(
  index: number,
  realPages: number,
  base: number,
  isLast: boolean,
): Signature {
  const size = padTo4(realPages);
  const sheetCount = size / 4;
  const sheets: Sheet[] = [];
  for (let k = 1; k <= sheetCount; k++) {
    const o = 2 * (k - 1);
    sheets.push({
      index: k,
      front: {
        left: makeSlot(size - o, realPages, base),
        right: makeSlot(o + 1, realPages, base),
      },
      back: {
        left: makeSlot(o + 2, realPages, base),
        right: makeSlot(size - o - 1, realPages, base),
      },
    });
  }
  return {
    index,
    size,
    realPages,
    blankPages: size - realPages,
    firstRealPage: realPages > 0 ? base + 1 : 0,
    lastRealPage: base + realPages,
    isLast,
    sheets,
  };
}

/**
 * 生成完整拼版计划。真实页码贯穿各帖连续编号；补白仅出现在最后一帖，
 * 且从文档末尾之后开始编号（B1, B2, ...），不占用真实页号。
 */
export function generatePlan(raw: {
  totalPages: unknown;
  maxSignaturePages: unknown;
  name?: unknown;
}): ImpositionPlan {
  const { totalPages, maxSignaturePages, name } = validateParams(raw);
  const counts = signatureRealCounts(totalPages, maxSignaturePages);
  const signatures: Signature[] = [];
  let base = 0;
  counts.forEach((realPages, i) => {
    const isLast = i === counts.length - 1;
    signatures.push(buildSignature(i + 1, realPages, base, isLast));
    base += realPages;
  });
  let blankCounter = 0;
  for (const sig of signatures) {
    for (const sheet of sig.sheets) {
      const slotOrder = [sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right];
      for (const slot of slotOrder) {
        if (slot.kind === "blank") slot.label = `B${++blankCounter}`;
      }
    }
  }
  return {
    totalPages,
    maxSignaturePages,
    name,
    totalSheets: signatures.reduce((s, x) => s + x.sheets.length, 0),
    totalBlankPages: signatures.reduce((s, x) => s + x.blankPages, 0),
    signatures,
  };
}



