import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleWebRequest } from "./web-handler.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

async function toWebRequest(req: IncomingMessage): Promise<Request> {
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
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

const server = createServer(async (req, res) => {
  try {
    const request = await toWebRequest(req);
    const response = await handleWebRequest(request);
    const body = Buffer.from(await response.arrayBuffer());
    send(res, response, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(message);
  }
});

server.listen(port, host, () => {
  console.log(`wisdomforge-mcp listening on http://${host}:${port}/mcp`);
});
