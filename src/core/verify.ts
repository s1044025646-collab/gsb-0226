import { impose } from './imposition.js';
import { validateInput } from './imposition.js';
import type {
  Cell,
  ExternalCell,
  ExternalPlan,
  ImpositionPlan,
  ValidationIssue,
  VerificationResult,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseCell(value: ExternalCell): Cell {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`非法真实页号: ${String(value)}`);
    }
    return { type: 'real', page: value };
  }
  if (typeof value === 'string') {
    const match = /^B(\d+)$/.exec(value.trim());
    if (!match) throw new Error(`非法补白标记: ${value}（应为 B1、B2 …）`);
    return { type: 'blank', label: `B${Number(match[1])}` };
  }
  throw new Error(`非法页位值: ${String(value)}`);
}

function issue(
  code: ValidationIssue['code'],
  message: string,
  location?: string,
  expected?: string,
  actual?: string,
): ValidationIssue {
  return { code, message, location, expected, actual };
}

const fmtCell = (cell: Cell): string =>
  cell.type === 'real' ? String(cell.page) : cell.label;

const loc = (
  sig: number,
  sheet: number,
  side: string,
  slot: string,
): string => `第${sig}帖/第${sheet}张/${side}/${slot}`;

/**
 * 核验外部页序计划。
 *
 * 检查项：
 * 1. 每个真实页 1..N 恰好出现一次（漏页、重页、越界均报错）；
 * 2. 补白数量与预期一致且标记不重复；
 * 3. 纸张数 / 帖划分与参数一致（提供 maxPagesPerSignature 时严格比对）；
 * 4. 每一张纸的正反左右页位满足对折规则：
 *    front.left + front.right = P+1，back.left + back.right = P+1，
 *    front.right + 1 = back.left，以及跨张连续关系；
 *    等价做法：把外部布局重建成“帖内位置序列”，与规范布局逐槽比对。
 */
