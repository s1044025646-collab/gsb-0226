import { impose } from './core/imposition.js';
import { verify } from './core/verify.js';
import { ValidationError, NotFoundError } from './core/errors.js';
import { Store, parsePlanVersion } from './db/store.js';
import type { ExternalPlan, ImpositionPlan } from './core/types.js';

export class PlanService {
  constructor(private readonly store: Store) {}

  createPlan(
    name: string,
    pages: number,
    maxPagesPerSignature: number,
  ): { planId: number; version: number; plan: ImpositionPlan } {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
      throw new ValidationError('INVALID_NAME', '计划名称不能为空');
    }
    if (this.store.getPlanByName(trimmed)) {
      throw new ValidationError('INVALID_NAME', `计划名称已存在: ${trimmed}`);
    }
    const plan = impose({ pages, maxPagesPerSignature });
    const record = this.store.createPlan(trimmed);
    const versionRecord = this.store.addVersion(record.id, plan);
    return { planId: record.id, version: versionRecord.version, plan };
  }

 recalculate(
    planId: number,
    pages: number,
    maxPagesPerSignature: number,
  ): { version: number; plan: ImpositionPlan } {
    this.requirePlan(planId);
    const plan = impose({ pages, maxPagesPerSignature });
    const versionRecord = this.store.addVersion(planId, plan);
    return { version: versionRecord.version, plan };
  }

  getVersion(planId: number, version?: number): { version: number; plan: ImpositionPlan } {
    this.requirePlan(planId);
    const record =
      version === undefined
        ? this.store.latestVersion(planId)
        : this.store.getVersion(planId, version);
    if (!record) {
      throw new NotFoundError(`计划 ${planId} 不存在版本 ${version}`);
    }
    return { version: record.version, plan: parsePlanVersion(record) };
  }

  listVersions(planId: number) {
    this.requirePlan(planId);
    return this.store.listVersions(planId);
  }

  listPlans() {
    return this.store.listPlans();
  }

  verifyExternal(
    input: ExternalPlan,
    refs: { planId?: number; versionId?: number } = {},
  ) {
    const result = verify(input);
    const record = this.store.addVerification(input, result, refs);
    return { id: record.id, result };
  }

  listVerifications(planId?: number) {
    if (planId !== undefined) this.requirePlan(planId);
    return this.store.listVerifications(planId);
  }

  private requirePlan(planId: number) {
    if (!this.store.getPlanById(planId)) {
      throw new NotFoundError(`计划不存在: ${planId}`);
    }
  }
}
