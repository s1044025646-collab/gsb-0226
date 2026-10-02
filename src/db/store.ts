import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ExternalPlan,
  ImpositionPlan,
  VerificationResult,
} from '../core/types.js';

export interface PlanRecord {
  id: number;
  name: string;
  created_at: string;
}

export interface VersionRecord {
  id: number;
  plan_id: number;
  version: number;
  pages: number;
  max_pages_per_signature: number;
  plan_json: string;
  created_at: string;
}

export interface VerificationRecord {
  id: number;
  plan_id: number | null;
  version_id: number | null;
  input_json: string;
  result_json: string;
  valid: number;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        pages INTEGER NOT NULL,
        max_pages_per_signature INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (plan_id, version)
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
        version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        valid INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_versions_plan ON versions(plan_id);
      CREATE INDEX IF NOT EXISTS idx_verif_plan ON verifications(plan_id);
    `);
  }

  createPlan(name: string): PlanRecord {
    const stmt = this.db.prepare('INSERT INTO plans (name) VALUES (?) RETURNING *');
    return stmt.get(name) as PlanRecord;
  }

  getPlanByName(name: string): PlanRecord | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE name = ?').get(name) as
      | PlanRecord
      | undefined;
  }

  getPlanById(id: number): PlanRecord | undefined {
    return this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as
      | PlanRecord
      | undefined;
  }

  listPlans(): PlanRecord[] {
    return this.db.prepare('SELECT * FROM plans ORDER BY id').all() as PlanRecord[];
  }

  addVersion(planId: number, plan: ImpositionPlan): VersionRecord {
    const nextRow = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM versions WHERE plan_id = ?')
      .get(planId) as { v: number };
    const version = nextRow.v;
    return this.db
      .prepare(
        `INSERT INTO versions (plan_id, version, pages, max_pages_per_signature, plan_json)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        planId,
        version,
        plan.pages,
        plan.maxPagesPerSignature,
        JSON.stringify(plan),
      ) as VersionRecord;
  }

  getVersion(planId: number, version: number): VersionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM versions WHERE plan_id = ? AND version = ?')
      .get(planId, version) as VersionRecord | undefined;
  }

  latestVersion(planId: number): VersionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM versions WHERE plan_id = ? ORDER BY version DESC LIMIT 1')
      .get(planId) as VersionRecord | undefined;
  }

  listVersions(planId: number): VersionRecord[] {
    return this.db
      .prepare(
        'SELECT id, plan_id, version, pages, max_pages_per_signature, created_at FROM versions WHERE plan_id = ? ORDER BY version',
      )
      .all(planId) as VersionRecord[];
  }

  addVerification(
    input: ExternalPlan,
    result: VerificationResult,
    refs: { planId?: number; versionId?: number } = {},
  ): VerificationRecord {
    return this.db
      .prepare(
        `INSERT INTO verifications (plan_id, version_id, input_json, result_json, valid)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        refs.planId ?? null,
        refs.versionId ?? null,
        JSON.stringify(input),
        JSON.stringify(result),
        result.valid ? 1 : 0,
      ) as VerificationRecord;
  }

  listVerifications(planId?: number): VerificationRecord[] {
    if (planId === undefined) {
      return this.db
        .prepare('SELECT * FROM verifications ORDER BY id')
        .all() as VerificationRecord[];
    }
    return this.db
      .prepare('SELECT * FROM verifications WHERE plan_id = ? ORDER BY id')
      .all(planId) as VerificationRecord[];
  }

  close(): void {
    this.db.close();
  }
}

/** 解析版本记录中的完整拼版计划 */
export function parsePlanVersion(record: VersionRecord): ImpositionPlan {
  return JSON.parse(record.plan_json) as ImpositionPlan;
}
