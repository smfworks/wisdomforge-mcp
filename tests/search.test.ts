import { describe, expect, it } from "vitest";
import { stem, tokenize } from "../src/search.js";
import { searchContent } from "../src/tools.js";

describe("tokenizer port", () => {
  it("stems the way the site index was built", () => {
    expect(stem("turing")).toBe("tur");
    // Trailing s is stripped before suffix rules, matching the site index.
    expect(stem("epictetus")).toBe("epictetu");
    expect(tokenize("the Turing test")).toEqual(["tur", "test"]);
  });
});

describe("search_content", () => {
  it("returns ranked hits for a figure query", () => {
    const result = searchContent({ query: "epictetus", limit: 5 });
    expect(result.content_version.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.count).toBeGreaterThan(0);
    expect(result.results.length).toBe(result.count);
    expect(result.results[0]?.snippet.length).toBeGreaterThan(0);
    expect(result.results.every((hit) => hit.url.startsWith("https://smfwisdomforge.com"))).toBe(true);
  });

  it("filters index documents and lessons", () => {
    const indexHits = searchContent({ query: "epictetus", type: "index_doc", figure: "epictetus", limit: 5 });
    expect(indexHits.results.length).toBeGreaterThan(0);
    expect(indexHits.results.every((hit) => hit.type === "index_doc" && hit.figure === "epictetus")).toBe(true);

    const lessons = searchContent({
      query: "circle",
      band: "little",
      type: "lesson",
      subject: "philosophy",
      limit: 5,
    });
    expect(lessons.results.length).toBeGreaterThan(0);
    expect(lessons.results.every((hit) => hit.type === "lesson" && hit.band === "little")).toBe(true);
    expect(lessons.results.some((hit) => hit.item_id === "lesson:little:philosophy:circle-you-control")).toBe(true);
  });

  it("rejects an empty query", () => {
    expect(() => searchContent({ query: "   " })).toThrow(/query/);
  });
});
