import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INPUT_LIMITS, createWisdomForgeServer } from "../src/server.js";

const client = new Client({ name: "wisdomforge-limits", version: "0.0.0" });
let closeServer: () => Promise<void> = async () => undefined;

function textOf(result: { content?: { text?: string }[] }): string {
  return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

beforeAll(async () => {
  const server = createWisdomForgeServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closeServer = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await closeServer();
});

describe("tool input limits", () => {
  async function expectRejected(name: string, args: Record<string, unknown>, limit: number): Promise<void> {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/validation/i);
    expect(text).toContain(String(limit));
  }

  it("rejects an oversize search query and figure, and accepts the maximum", async () => {
    await expectRejected("search_content", { query: "q".repeat(INPUT_LIMITS.query + 1) }, INPUT_LIMITS.query);
    await expectRejected(
      "search_content",
      { query: "epictetus", figure: "f".repeat(INPUT_LIMITS.figure + 1) },
      INPUT_LIMITS.figure,
    );

    const accepted = await call("search_content", {
      query: "epictetus",
      figure: "f".repeat(INPUT_LIMITS.figure),
      limit: 1,
    });
    expect(accepted.isError).toBeFalsy();
  });

  it("rejects oversize item ids, course ids, and cursors", async () => {
    const itemId = "i".repeat(INPUT_LIMITS.itemId + 1);
    await expectRejected("get_item", { item_id: itemId }, INPUT_LIMITS.itemId);
    await expectRejected("get_media_urls", { item_id: itemId }, INPUT_LIMITS.itemId);
    await expectRejected("get_lesson_plan_seed", { item_id: itemId }, INPUT_LIMITS.itemId);
    await expectRejected(
      "get_course_outline",
      { course_id: "c".repeat(INPUT_LIMITS.courseId + 1) },
      INPUT_LIMITS.courseId,
    );
    await expectRejected(
      "list_by_age_band",
      { band: "little", cursor: "x".repeat(INPUT_LIMITS.cursor + 1) },
      INPUT_LIMITS.cursor,
    );
  });

  it("rejects oversize interest lists and exclude ids", async () => {
    const longInterest = "n".repeat(INPUT_LIMITS.interest + 1);
    await expectRejected(
      "get_lesson_plan_seed",
      {
        item_id: "lesson:little:philosophy:circle-you-control",
        learner_profile: { interests: [longInterest] },
      },
      INPUT_LIMITS.interest,
    );
    await expectRejected(
      "recommend_for_learner",
      {
        age: 8,
        learning_style: "reading",
        interests: Array.from({ length: INPUT_LIMITS.interests + 1 }, () => "math"),
      },
      INPUT_LIMITS.interests,
    );
    await expectRejected(
      "recommend_for_learner",
      {
        age: 8,
        learning_style: "reading",
        exclude_ids: ["e".repeat(INPUT_LIMITS.excludeId + 1)],
      },
      INPUT_LIMITS.excludeId,
    );
    await expectRejected(
      "recommend_for_learner",
      {
        age: 8,
        learning_style: "reading",
        exclude_ids: Array.from({ length: INPUT_LIMITS.excludeIds + 1 }, (_, index) => `id-${index}`),
      },
      INPUT_LIMITS.excludeIds,
    );

    const accepted = await call("recommend_for_learner", {
      age: 8,
      learning_style: "reading",
      interests: Array.from({ length: INPUT_LIMITS.interests }, () => "m".repeat(INPUT_LIMITS.interest)),
      exclude_ids: Array.from({ length: 2 }, (_, index) => `missing-${index}`),
      limit: 1,
    });
    expect(accepted.isError).toBeFalsy();
  });
});
