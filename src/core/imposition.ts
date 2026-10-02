import type {
  Cell,
  ImpositionInput,
  ImpositionPlan,
  SheetLayout,
  SignatureLayout,
} from './types.js';
import { ValidationError } from './errors.js';

/**
 * 校验并规范化拼版参数。
 * @throws ValidationError
 */
export function validateInput(input: {
  pages: unknown;
  maxPagesPerSignature: unknown;
  name?: unknown;
}): ImpositionInput {
  const pages = Number(input.pages);
  const max = Number(input.maxPagesPerSignature);

  if (
    input.pages === undefined ||
    input.pages === null ||
    !Number.isInteger(pages) ||
    pages <= 0
  ) {
    throw new ValidationError(
      'PAGES_NOT_POSITIVE_INTEGER',
      `文档总页数必须是正整数，收到: ${String(input.pages)}`,
    );
  }
  if (
    input.maxPagesPerSignature === undefined ||
    input.maxPagesPerSignature === null ||
    !Number.isInteger(max) ||
    max <= 0
  ) {
    throw new ValidationError(
      'MAX_SIGNATURE_NOT_MULTIPLE_OF_FOUR',
      `每帖最大页数必须是 4 的正整数倍，收到: ${String(input.maxPagesPerSignature)}`,
    );
  }
  if (max % 4 !== 0) {
    throw new ValidationError(
      'MAX_SIGNATURE_NOT_MULTIPLE_OF_FOUR',
      `每帖最大页数必须是 4 的倍数，收到: ${max}`,
    );
  }
  if (typeof input.name !== 'undefined' && input.name !== null) {
    const name = String(input.name).trim();
    if (name.length === 0 || name.length > 100) {
      throw new ValidationError(
        'INVALID_NAME',
        '计划名称长度必须在 1 到 100 个字符之间',
      );
    }
  }
  return { pages, maxPagesPerSignature: max };
}

function roundUpToFour(n: number): number {
  return Math.ceil(n / 4) * 4;
}

/**
 * 计算每帖包含的真实页数。
 * 规则：除最后一帖外，每帖尽量放满 maxPagesPerSignature 页；
 * 最后一帖放余下页数并向上补齐到 4 的倍数（补后不检查上限，
 * 因为余数必然 < 上限）。
 */
export function splitRealPages(pages: number, max: number): number[] {
  const sigCount = Math.ceil(pages / max);
  const sizes: number[] = [];
  let remaining = pages;
  for (let i = 0; i < sigCount; i++) {
    const take = i === sigCount - 1 ? remaining : Math.min(max, remaining);
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

/**
 * 生成整本拼版计划。
 *
 * 帖内布局公式（帖补齐后页数 P = 2S，S 为纸张数，j 从外到内 1..S）：
 *   正面左 = P+1-2j，正面右 = 2j-1
 *   反面左 = 2j，    反面右 = P-2j+2
 * 位置值为该帖内的顺序位置（1..P）；补白占据帖末尾位置，
 * 真实页在帖内前置，不改变页码连续性。
 */
export function impose(raw: {
  pages: number;
  maxPagesPerSignature: number;
}): ImpositionPlan {
  const { pages, maxPagesPerSignature } = validateInput(raw);
  const realSizes = splitRealPages(pages, maxPagesPerSignature);

  const signatures: SignatureLayout[] = [];
  let pageCursor = 1;
  let blankCursor = 1;

  realSizes.forEach((realCount, idx) => {
    const padded = roundUpToFour(realCount);
    const sheetCount = padded / 4;
    const startPage = pageCursor;
    const endPage = pageCursor + realCount - 1;

    const cellAt = (position: number): Cell => {
      if (position <= realCount) {
        return { type: 'real', page: startPage + position - 1 };
      }
      return { type: 'blank', label: `B${blankCursor++}` };
    };

    const sheets: SheetLayout[] = [];
    for (let j = 1; j <= sheetCount; j++) {
      sheets.push({
        sheetIndex: j,
        front: {
          left: cellAt(padded + 1 - 2 * j),
          right: cellAt(2 * j - 1),
        },
        back: {
          left: cellAt(2 * j),
          right: cellAt(padded - 2 * j + 2),
        },
      });
    }

    signatures.push({
      signatureIndex: idx + 1,
      startPage,
      endPage: realCount === 0 ? startPage - 1 : endPage,
      realPages: realCount,
      paddedPages: padded,
      sheetCount,
      sheets,
    });
    pageCursor += realCount;
  });

  const stats = {
    signatureCount: signatures.length,
    sheetCount: signatures.reduce((sum, s) => sum + s.sheetCount, 0),
    realPageCount: pages,
    blankCount:
      signatures.reduce((sum, s) => sum + s.paddedPages, 0) - pages,
  };

  return { pages, maxPagesPerSignature, signatures, stats };
}
