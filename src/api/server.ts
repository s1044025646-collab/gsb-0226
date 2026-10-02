/**
 * 纯 Node http 实现的本地 REST API，无第三方框架。
 *
 * 路由：
 *  GET  /health
 *  POST /plans                          生成（同名则追加新版本）
 *  GET  /plans                          列出计划
 *  GET  /plans/:name                    计划详情（?version=）
 *  GET  /plans/:name/versions           版本列表
 *  GET  /plans/:name/signatures/:idx    逐帖查看（?version=）
 *  GET  /plans/:name/sheets/:n          逐张查看（?version=）
 *  GET  /plans/:name/export?format=json|csv|table   导出
 *  POST /plans/:name/recalculate        body:{totalPages,maxSignaturePages} 生成新版本
 *  POST /verify                         body:外部页序计划，或 {name,version}
 *  GET  /verifications                  最近核验结果
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  getPlanByName,
  getSheets,
  getVersion,
  listPlans,
  listVersions,
  openDb,
  parseLayout,
  savePlan,
  saveVerification,
} from "../db/store.js";
import { generatePlan } from "../core/imposition.js";
import { verifyPlan } from "../core/verify.js";
import { toCSV, toTable } from "../core/format.js";

type Params = Record<string, string>;

interface Route {
  method: string;
  segments: string[];
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Params,
    query: URLSearchParams,
  ) => Promise<void> | void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

function loadVersion(name: string, version?: string | null) {
  const meta = getVersion(name, version ? Number(version) : undefined);
  if (!meta) {
    const err = new Error(version ? `版本 ${version} 不存在` : `计划 ${name} 不存在`);
    (err as Error & { status?: number }).status = 404;
    (err as Error & { code?: string }).code = "NOT_FOUND";
    throw err;
  }
  return meta;
}

const routes: Route[] = [
  {
    method: "GET",
    segments: ["health"],
    handler: (_req, res) => sendJson(res, 200, { ok: true }),
  },
  {
    method: "POST",
    segments: ["plans"],
    handler: async (req, res) => {
      const body = await readJson(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        return sendError(res, 400, "INVALID_PARAM", "name 必填且须为非空字符串");
      }
      const plan = generatePlan(body);
      const ref = savePlan(body.name.trim(), plan);
      sendJson(res, 201, { ...ref, plan });
    },
  },
  {
    method: "GET",
    segments: ["plans"],
    handler: (_req, res) => sendJson(res, 200, { plans: listPlans() }),
  },
  {
    method: "GET",
    segments: ["plans", ":name"],
    handler: (_req, res, params, query) => {
      const meta = loadVersion(params.name!, query.get("version"));
      sendJson(res, 200, { version: meta.version, plan: parseLayout(meta) });
    },
  },
  {
    method: "GET",
    segments: ["plans", ":name", "versions"],
    handler: (_req, res, params) => {
      const name = params.name!;
      if (!getPlanByName(name)) return sendError(res, 404, "NOT_FOUND", "计划不存在");
      const versions = listVersions(name).map((v) => ({
        version: v.version,
        totalPages: v.total_pages,
        maxSignaturePages: v.max_signature_pages,
        totalSheets: v.total_sheets,
        totalBlankPages: v.total_blank_pages,
        createdAt: v.created_at,
      }));
      sendJson(res, 200, { name, versions });
    },
  },
  {
    method: "GET",
    segments: ["plans", ":name", "signatures", ":idx"],
    handler: (_req, res, params, query) => {
      const meta = loadVersion(params.name!, query.get("version"));
      const plan = parseLayout(meta);
      const sig = plan.signatures.find((s) => s.index === Number(params.idx));
      if (!sig) return sendError(res, 404, "NOT_FOUND", "帖不存在");
      sendJson(res, 200, { version: meta.version, signature: sig });
    },
  },
  {
    method: "GET",
    segments: ["plans", ":name", "sheets", ":n"],
    handler: (_req, res, params, query) => {
      const meta = loadVersion(params.name!, query.get("version"));
      const plan = parseLayout(meta);
      const wanted = Number(params.n);
      const found: unknown[] = [];
      for (const sig of plan.signatures) {
        for (const sh of sig.sheets) {
          if (sh.index === wanted) found.push({ signature: sig.index, sheet: sh });
        }
      }
      if (!found.length) return sendError(res, 404, "NOT_FOUND", "纸张序号不存在");
      sendJson(res, 200, { version: meta.version, sheets: found });
    },
  },
  {
    method: "GET",
    segments: ["plans", ":name", "export"],
    handler: (_req, res, params, query) => {
      const meta = loadVersion(params.name!, query.get("version"));
      const plan = parseLayout(meta);
      const format = (query.get("format") ?? "json").toLowerCase();
      if (format === "csv") {
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${params.name}-v${meta.version}.csv"`,
        });
        return res.end(toCSV(plan));
      }
      if (format === "table") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(toTable(plan) + "\n");
      }
      sendJson(res, 200, { version: meta.version, plan });
    },
  },
  {
    method: "POST",
    segments: ["plans", ":name", "recalculate"],
    handler: async (req, res, params) => {
      const name = params.name!;
      if (!getPlanByName(name)) return sendError(res, 404, "NOT_FOUND", "计划不存在");
      const body = await readJson(req);
      const plan = generatePlan({ ...body, name });
      const ref = savePlan(name, plan);
      sendJson(res, 201, { ...ref, recalculated: true, plan });
    },
  },
  {
    method: "POST",
    segments: ["verify"],
    handler: async (req, res) => {
      const body = await readJson(req);
      let candidate: unknown;
      let planId: number | undefined;
      let versionId: number | undefined;
      let source = "external";
      if (body.name) {
        const meta = getVersion(body.name, body.version);
        if (!meta) return sendError(res, 404, "NOT_FOUND", "计划或版本不存在");
        candidate = parseLayout(meta);
        planId = meta.plan_id;
        versionId = meta.id;
        source = "stored";
      } else {
        candidate = body.plan ?? body;
      }
      const result = verifyPlan(candidate);
      const id = saveVerification({ planId, versionId }, source, result);
      sendJson(res, 200, { verificationId: id, result });
    },
  },
  {
    method: "GET",
    segments: ["verifications"],
    handler: (_req, res) => {
      const rows = openDb()
        .prepare(
          "SELECT id, plan_id, version_id, source, valid, total_pages, expected_sheets, actual_sheets, created_at FROM verifications ORDER BY id DESC LIMIT 50",
        )
        .all();
      sendJson(res, 200, { verifications: rows });
    },
  },
];

function matchRoute(method: string, parts: string[]): { route: Route; params: Params } | null {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params: Params = {};
    let ok = true;
    route.segments.forEach((seg, i) => {
      const part = parts[i]!;
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
      else if (seg !== part) ok = false;
    });
    if (ok) return { route, params };
  }
  return null;
}

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const matched = matchRoute(req.method ?? "GET", parts);
      if (!matched) {
        return sendError(res, 404, "NOT_FOUND", `无此路由: ${req.method} ${url.pathname}`);
      }
      await matched.route.handler(req, res, matched.params, url.searchParams);
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.message === "INVALID_JSON") {
        return sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
      }
      if (e.message === "BODY_TOO_LARGE") {
        return sendError(res, 413, "BODY_TOO_LARGE", "请求体过大");
      }
      const status = e.status ?? (e.code === "INVALID_PARAM" ? 400 : 500);
      sendError(res, status, e.code ?? "INTERNAL", e.message || "内部错误");
    }
  });
}

export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : port;
}

// 让逐张查询的 store 导入保持被引用（类型/辅助），避免误删。
void getSheets;
