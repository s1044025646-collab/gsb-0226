import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generatePlan,
  signatureRealCounts,
  validateParams,
  type ImpositionPlan,
  type PageSlot,
} from "../dist/core/imposition.js";
import { verifyPlan } from "../dist/core/verify.js";
import { toCSV } from "../dist/core/format.js";

function key(slot: PageSlot): string {
  return slot.kind === "real" ? String(slot.page) : slot.label;
}

test("手写布局：4 页一帖（基准的最小情形）", () => {
  const plan = generatePlan({ totalPages: 4, maxSignaturePages: 4, name: "t" });
  assert.equal(plan.signatures.length, 1);
  assert.equal(plan.totalSheets, 1);
  assert.equal(plan.totalBlankPages, 0);
  const sh = plan.signatures[0].sheets[0];
  assert.equal(key(sh.front.left), "4");
  assert.equal(key(sh.front.right), "1");
  assert.equal(key(sh.back.left), "2");
  assert.equal(key(sh.back.right), "3");
});

test("手写布局：8 页一帖符合题给基准 8/1 2/7 6/3 4/5", () => {
  const plan = generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "t" });
  const [outer, inner] = plan.signatures[0].sheets;
  assert.equal(key(outer.front.left), "8");
  assert.equal(key(outer.front.right), "1");
  assert.equal(key(outer.back.left), "2");
  assert.equal(key(outer.back.right), "7");
  assert.equal(key(inner.front.left), "6");
  assert.equal(key(inner.front.right), "3");
  assert.equal(key(inner.back.left), "4");
  assert.equal(key(inner.back.right), "5");
});

test("6 页补成 8 页：补白在外层，真实页 1..6 各一次", () => {
  const plan = generatePlan({ totalPages: 6, maxSignaturePages: 16, name: "t" });
  assert.equal(plan.signatures[0].size, 8);
  assert.equal(plan.totalBlankPages, 2);
  const outer = plan.signatures[0].sheets[0];
  assert.equal(outer.front.left.kind, "blank");
  assert.equal(key(outer.front.left), "B1");
  assert.equal(key(outer.front.right), "1");
  assert.equal(key(outer.back.left), "2");
  assert.equal(outer.back.right.kind, "blank");
  assert.equal(key(outer.back.right), "B2");
  const reals = collectReals(plan).sort((a, b) => a - b);
  assert.deepEqual(reals, [1, 2, 3, 4, 5, 6]);
});

