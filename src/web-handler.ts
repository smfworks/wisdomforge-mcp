import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createWisdomForgeServer } from "./server.js";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function withCors(response: Response, body: ArrayBuffer | null): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Stateless Streamable HTTP. A new server and transport are created per request
 * so sessions are never reused. GET and DELETE are accepted and answered by the
 * SDK (405 when the server is stateless).
 */
export async function handleWebRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
    return new Response("Not found", { status: 404, headers: { ...CORS, "content-type": "text/plain" } });
  }
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...CORS, "content-type": "text/plain" },
    });
  }

  const server = createWisdomForgeServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const body = await response.arrayBuffer();
    return withCors(response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
