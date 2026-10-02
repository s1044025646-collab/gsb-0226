import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  configureDbPath,
  getVersion,
  listVersions,
  parseLayout,
  savePlan,
} from "../dist/db/store.js";
import { generatePlan } from "../dist/core/imposition.js";
import { toCSV } from "../dist/core/format.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "booklet-"));
  configureDbPath(join(dir, "sub", "booklet.db"));
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("保存并在“重启”（重新打开同一数据库文件）后导出原计划", () => {
  const plan = generatePlan({ totalPages: 20, maxSignaturePages: 16, name: "doc20" });
  const ref = savePlan("doc20", plan);
  assert.equal(ref.version, 1);

  // 模拟服务重启：关闭连接、清空实例后用同一文件重新打开
  closeDb();
  configureDbPath(join(dir, "sub", "booklet.db"));

  const meta = getVersion("doc20");
  assert.ok(meta);
  const restored = parseLayout(meta!);
  assert.equal(restored.totalPages, 20);
  assert.equal(restored.signatures.length, 2);
  const csv = toCSV(restored);
  assert.ok(csv.includes("signature,sheet,side,left,right"));
  assert.equal(csv.trim().split(/\r?\n/).length, 1 + restored.totalSheets * 2);
});

test("更改参数生成新版本，旧版本保留且可独立查询", () => {
  savePlan("report", generatePlan({ totalPages: 8, maxSignaturePages: 8, name: "report" }));
  savePlan("report", generatePlan({ totalPages: 20, maxSignaturePages: 16, name: "report" }));
  const versions = listVersions("report");
  assert.equal(versions.length, 2);

  const v1 = getVersion("report", 1)!;
  const v2 = getVersion("report", 2)!;
  assert.equal(parseLayout(v1).totalPages, 8);
  assert.equal(parseLayout(v1).maxSignaturePages, 8);
  assert.equal(parseLayout(v2).totalPages, 20);
  assert.equal(parseLayout(v1).totalSheets, 2);
  assert.equal(parseLayout(v2).totalSheets, 5);
});

test("数据文件创建在项目内可配置目录", () => {
  assert.ok(existsSync(join(dir, "sub", "booklet.db")));
});


