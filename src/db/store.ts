/**
 * SQLite 持久化层（Node 内置 node:sqlite，无需安装/编译第三方原生模块）。
 *
 * 存储内容：
 *  - plans：计划（按名称分组）及其最新版本号、原始参数。
 *  - versions：每次生成的不可变版本（参数 + 完整布局 JSON）。更改参数产生新版本，
 *    旧版本保留并可独立查询。
 *  - sheets：每张纸的布局（便于逐张查询与外部核对）。
 *  - verifications：对任意版本或外部输入的核验结果。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ImpositionPlan } from "../core/imposition.js";
import type { VerificationResult } from "../core/verify.js";

let dbInstance: DatabaseSync | null = null;
let dbPath = "data/booklet.db";

export function configureDbPath(path: string): void {
  dbPath = path;
}

export function getDbPath(): string {
  return dbPath;
}

export function openDb(path: string = dbPath): DatabaseSync {
  if (dbInstance) return dbInstance;
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  dbPath = path;
  dbInstance = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL,
      max_signature_pages INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      total_pages INTEGER NOT NULL,
      max_signature_pages INTEGER NOT NULL,
      total_sheets INTEGER NOT NULL,
      total_blank_pages INTEGER NOT NULL,
      layout_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(plan_id, version)
    );

    CREATE TABLE IF NOT EXISTS sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      signature_index INTEGER NOT NULL,
      sheet_index INTEGER NOT NULL,
      side TEXT NOT NULL,
      slot TEXT NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
      version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      valid INTEGER NOT NULL,
      total_pages INTEGER,
      expected_sheets INTEGER,
      actual_sheets INTEGER,
      expected_blank_pages INTEGER,
      actual_blank_pages INTEGER,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_versions_plan ON versions(plan_id);
    CREATE INDEX IF NOT EXISTS idx_sheets_version ON sheets(version_id);
  `);
}

export interface StoredRef {
  planId: number;
  versionId: number;
  version: number;
}

/** 保存（或按新参数追加版本）。返回计划与版本引用。 */
export function savePlan(name: string, plan: ImpositionPlan): StoredRef {
  const db = openDb();
  const insertPlan = db.prepare(
    `INSERT INTO plans (name, current_version, total_pages, max_signature_pages)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       current_version = current_version + 1,
       total_pages = excluded.total_pages,
       max_signature_pages = excluded.max_signature_pages,
       updated_at = datetime('now')`,
  );
  insertPlan.run(name, plan.totalPages, plan.maxSignaturePages);

  const planRow = db.prepare("SELECT id, current_version FROM plans WHERE name = ?").get(name) as
    | { id: number; current_version: number }
    | undefined;
  if (!planRow) throw new Error("保存计划失败");
  const version = planRow.current_version;

  const insertVersion = db.prepare(
    `INSERT INTO versions (plan_id, version, total_pages, max_signature_pages,
        total_sheets, total_blank_pages, layout_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = insertVersion.run(
    planRow.id,
    version,
    plan.totalPages,
    plan.maxSignaturePages,
    plan.totalSheets,
    plan.totalBlankPages,
    JSON.stringify(plan),
  );
  const versionId = Number(info.lastInsertRowid);

  const insertSheet = db.prepare(
    `INSERT INTO sheets (version_id, signature_index, sheet_index, side, slot, value)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      insertSheet.run(versionId, sig.index, sheet.index, "front", "left", slotValue(sheet.front.left));
      insertSheet.run(versionId, sig.index, sheet.index, "front", "right", slotValue(sheet.front.right));
      insertSheet.run(versionId, sig.index, sheet.index, "back", "left", slotValue(sheet.back.left));
      insertSheet.run(versionId, sig.index, sheet.index, "back", "right", slotValue(sheet.back.right));
    }
  }
  return { planId: planRow.id, versionId, version };
}

function slotValue(slot: { kind: string; page?: number; label?: string }): string {
  return slot.kind === "real" ? `P${slot.page}` : `blank:${slot.label}`;
}

export interface PlanSummary {
  id: number;
  name: string;
  current_version: number;
  total_pages: number;
  max_signature_pages: number;
  created_at: string;
  updated_at: string;
}

export function listPlans(): PlanSummary[] {
  const db = openDb();
  return db.prepare("SELECT * FROM plans ORDER BY id").all() as unknown as PlanSummary[];
}

export interface VersionMeta {
  id: number;
  plan_id: number;
  version: number;
  total_pages: number;
  max_signature_pages: number;
  total_sheets: number;
  total_blank_pages: number;
  layout_json: string;
  created_at: string;
}

export function getPlanByName(name: string): PlanSummary | undefined {
  return openDb().prepare("SELECT * FROM plans WHERE name = ?").get(name) as unknown as PlanSummary | undefined;
}

export function listVersions(name: string): VersionMeta[] {
  const db = openDb();
  return db
    .prepare(
      `SELECT v.* FROM versions v JOIN plans p ON p.id = v.plan_id
       WHERE p.name = ? ORDER BY v.version`,
    )
    .all(name) as unknown as VersionMeta[];
}

export function getVersion(name: string, version?: number): VersionMeta | undefined {
  const db = openDb();
  if (version === undefined) {
    const row = db
      .prepare(
        `SELECT v.* FROM versions v JOIN plans p ON p.id = v.plan_id
         WHERE p.name = ? ORDER BY v.version DESC LIMIT 1`,
      )
      .get(name) as unknown as VersionMeta | undefined;
    return row;
  }
  return db
    .prepare(
      `SELECT v.* FROM versions v JOIN plans p ON p.id = v.plan_id
       WHERE p.name = ? AND v.version = ?`,
    )
    .get(name, version) as unknown as VersionMeta | undefined;
}

export function parseLayout(meta: VersionMeta): ImpositionPlan {
  return JSON.parse(meta.layout_json) as ImpositionPlan;
}

export interface SheetRow {
  signature_index: number;
  sheet_index: number;
  side: string;
  slot: string;
  value: string;
}

export function getSheets(versionId: number, signature?: number): SheetRow[] {
  const db = openDb();
  if (signature === undefined) {
    return db
      .prepare("SELECT * FROM sheets WHERE version_id = ? ORDER BY signature_index, sheet_index, side")
      .all(versionId) as unknown as SheetRow[];
  }
  return db
    .prepare(
      `SELECT * FROM sheets WHERE version_id = ? AND signature_index = ?
       ORDER BY sheet_index, side`,
    )
    .all(versionId, signature) as unknown as SheetRow[];
}

export function saveVerification(
  ref: { planId?: number; versionId?: number },
  source: string,
  result: VerificationResult,
): number {
  const db = openDb();
  const info = db
    .prepare(
      `INSERT INTO verifications (plan_id, version_id, source, valid, total_pages,
         expected_sheets, actual_sheets, expected_blank_pages, actual_blank_pages, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ref.planId ?? null,
      ref.versionId ?? null,
      source,
      result.valid ? 1 : 0,
      result.totalPages,
      result.expectedSheets,
      result.actualSheets,
      result.expectedBlankPages,
      result.actualBlankPages,
      JSON.stringify(result),
    );
  return Number(info.lastInsertRowid);
}

export function closeDb(): void {
  dbInstance?.close();
  dbInstance = null;
}

