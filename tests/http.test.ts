import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, createHttpServer } from "../src/http.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

function sendRaw(port: number, payload: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(payload, (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "EPIPE" && (err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(err);
        }
      });
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const rawBuf = Buffer.concat(chunks);
      const sep = rawBuf.indexOf("\r\n\r\n");
      const head = (sep >= 0 ? rawBuf.subarray(0, sep) : rawBuf).toString("utf8");
      const body = sep >= 0 ? rawBuf.subarray(sep + 4).toString("utf8") : "";
      const match = head.match(/^HTTP\/1\.[01] (\d+)/);
      if (!match) {
        reject(new Error(`no HTTP status in ${JSON.stringify(head.slice(0, 300))}`));
        return;
      }
      resolve({ status: Number(match[1]), body });
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const rawBuf = Buffer.concat(chunks);
      const sep = rawBuf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const head = rawBuf.subarray(0, sep).toString("utf8");
      const lengthMatch = head.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) return;
      const length = Number(lengthMatch[1]);
      if (rawBuf.length >= sep + 4 + length) finish();
    };
    socket.setTimeout(5000, () => finish());
    socket.on("data", onData);
    socket.on("end", finish);
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (chunks.length > 0 && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
        finish();
        return;
      }
      if (!settled) reject(err);
    });
  });
}

function request(method: string, headers: string, body: string | Buffer = ""): Buffer {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Buffer.from(
    `${method} /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}\r\n`,
  );
  return Buffer.concat([head, payload]);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("HTTP body limit", () => {
  it("returns 413 from Content-Length without reading a short body", async () => {
    let called = false;
    const port = await listen(
      createHttpServer(async () => {
        called = true;
        return new Response("ok");
      }),
    );
    const response = await sendRaw(
      port,
      request(
        "POST",
        `Content-Type: application/json\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n`,
        "{}",
      ),
    );
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Request body exceeds 1 MB" },
      id: null,
    });
    expect(called).toBe(false);
  });

  it("returns 413 when streamed bytes exceed 1 MB", async () => {
    let called = false;
    const port = await listen(
      createHttpServer(async () => {
        called = true;
        return new Response("ok");
      }),
    );
    const size = MAX_BODY_BYTES + 1;
    const chunk = Buffer.alloc(size, 0x61);
    const response = await sendRaw(
      port,
      request(
        "POST",
        "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n",
        `${size.toString(16)}\r\n${chunk.toString("latin1")}\r\n0\r\n\r\n`,
      ),
    );
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).jsonrpc).toBe("2.0");
    expect(JSON.parse(response.body).error.message).toMatch(/1 MB/);
    expect(called).toBe(false);
  });

  it("accepts a body of exactly 1 MB", async () => {
    let received = 0;
    const port = await listen(
      createHttpServer(async (incoming) => {
        received = (await incoming.arrayBuffer()).byteLength;
        return new Response("ok", { status: 200 });
      }),
    );
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x62);
    const response = await sendRaw(
      port,
      request("POST", `Content-Type: application/octet-stream\r\nContent-Length: ${MAX_BODY_BYTES}\r\n`, body),
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
    expect(received).toBe(MAX_BODY_BYTES);
  });
});

describe("HTTP error handler", () => {
  it("returns a generic 500 and logs the real error to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await listen(
      createHttpServer(async () => {
        throw new Error("database password=secret-token");
      }),
    );
    try {
      const response = await sendRaw(
        port,
        request("POST", "Content-Type: application/json\r\nContent-Length: 2\r\n", "{}"),
      );
      expect(response.status).toBe(500);
      expect(response.body).toBe('{"error":"Internal server error"}');
      expect(response.body).not.toContain("secret-token");
      expect(spy).toHaveBeenCalled();
      const logged = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("database password=secret-token");
    } finally {
      spy.mockRestore();
    }
  });
});
