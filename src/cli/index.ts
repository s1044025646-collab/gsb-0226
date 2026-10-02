/**
 * 命令行入口。
 *
 * 用法：
 *  booklet generate --name 名 --pages 20 [--max 16] [--format json|csv|table]
 *  booklet list
 *  booklet show --name 名 [--version N] [--signature I | --sheet N] [--format ...]
 *  booklet versions --name 名
 *  booklet export --name 名 [--version N] [--format json|csv|table]
 *  booklet recalculate --name 名 --pages 20 [--max 8]
 *  booklet verify --file plan.json
 *  booklet serve [--port 0] [--host 127.0.0.1] [--db data/booklet.db]
 *  booklet demo
 */
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { configureDbPath, closeDb } from "../db/store.js";
import { generatePlan } from "../core/imposition.js";
import { verifyPlan } from "../core/verify.js";
import { flatten, signatureSummary, slotText, toCSV, toTable } from "../core/format.js";
import {
  getPlanByName,
  getSheets,
  getVersion,
  listPlans,
  listVersions,
  parseLayout,
  savePlan,
  saveVerification,
} from "../db/store.js";
import { createApp, listen } from "../api/server.js";

interface Args {
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function fail(code: string, message: string): never {
  process.stderr.write(`错误 [${code}]: ${message}\n`);
  process.exit(1);
}

function pickFormat(flags: Record<string, string>): "json" | "csv" | "table" {
  const f = (flags.format ?? "table").toLowerCase();
  if (f !== "json" && f !== "csv" && f !== "table") {
    fail("INVALID_PARAM", `不支持的格式 ${f}（json|csv|table）`);
  }
  return f;
}

function outputPlan(plan: ReturnType<typeof generatePlan>, format: "json" | "csv" | "table"): void {
  if (format === "json") process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  else if (format === "csv") process.stdout.write(toCSV(plan));
  else process.stdout.write(toTable(plan) + "\n");
}

/** 在指定主机上找一个空闲 TCP 端口（传 0 由系统分配）。 */
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function cmdServe(flags: Record<string, string>): Promise<void> {
  configureDbPath(flags.db ?? "data/booklet.db");
  const host = flags.host ?? "127.0.0.1";
  let port = flags.port ? Number(flags.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail("INVALID_PARAM", "port 必须是 0-65535 的整数（0 表示自动选择空闲端口）");
  }
  if (port === 0) port = await findFreePort(host);
  const server = createApp();
  const actual = await listen(server, port, host);
  process.stdout.write(`小册子拼版服务已启动: http://${host}:${actual}\n`);
  process.stdout.write("按 Ctrl+C 停止。\n");
  const shutdown = () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdGenerate(flags: Record<string, string>): void {
  const name = flags.name;
  if (!name) fail("INVALID_PARAM", "需要 --name");
  if (!flags.pages) fail("INVALID_PARAM", "需要 --pages");
  const plan = generatePlan({
    totalPages: flags.pages,
    maxSignaturePages: flags.max ?? "16",
    name,
  });
  const ref = savePlan(name, plan);
  process.stderr.write(`已保存 计划=${name} 版本=v${ref.version} 纸张=${plan.totalSheets} 补白=${plan.totalBlankPages}\n`);
  outputPlan(plan, pickFormat(flags));
}

function cmdList(): void {
  const plans = listPlans();
  if (!plans.length) {
    process.stdout.write("（暂无计划）\n");
    return;
  }
  for (const p of plans) {
    process.stdout.write(
      `${p.name}\t当前版本=v${p.current_version}\t总页=${p.total_pages}\t每帖上限=${p.max_signature_pages}\t更新=${p.updated_at}\n`,
    );
  }
}

function cmdShow(flags: Record<string, string>): void {
  const name = flags.name;
  if (!name) fail("INVALID_PARAM", "需要 --name");
  const meta = getVersion(name, flags.version ? Number(flags.version) : undefined);
  if (!meta) fail("NOT_FOUND", flags.version ? `版本 ${flags.version} 不存在` : `计划 ${name} 不存在`);
  const plan = parseLayout(meta);
  const format = pickFormat(flags);

  if (flags.signature) {
    const sig = plan.signatures.find((s) => s.index === Number(flags.signature));
    if (!sig) fail("NOT_FOUND", `第 ${flags.signature} 帖不存在`);
    if (format === "json") process.stdout.write(JSON.stringify(sig, null, 2) + "\n");
    else if (format === "csv") {
      const one = { ...plan, signatures: [sig] };
      process.stdout.write(toCSV(one as typeof plan));
    } else {
      process.stdout.write(signatureSummary(plan) + "\n\n");
      for (const sh of sig.sheets) {
        process.stdout.write(
          `第${sh.index}张 正面[左 ${slotText(sh.front.left)} | 右 ${slotText(sh.front.right)}]  ` +
            `反面[左 ${slotText(sh.back.left)} | 右 ${slotText(sh.back.right)}]\n`,
        );
      }
    }
    return;
  }
  if (flags.sheet) {
    const wanted = Number(flags.sheet);
    const hits = getSheets(meta.id).filter((r) => r.sheet_index === wanted);
    if (!hits.length) fail("NOT_FOUND", `纸张序号 ${wanted} 不存在`);
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
    return;
  }
  outputPlan(plan, format);
}

function cmdVersions(flags: Record<string, string>): void {
  const name = flags.name;
  if (!name) fail("INVALID_PARAM", "需要 --name");
  if (!getPlanByName(name)) fail("NOT_FOUND", `计划 ${name} 不存在`);
  for (const v of listVersions(name)) {
    process.stdout.write(
      `v${v.version}\t总页=${v.total_pages}\t每帖上限=${v.max_signature_pages}\t纸张=${v.total_sheets}\t补白=${v.total_blank_pages}\t创建=${v.created_at}\n`,
    );
  }
}

function cmdExport(flags: Record<string, string>): void {
  const name = flags.name;
  if (!name) fail("INVALID_PARAM", "需要 --name");
  const meta = getVersion(name, flags.version ? Number(flags.version) : undefined);
  if (!meta) fail("NOT_FOUND", "计划或版本不存在");
  outputPlan(parseLayout(meta), pickFormat(flags));
}

function cmdRecalculate(flags: Record<string, string>): void {
  const name = flags.name;
  if (!name) fail("INVALID_PARAM", "需要 --name");
  if (!getPlanByName(name)) fail("NOT_FOUND", `计划 ${name} 不存在，请先用 generate`);
  if (!flags.pages) fail("INVALID_PARAM", "需要 --pages");
  const plan = generatePlan({ totalPages: flags.pages, maxSignaturePages: flags.max ?? "16", name });
  const ref = savePlan(name, plan);
  process.stderr.write(`已生成新版本 v${ref.version}（旧版本保留）\n`);
  outputPlan(plan, pickFormat(flags));
}

function cmdVerify(flags: Record<string, string>): void {
  if (!flags.file) fail("INVALID_PARAM", "需要 --file 指向外部页序计划 JSON");
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(flags.file, "utf-8"));
  } catch (e) {
    fail("INVALID_JSON", `无法读取/解析文件: ${(e as Error).message}`);
  }
  const result = verifyPlan(candidate);
  saveVerification({}, "external", result);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.valid) process.exit(2);
}

