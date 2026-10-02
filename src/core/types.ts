/**
 * 小册子拼版核心数据结构。
 *
 * 约定：
 * - 左侧装订，每面两页，对折成册。
 * - 每帖（signature）页数必须是 4 的倍数。
 * - 每张纸有正面（front）与反面（back），各含左（left）、右（right）两个页位。
 * - 页码方向均为“正向观看纸面”时的左右位置。
 */

export type CellType = 'real' | 'blank';

export interface RealCell {
  type: 'real';
  /** 真实页码，从 1 开始贯穿全册连续编号 */
  page: number;
}

export interface BlankCell {
  type: 'blank';
  /** 补白的独立标记，全册唯一（如 B1、B2），不占用真实页号 */
  label: string;
}

export type Cell = RealCell | BlankCell;

export interface SideLayout {
  left: Cell;
  right: Cell;
}

export interface SheetLayout {
  /** 帖内纸张序号，从 1 开始；纸张按由外到内排列 */
  sheetIndex: number;
  front: SideLayout;
  back: SideLayout;
}

export interface SignatureLayout {
  /** 帖序号，从 1 开始 */
  signatureIndex: number;
  /** 该帖第一页对应的真实页号（含推断） */
  startPage: number;
  /** 该帖最后一个真实页号；帖全补白时等于 startPage - 1 */
  endPage: number;
  /** 该帖包含的真实页数 */
  realPages: number;
  /** 补齐后该帖总页数（4 的倍数） */
  paddedPages: number;
  /** 该帖纸张数 = paddedPages / 4 */
  sheetCount: number;
  sheets: SheetLayout[];
}

export interface PlanStats {
  signatureCount: number;
  sheetCount: number;
  realPageCount: number;
  blankCount: number;
}

export interface ImpositionInput {
  pages: number;
 maxPagesPerSignature: number;
}

export interface ImpositionPlan extends ImpositionInput {
  signatures: SignatureLayout[];
  stats: PlanStats;
}

export type IssueCode =
  | 'PAGES_NOT_POSITIVE_INTEGER'
  | 'MAX_SIGNATURE_NOT_MULTIPLE_OF_FOUR'
  | 'MISSING_PAGE'
  | 'DUPLICATE_PAGE'
  | 'PAGE_OUT_OF_RANGE'
  | 'BLANK_COUNT_MISMATCH'
  | 'DUPLICATE_BLANK_LABEL'
  | 'SHEET_COUNT_MISMATCH'
  | 'SIGNATURE_SIZE_INVALID'
  | 'SLOT_MISMATCH'
  | 'EMPTY_PLAN'
  | 'BAD_CELL'
  | 'INVALID_STRUCTURE';

export interface ValidationIssue {
  code: IssueCode;
  message: string;
  /** 出错位置（帖、纸、面、左右），可缺省 */
  location?: string;
  expected?: string;
  actual?: string;
}

export interface VerificationResult {
  valid: boolean;
  issues: ValidationIssue[];
  checkedAt: string;
}

/** 外部传入的单个页位：整数 = 真实页；字符串 Bn = 补白 */
export type ExternalCell = number | string;

export interface ExternalSheet {
  signatureIndex: number;
  sheetIndex: number;
  front: { left: ExternalCell; right: ExternalCell };
  back: { left: ExternalCell; right: ExternalCell };
}

export interface ExternalPlan {
  pages: number;
  /** 可选：传入则连帖划分与每帖布局一并严格核验 */
  maxPagesPerSignature?: number;
  sheets: ExternalSheet[];
}
