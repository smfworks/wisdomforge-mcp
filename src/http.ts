import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { handleWebRequest } from "./web-handler.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

/** 1 MB. Requests larger than this are rejected with HTTP 413. */
export const MAX_BODY_BYTES = 1_048_576;

export type WebHandler = (request: Request) => Promise<Response>;

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 1 MB");
    this.name = "PayloadTooLargeError";
  }
}

function declaredContentLength(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = declaredContentLength(req);
  if (declared !== undefined && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const declared = declaredContentLength(req);
  if (declared !== undefined && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const hostHeader = req.headers.host ?? `${host}:${port}`;
  const url = `http://${hostHeader}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return new Request(url, { method, headers });
  }
  const body = await readBody(req);
  return new Request(url, {
    method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
}

function send(res: ServerResponse, response: Response, body: Buffer): void {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  res.setHeader("content-length", body.length);
  res.end(body);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function rejectTooLarge(req: IncomingMessage, res: ServerResponse): void {
  writeJson(res, 413, {
    jsonrpc: "2.0",
    error: { code: -32600, message: "Request body exceeds 1 MB" },
    id: null,
  });
  req.resume();
  res.on("finish", () => {
    req.destroy();
  });
}

export function createHttpServer(handle: WebHandler = handleWebRequest): Server {
  return createServer(async (req, res) => {
    try {
      const request = await toWebRequest(req);
      const response = await handle(request);
      const body = Buffer.from(await response.arrayBuffer());
      send(res, response, body);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        rejectTooLarge(req, res);
        return;
      }
      console.error(err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    }
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  const server = createHttpServer();
  server.listen(port, host, () => {
    console.log(`wisdomforge-mcp listening on http://${host}:${port}/mcp`);
  });
}
