import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Store } from '../db/store.js';
import { PlanService } from '../service.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { toCSV } from '../core/export.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
const DB_PATH = process.env.BOOKLET_DB ?? resolve('data/booklet.db');

const store = new Store(DB_PATH);
const service = new PlanService(store);

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError('BAD_REQUEST', '请求体不是合法 JSON');
  }
}

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: (_req, res) => sendJson(res, 200, { status: 'ok' }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/plans$/,
    handler: (_req, res) => sendJson(res, 200, { plans: service.listPlans() }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/plans$/,
    handler: async (req, res) => {
      const body = asObject(await readJson(req));
      const created = service.createPlan(
        String(body.name ?? ''),
        Number(body.pages),
        Number(body.maxPagesPerSignature),
      );
      sendJson(res, 201, {
        planId: created.planId,
        version: created.version,
        plan: created.plan,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/plans\/(\d+)\/versions$/,
    handler: (_req, res, p) => {
      sendJson(res, 200, { versions: service.listVersions(Number(p[0])) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/plans\/(\d+)\/recalculate$/,
    handler: async (req, res, p) => {
      const body = asObject(await readJson(req));
      const result = service.recalculate(
        Number(p[0]),
        Number(body.pages),
        Number(body.maxPagesPerSignature),
      );
      sendJson(res, 201, { version: result.version, plan: result.plan });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/plans\/(\d+)(?:\?.*)?$/,
    handler: (_req, res, p) => {
      const url = _req.url ?? '';
      const versionMatch = /[?&]version=(\d+)/.exec(url);
      const formatMatch = /[?&]format=(json|csv)/.exec(url);
      const data = service.getVersion(
        Number(p[0]),
        versionMatch ? Number(versionMatch[1]) : undefined,
      );
      if (formatMatch?.[1] === 'csv') {
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="plan-${p[0]}-v${data.version}.csv"`,
        });
        res.end(toCSV(data.plan));
        return;
      }
      sendJson(res, 200, data);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/plans\/(\d+)\/signatures\/(\d+)$/,
    handler: (_req, res, p) => {
      const data = service.getVersion(Number(p[0]));
      const sig = data.plan.signatures.find((s) => s.signatureIndex === Number(p[1]));
      if (!sig) throw new NotFoundError(`没有第 ${p[1]} 帖`);
      sendJson(res, 200, { version: data.version, signature: sig });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/plans\/(\d+)\/sheets\/(\d+)$/,
    handler: (_req, res, p) => {
      const data = service.getVersion(Number(p[0]));
      const sigIndex = Number(p[1]);
      const sheetIndex = Number(p[2]);
      const sig = data.plan.signatures.find((s) => s.signatureIndex === sigIndex);
      const sheet = sig?.sheets.find((sh) => sh.sheetIndex === sheetIndex);
      if (!sheet) throw new NotFoundError(`没有第 ${sigIndex} 帖第 ${sheetIndex} 张`);
      sendJson(res, 200, { version: data.version, signatureIndex: sigIndex, sheet });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/verify$/,
    handler: async (req, res) => {
      const body = (await readJson(req)) as Parameters<PlanService['verifyExternal']>[0];
      const result = service.verifyExternal(body);
      sendJson(res, result.result.valid ? 200 : 422, result);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/verifications$/,
    handler: (req, res) => {
      const planMatch = /[?&]planId=(\d+)/.exec(req.url ?? '');
      sendJson(res, 200, {
        verifications: service.listVerifications(planMatch ? Number(planMatch[1]) : undefined),
      });
    },
  },
];

const server = createServer(async (req, res) => {
  try {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      match.slice(1).forEach((value, i) => (params[String(i)] = value));
      await route.handler(req, res, params);
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${pathname}` } });
  } catch (error) {
    if (error instanceof ValidationError) {
      sendJson(res, 400, { error: { code: error.code, message: error.message, details: error.details } });
    } else if (error instanceof NotFoundError) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: error.message } });
    } else {
      sendJson(res, 500, {
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  console.log(`小册子拼版服务已启动: http://127.0.0.1:${port}`);
  console.log(`数据文件: ${DB_PATH}`);
  console.log(`指定端口: set PORT=8080 或 $env:PORT=8080 后重启`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