export function verify(external: ExternalPlan): VerificationResult {
  const issues: ValidationIssue[] = [];

  let params: { pages: number; maxPagesPerSignature: number };
  try {
    // 先验证 pages；帖上限缺省时由外部帖大小推断
    const pagesOk = validateInput({ pages: external.pages, maxPagesPerSignature: 4 });
    // 基本结构检查
    for (const sh of external.sheets ?? []) {
      if (!Number.isInteger(sh.signatureIndex) || sh.signatureIndex < 1) {
        throw new Error('signatureIndex 必须是从 1 开始的整数');
      }
      if (!Number.isInteger(sh.sheetIndex) || sh.sheetIndex < 1) {
        throw new Error(`第 ${sh.signatureIndex} 帖的 sheetIndex 非法`);
      }
    }
    if (external.maxPagesPerSignature !== undefined) {
      params = validateInput({
        pages: pagesOk.pages,
        maxPagesPerSignature: external.maxPagesPerSignature,
      });
    } else {
      // 推断：每帖纸张数 = 该帖最大 sheetIndex，帖大小 = 纸张数 * 4
      const sizeBySig = new Map<number, number>();
      for (const sh of external.sheets) {
        sizeBySig.set(
          sh.signatureIndex,
          Math.max(sizeBySig.get(sh.signatureIndex) ?? 0, sh.sheetIndex),
        );
      }
      const inferred = Math.max(4, ...[...sizeBySig.values()].map((s) => s * 4));
      params = { pages: pagesOk.pages, maxPagesPerSignature: inferred };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(issue('INVALID_STRUCTURE', message));
    return { valid: false, issues, checkedAt: nowIso() };
  }

  if (!external.sheets || external.sheets.length === 0) {
    issues.push(issue('EMPTY_PLAN', '计划中没有任何纸张'));
    return { valid: false, issues, checkedAt: nowIso() };
  }

  // 解析全部页位，收集真实页与补白
  const seenPages = new Map<number, string>();
  const seenBlanks = new Map<string, string>();
  let parsed: {
    sig: number;
    sheet: number;
    cells: { fl: Cell; fr: Cell; bl: Cell; br: Cell };
  }[] = [];

  for (const sh of external.sheets) {
    const here = `第${sh.signatureIndex}帖/第${sh.sheetIndex}张`;
    let fl: Cell, fr: Cell, bl: Cell, br: Cell;
    try {
      fl = parseCell(sh.front.left);
      fr = parseCell(sh.front.right);
      bl = parseCell(sh.back.left);
      br = parseCell(sh.back.right);
    } catch (error) {
      issues.push(
        issue('BAD_CELL', error instanceof Error ? error.message : String(error), here),
      );
      continue;
    }
    const entries: [Cell, string][] = [
      [fl, `${here}/正面/左`],
      [fr, `${here}/正面/右`],
      [bl, `${here}/反面/左`],
      [br, `${here}/反面/右`],
    ];
    for (const [cell, where] of entries) {
      if (cell.type === 'real') {
        const prev = seenPages.get(cell.page);
        if (prev) {
          issues.push(
            issue(
              'DUPLICATE_PAGE',
              `真实页 ${cell.page} 重复出现`,
              where,
              '每页恰好一次',
              `同时出现于 ${prev}`,
            ),
          );
        } else {
          seenPages.set(cell.page, where);
        }
      } else {
        const prev = seenBlanks.get(cell.label);
        if (prev) {
          issues.push(
            issue(
              'DUPLICATE_BLANK_LABEL',
              `补白标记 ${cell.label} 重复`,
              where,
              '补白标记唯一',
              `同时出现于 ${prev}`,
            ),
          );
        } else {
          seenBlanks.set(cell.label, where);
        }
      }
    }
    parsed.push({ sig: sh.signatureIndex, sheet: sh.sheetIndex, cells: { fl, fr, bl, br } });
  }

  const { pages: n } = params;

  // 越界与漏页
  for (const [page, where] of seenPages) {
    if (page > n) {
      issues.push(
        issue('PAGE_OUT_OF_RANGE', `真实页 ${page} 超出总页数 ${n}`, where, `1..${n}`, String(page)),
      );
    }
  }
  for (let p = 1; p <= n; p++) {
    if (!seenPages.has(p)) {
      issues.push(issue('MISSING_PAGE', `缺少真实页 ${p}`));
    }
  }

  // 规范计划（用于数量与逐槽比对）
  const expected = impose(params);

  if (seenBlanks.size !== expected.stats.blankCount) {
    issues.push(
      issue(
        'BLANK_COUNT_MISMATCH',
        `补白数量不符`,
        undefined,
        `${expected.stats.blankCount} 个`,
        `${seenBlanks.size} 个`,
      ),
    );
  }
  if (external.sheets.length !== expected.stats.sheetCount) {
    issues.push(
      issue(
        'SHEET_COUNT_MISMATCH',
        '纸张总数不符',
        undefined,
        `${expected.stats.sheetCount} 张`,
        `${external.sheets.length} 张`,
      ),
    );
  }

  // 按帖分组，逐槽比对页位关系
  const groups = new Map<number, Map<number, (typeof parsed)[number]['cells']>>();
  for (const item of parsed) {
    let map = groups.get(item.sig);
    if (!map) {
      map = new Map();
      groups.set(item.sig, map);
    }
    map.set(item.sheet, item.cells);
  }

  compareSignatures(groups, expected, issues);

  return { valid: issues.length === 0, issues, checkedAt: nowIso() };
}

function compareSignatures(
  groups: Map<number, Map<number, Cell4>>,
  expected: ImpositionPlan,
  issues: ValidationIssue[],
): void {
  if (groups.size !== expected.signatures.length) {
    issues.push(
      issue(
        'SIGNATURE_SIZE_INVALID',
        '帖数不符',
        undefined,
        `${expected.signatures.length} 帖`,
        `${groups.size} 帖`,
      ),
    );
  }

  for (const sig of expected.signatures) {
    const actual = groups.get(sig.signatureIndex);
    if (!actual) {
      issues.push(issue('SIGNATURE_SIZE_INVALID', `缺少第 ${sig.signatureIndex} 帖`));
      continue;
    }
    if (actual.size !== sig.sheetCount) {
      issues.push(
        issue(
          'SHEET_COUNT_MISMATCH',
          `第 ${sig.signatureIndex} 帖纸张数不符`,
          `第${sig.signatureIndex}帖`,
          `${sig.sheetCount} 张`,
          `${actual.size} 张`,
        ),
      );
    }
    for (const sheet of sig.sheets) {
      const got = actual.get(sheet.sheetIndex);
      if (!got) {
        issues.push(
          issue('SHEET_COUNT_MISMATCH', `缺少第 ${sig.signatureIndex} 帖第 ${sheet.sheetIndex} 张`),
        );
        continue;
      }
      const pairs: [Cell, Cell, string, string][] = [
        [got.fl, sheet.front.left, '正面', '左'],
        [got.fr, sheet.front.right, '正面', '右'],
        [got.bl, sheet.back.left, '反面', '左'],
        [got.br, sheet.back.right, '反面', '右'],
      ];
      for (const [gotCell, wantCell, side, slot] of pairs) {
        const want = fmtCell(wantCell);
        const gotText = fmtCell(gotCell);
        if (want !== gotText) {
          issues.push(
            issue(
              'SLOT_MISMATCH',
              `正反页位关系错误：该位置应为 ${want}`,
              loc(sig.signatureIndex, sheet.sheetIndex, side, slot),
              want,
              gotText,
            ),
          );
        }
      }
    }
  }

  for (const sigIndex of groups.keys()) {
    if (!expected.signatures.some((s) => s.signatureIndex === sigIndex)) {
      issues.push(
        issue('SIGNATURE_SIZE_INVALID', `存在多余的第 ${sigIndex} 帖`, `第${sigIndex}帖`),
      );
    }
  }
}

type Cell4 = {
  fl: Cell;
  fr: Cell;
  bl: Cell;
  br: Cell;
};
