/**
 * Spawn the built stdio server and the local HTTP server, list tools, and call every tool.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedTools = [...TOOL_NAMES].sort();

function structured(result: unknown, label: string): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    throw new Error(`${label} returned an unexpected result`);
  }
  const recordResult = result as {
    isError?: boolean;
    content?: { type?: string; text?: string }[];
    structuredContent?: unknown;
  };
  if (recordResult.isError) {
    throw new Error(`${label} returned an error: ${JSON.stringify(result)}`);
  }
  const content = recordResult.content;
  const text = content?.[0]?.text ?? "";
  if (!text.trim()) throw new Error(`${label} returned empty text content`);
  const data = recordResult.structuredContent;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label} returned no structuredContent`);
  }
  const record = data as Record<string, unknown>;
  if (!record.content_version) throw new Error(`${label} missing content_version`);
  return record;
}

function nonEmptyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} expected a non-empty array`);
  }
  return value;
}

async function expectTools(client: Client): Promise<void> {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  if (names.join(",") !== expectedTools.join(",")) {
    throw new Error(`expected 11 tools, got ${names.join(", ")}`);
  }
  for (const tool of listed.tools) {
    if (tool.annotations?.readOnlyHint !== true) {
      throw new Error(`${tool.name} missing readOnlyHint`);
    }
  }
}

async function callEveryTool(client: Client): Promise<void> {
  const info = structured(await client.callTool({ name: "get_catalog_info", arguments: {} }), "get_catalog_info");
  const counts = info.counts as Record<string, number>;
  if (!counts || counts.lesson < 1 || counts.index_doc < 1) {
    throw new Error(`catalog counts look empty: ${JSON.stringify(counts)}`);
  }

  const bands = structured(await client.callTool({ name: "list_age_bands", arguments: {} }), "list_age_bands");
  nonEmptyArray(bands.bands, "list_age_bands");

  const subjects = structured(
    await client.callTool({ name: "list_subjects", arguments: { band: "young" } }),
    "list_subjects",
  );
  nonEmptyArray(subjects.subjects, "list_subjects");

  const page = structured(
    await client.callTool({
      name: "list_by_age_band",
      arguments: { band: "little", subject: "philosophy", type: "lesson", limit: 5 },
    }),
    "list_by_age_band",
  );
  const pageItems = nonEmptyArray(page.items, "list_by_age_band");
  const lessonId = (pageItems[0] as { item_id: string }).item_id;

  const search = structured(
    await client.callTool({
      name: "search_content",
      arguments: { query: "epictetus", band: "little", limit: 5 },
    }),
    "search_content",
  );
  nonEmptyArray(search.results, "search_content");

  const item = structured(
    await client.callTool({
      name: "get_item",
      arguments: { item_id: lessonId, include: "full" },
    }),
    "get_item",
  );
  const itemBody = item.item as { title?: string; text?: string };
  if (!itemBody?.title || !itemBody.text) throw new Error("get_item full was empty");

  const courses = structured(
    await client.callTool({
      name: "list_courses",
      arguments: { band: "little", subject: "philosophy" },
    }),
    "list_courses",
  );
  const courseRows = nonEmptyArray(courses.courses, "list_courses");
  const courseId = (courseRows[0] as { course_id: string }).course_id;

  const outline = structured(
    await client.callTool({ name: "get_course_outline", arguments: { course_id: courseId } }),
    "get_course_outline",
  );
  nonEmptyArray(outline.entries, "get_course_outline");

  const media = structured(
    await client.callTool({
      name: "get_media_urls",
      arguments: { item_id: "booklet:epictetus:little", kinds: ["pdf"] },
    }),
    "get_media_urls",
  );
  nonEmptyArray(media.media, "get_media_urls");

  const seed = structured(
    await client.callTool({
      name: "get_lesson_plan_seed",
      arguments: {
        item_id: "lesson:little:philosophy:circle-you-control",
        learner_profile: { age: 8, learning_style: "kinesthetic", interests: ["stories"] },
      },
    }),
    "get_lesson_plan_seed",
  );
  nonEmptyArray(seed.objectives, "get_lesson_plan_seed objectives");
  nonEmptyArray(seed.discussionQuestions, "get_lesson_plan_seed questions");
  if (!seed.hermes) throw new Error("get_lesson_plan_seed missing hermes");

  const recommended = structured(
    await client.callTool({
      name: "recommend_for_learner",
      arguments: {
        age: 12,
        learning_style: "auditory",
        interests: ["locke"],
        limit: 5,
      },
    }),
    "recommend_for_learner",
  );
  nonEmptyArray(recommended.results, "recommend_for_learner");

  const resource = await client.readResource({
    uri: "wisdomforge://item/lesson:little:philosophy:circle-you-control",
  });
  const firstContent = resource.contents[0];
  const resourceText = firstContent && "text" in firstContent ? firstContent.text : "";
  if (!resourceText.includes("circle-you-control")) {
    throw new Error("resource template did not return the lesson");
  }
}

function waitForStdout(child: ChildProcess, pattern: RegExp): Promise<void> {
  if (!child.stdout) return Promise.reject(new Error("HTTP server has no stdout"));
  return new Promise((resolvePromise, reject) => {
    const lines = createInterface({ input: child.stdout! });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("HTTP server did not start"));
    }, 20_000);
    lines.on("line", (line) => {
      if (settled || !pattern.test(line)) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      resolvePromise();
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`HTTP server exited early (${code})`));
    });
  });
}

async function smokeStdio(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(root, "dist/stdio.js")],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "wisdomforge-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    await expectTools(client);
    await callEveryTool(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function smokeHttp(): Promise<void> {
  const port = process.env.SMOKE_PORT ?? "18765";
  const child = spawn("node", [resolve(root, "dist/http.js")], {
    cwd: root,
    env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "wisdomforge-smoke-http", version: "1.0.0" });
  try {
    await waitForStdout(child, /listening on/);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    await expectTools(client);
    const info = structured(
      await client.callTool({ name: "get_catalog_info", arguments: {} }),
      "http get_catalog_info",
    );
    if (!(info.counts as { total?: number }).total) throw new Error("HTTP catalog info was empty");
    const search = structured(
      await client.callTool({
        name: "search_content",
        arguments: { query: "seneca", limit: 3 },
      }),
      "http search_content",
    );
    nonEmptyArray(search.results, "http search_content");
  } catch (err) {
    if (stderr.trim()) process.stderr.write(stderr);
    throw err;
  } finally {
    await client.close().catch(() => undefined);
    if (!child.killed) child.kill("SIGTERM");
  }
}

const timer = setTimeout(() => {
  process.stderr.write("smoke timed out\n");
  process.exit(1);
}, 90_000);

try {
  await smokeStdio();
  await smokeHttp();
  process.stdout.write("smoke ok\n");
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