function banner(title: string): void {
  process.stdout.write("\n" + "=".repeat(64) + "\n" + title + "\n" + "=".repeat(64) + "\n");
}

function cmdDemo(): void {
  const cases = [
    { title: "演示 1：6 页文档补成 8 页（一帖，2 个补白在最外层）", pages: 6, max: 16 },
    { title: "演示 2：整 16 页（恰好一帖，无补白）", pages: 16, max: 16 },
    { title: "演示 3：20 页文档（超过一帖：16 + 4 两帖，无补白，展示分页边界）", pages: 20, max: 16 },
  ];
  for (const c of cases) {
    banner(c.title);
    const plan = generatePlan({ totalPages: c.pages, maxSignaturePages: c.max, name: "" });
    process.stdout.write(signatureSummary(plan) + "\n\n");
    process.stdout.write(toTable(plan) + "\n");
  }

  banner("演示 4：核验——交换两页后，即使纸张/补白数量正确也必须被拒绝");
  const good = generatePlan({ totalPages: 8, maxSignaturePages: 16, name: "" });
  const bad = JSON.parse(JSON.stringify(good));
  const frontLeft = bad.signatures[0].sheets[0].front.left;
  bad.signatures[0].sheets[0].front.left = bad.signatures[0].sheets[0].front.right;
  bad.signatures[0].sheets[0].front.right = frontLeft;
  const result = verifyPlan(bad);
  process.stdout.write(`合法计划核验 valid = ${verifyPlan(good).valid}\n`);
  process.stdout.write(`交换两页后 valid = ${result.valid}\n`);
  for (const issue of result.issues) process.stdout.write(`  - [${issue.code}] ${issue.message}\n`);
  void flatten;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { flags } = parseArgs(process.argv.slice(3));
  if (flags.db) configureDbPath(flags.db);

  try {
    switch (command) {
      case "generate": return cmdGenerate(flags);
      case "list": return cmdList();
      case "show": return cmdShow(flags);
      case "versions": return cmdVersions(flags);
      case "export": return cmdExport(flags);
      case "recalculate": return cmdRecalculate(flags);
      case "verify": return cmdVerify(flags);
      case "demo": return cmdDemo();
      case "serve": return await cmdServe(flags);
      default:
        process.stdout.write(
          [
            "用法: booklet <command> [options]",
            "命令:",
            "  generate       生成并保存拼版计划",
            "  list           列出计划",
            "  show           查看计划/逐帖/逐张",
            "  versions       查看某计划的全部版本",
            "  export         导出 json|csv|table",
            "  recalculate    用新参数生成新版本（保留旧版本）",
            "  verify         核验外部页序计划 JSON",
            "  serve          启动 HTTP API",
            "  demo           运行内置演示",
            "通用选项: --name --pages --max --version --format --file --port --host --db",
          ].join("\n") + "\n",
        );
    }
  } catch (err) {
    const e = err as Error & { code?: string };
    fail(e.code ?? "INTERNAL", e.message);
  }
}

main();
