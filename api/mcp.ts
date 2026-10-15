import { handleWebRequest } from "../src/web-handler.js";

/** Vercel serverless function. Rewrite /mcp -> /api/mcp is in vercel.json. */
export function GET(request: Request): Promise<Response> {
  return handleWebRequest(request);
}

export function POST(request: Request): Promise<Response> {
  return handleWebRequest(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleWebRequest(request);
}