test("末帖处理：20 页/上限16 => 16 + 4 两帖，页码贯穿，无补白", () => {
  const plan = generatePlan({ totalPages: 20, maxSignaturePages: 16, name: "t" });
  assert.deepEqual(signatureRealCounts(20, 16), [16, 4]);
  assert.equal(plan.signatures.length, 2);
  assert.equal(plan.signatures[0].sheets.length, 4);
  assert.equal(plan.signatures[1].sheets.length, 1);
  assert.equal(plan.signatures[1].firstRealPage, 17);
  assert.equal(plan.signatures[1].lastRealPage, 20);
  const sh = plan.signatures[1].sheets[0];
  assert.equal(key(sh.front.left), "20");
  assert.equal(key(sh.front.right), "17");
  assert.equal(key(sh.back.left), "18");
  assert.equal(key(sh.back.right), "19");
  assert.deepEqual([...collectReals(plan)].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("末帖补白：18 页/上限16 => 16 + 2 真实，末帖补 2 页", () => {
  const plan = generatePlan({ totalPages: 18, maxSignaturePages: 16, name: "t" });
  assert.equal(plan.signatures[1].realPages, 2);
  assert.equal(plan.signatures[1].blankPages, 2);
  assert.equal(plan.signatures[1].size, 4);
  assert.equal(plan.totalBlankPages, 2);
  const sh = plan.signatures[1].sheets[0];
  assert.equal(sh.front.left.kind, "blank");
  assert.equal(key(sh.front.right), "17");
  assert.equal(key(sh.back.left), "18");
  assert.equal(sh.back.right.kind, "blank");
});

test("每帖上限边界：上限非 4 的倍数时向下取整到 12（20 页 -> 12+8）", () => {
  const plan = generatePlan({ totalPages: 20, maxSignaturePages: 14, name: "t" });
  assert.deepEqual(
    plan.signatures.map((s) => s.size),
    [12, 8],
  );
  assert.equal(plan.totalSheets, 5);
});

test("参数非法：零页 / 负数 / 非整数 抛出 INVALID_PARAM", () => {
  for (const bad of [0, -1, 1.5, NaN, "abc"]) {
    assert.throws(
      () => validateParams({ totalPages: bad, maxSignaturePages: 8 }),
      (e: Error & { code?: string }) => e.code === "INVALID_PARAM",
    );
  }
  for (const bad of [0, 2, 3, -4]) {
    assert.throws(
      () => validateParams({ totalPages: 8, maxSignaturePages: bad }),
      (e: Error & { code?: string }) => e.code === "INVALID_PARAM",
    );
  }
});

test("核验：合法计划通过", () => {
  const plan = generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "t" });
  const r = verifyPlan(plan);
  assert.equal(r.valid, true);
  assert.equal(r.issues.length, 0);
});

test("核验：漏页 + 重页被拒绝（页码集合不完整）", () => {
  const plan = generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "t" }) as any;
  const slot = plan.signatures[0].sheets[0].back.right; // 原为 7
  slot.page = 2; // 与背面左页 2 重复，导致 7 缺失
  const r = verifyPlan(plan);
  assert.equal(r.valid, false);
  assert.deepEqual(r.missingPages, [7]);
  assert.deepEqual(r.duplicatePages, [2]);
  assert.ok(r.issues.some((i) => i.code === "MISSING_PAGE"));
  assert.ok(r.issues.some((i) => i.code === "DUPLICATE_PAGE"));
  assert.ok(r.issues.some((i) => i.code === "POSITION_MISMATCH"));
});

test("核验：交换两页，数量与页码总和都不变，仍被拒绝", () => {
  const plan = generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "t" });
  const sumBefore = collectReals(plan).reduce((a, b) => a + b, 0);
  const bad = JSON.parse(JSON.stringify(plan));
  const a = bad.signatures[0].sheets[0].front.left;
  bad.signatures[0].sheets[0].front.left = bad.signatures[0].sheets[0].front.right;
  bad.signatures[0].sheets[0].front.right = a;
  const sumAfter = collectReals(bad as ImpositionPlan).reduce((x, y) => x + y, 0);
  assert.equal(sumBefore, sumAfter, "交换后页码总和必须保持一致，以证明总和校验不可靠");
  const r = verifyPlan(bad);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === "POSITION_MISMATCH"));
});

test("核验：补白数量错误被拒绝", () => {
  const plan = generatePlan({ totalPages: 6, maxSignaturePages: 16, name: "t" }) as any;
  plan.signatures[0].sheets[0].front.left = { kind: "real", page: 99 };
  const r = verifyPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === "BLANK_COUNT"));
  assert.ok(r.issues.some((i) => i.code === "OUT_OF_RANGE"));
});

test("核验：纸张数量不足被拒绝", () => {
  const plan = generatePlan({ totalPages: 16, maxSignaturePages: 16, name: "t" }) as any;
  plan.signatures[0].sheets.pop();
  const r = verifyPlan(plan);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.code === "SHEET_COUNT" || i.code === "MISSING_PAGE"));
});

test("核验：参数非法时返回 INVALID_PARAM 问题", () => {
  const r = verifyPlan({ totalPages: 0, maxSignaturePages: 8, signatures: [] });
  assert.equal(r.valid, false);
  assert.ok(r.issues[0]?.code === "INVALID_PARAM");
});

test("CSV 导出行数 = 每面一行 + 表头", () => {
  const plan = generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "t" });
  const csv = toCSV(plan).trim().split(/\r?\n/);
  assert.equal(csv.length, 1 + plan.totalSheets * 2);
  assert.equal(csv[0], "signature,sheet,side,left,right");
});

function collectReals(plan: ImpositionPlan): number[] {
  const out: number[] = [];
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      for (const side of [sheet.front, sheet.back]) {
        for (const pos of [side.left, side.right]) {
          if (pos.kind === "real") out.push(pos.page);
        }
      }
    }
  }
  return out;
}


