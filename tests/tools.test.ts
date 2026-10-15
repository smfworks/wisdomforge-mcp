import { describe, expect, it } from "vitest";
import { itemById } from "../src/catalog.js";
import {
  getCatalogInfo,
  getCourseOutline,
  getItem,
  getLessonPlanSeed,
  getMediaUrls,
  listAgeBands,
  listByAgeBand,
  listCourses,
  listSubjects,
  recommendForLearner,
  ToolError,
} from "../src/tools.js";

const CIRCLE = "lesson:little:philosophy:circle-you-control";

describe("list_age_bands", () => {
  it("returns four bands and the booklet level mapping", () => {
    const result = listAgeBands();
    expect(result.bands.map((band) => band.id)).toEqual(["little", "young", "emerging", "adult"]);
    expect(result.levelToBand).toEqual({
      elementary: "little",
      middle: "young",
      high: "emerging",
      adult: "adult",
    });
    expect(result.bands.find((band) => band.id === "little")?.ages).toContain("5");
    expect(result.content_version.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("list_subjects", () => {
  it("returns ten subjects with counts", () => {
    const result = listSubjects();
    expect(result.subjects).toHaveLength(10);
    expect(result.subjects.map((subject) => subject.id)).toContain("philosophy");
    expect(result.subjects.every((subject) => subject.count > 0)).toBe(true);
    const little = listSubjects("little");
    const philosophy = little.subjects.find((subject) => subject.id === "philosophy");
    expect(philosophy?.count).toBeGreaterThan(0);
  });
});

describe("get_item", () => {
  it("returns summary, chapters, and full text for a lesson", () => {
    const summary = getItem(CIRCLE, "summary");
    expect(summary.item.title).toBe("The Circle You Control");
    expect(summary.item).not.toHaveProperty("text");
    expect(summary.item.hermes?.pairingLine).toContain("WisdomForge");

    const chapters = getItem(CIRCLE, "chapters");
    if (!("chapters" in chapters.item)) throw new Error("expected chapters view");
    expect(chapters.item.chapters.length).toBeGreaterThan(0);

    const full = getItem(CIRCLE, "full");
    if (!("text" in full.item)) throw new Error("expected full view");
    expect(full.item.text.length).toBeGreaterThan(200);
    expect(full.item.text).toContain("Epictetus");
    expect(full.item.url).toBe("https://smfwisdomforge.com/learn/little/philosophy/circle-you-control");
  });

  it("errors on an unknown id", () => {
    expect(() => getItem("missing")).toThrow(ToolError);
  });
});

describe("list_by_age_band", () => {
  it("pages without overlap", () => {
    const first = listByAgeBand({ band: "little", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBeGreaterThan(2);
    expect(first.nextCursor).toBeTruthy();
    const second = listByAgeBand({ band: "little", limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items[0]?.item_id).not.toBe(first.items[0]?.item_id);
    expect(second.items[1]?.item_id).not.toBe(first.items[1]?.item_id);
    expect(() => listByAgeBand({ band: "little", cursor: "%%%" })).toThrow(/cursor/i);
  });

  it("filters by subject and type", () => {
    const page = listByAgeBand({ band: "little", subject: "philosophy", type: "lesson", limit: 20 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.subject === "philosophy" && item.type === "lesson")).toBe(true);
  });
});

describe("courses", () => {
  it("lists a stoic track and returns its sittings", () => {
    const listed = listCourses({ band: "little", subject: "philosophy" });
    const course = listed.courses.find((entry) => entry.course_id === "course:unit:stoics:little");
    expect(course).toBeTruthy();
    expect(course?.itemIds.length).toBeGreaterThan(0);
    const outline = getCourseOutline("course:unit:stoics:little");
    expect(outline.entries.length).toBe(course?.entryCount);
    expect(outline.entries.some((entry) => entry.itemId === CIRCLE)).toBe(true);
    expect(itemById(outline.entries[0]?.itemId ?? "")).toBeTruthy();
  });

  it("errors on an unknown course", () => {
    expect(() => getCourseOutline("course:missing")).toThrow(ToolError);
  });
});

describe("get_media_urls", () => {
  it("returns a booklet pdf and can filter kinds", () => {
    const media = getMediaUrls("booklet:epictetus:little");
    expect(media.media.some((entry) => entry.kind === "pdf" && entry.url.endsWith("/downloads/epictetus-elementary.pdf"))).toBe(true);
    expect(media.media.find((entry) => entry.kind === "pdf")?.bytes).toBeGreaterThan(1000);
    const pdfs = getMediaUrls("booklet:epictetus:little", ["pdf"]);
    expect(pdfs.media.every((entry) => entry.kind === "pdf")).toBe(true);
    const audio = getMediaUrls("audio:basil-great:basil-great-adult-ch01", ["mp3"]);
    expect(audio.media).toHaveLength(1);
    expect(audio.media[0]?.mime).toBe("audio/mpeg");
    expect(audio.media[0]?.bytes).toBeGreaterThan(1000);
  });
});

describe("get_lesson_plan_seed", () => {
  it("includes the Hermes prompt, a question, and a printable", () => {
    const seed = getLessonPlanSeed(CIRCLE, {
      age: 8,
      learning_style: "kinesthetic",
      interests: ["choices"],
    });
    expect(seed.objectives[0]?.length).toBeGreaterThan(0);
    expect(seed.hermes?.prompt.toLowerCase()).toContain("circle");
    expect(seed.discussionQuestions.length).toBeGreaterThan(0);
    expect(seed.activities.length).toBeGreaterThan(0);
    expect(seed.printableLinks.some((link) => link.kind === "pdf")).toBe(true);
    expect(seed.adaptation).toContain("little");
    expect(seed.adaptation).toContain("Kinesthetic");
  });
});

describe("recommend_for_learner", () => {
  it("is deterministic and stays inside the age band", () => {
    const args = {
      age: 8,
      learning_style: "reading" as const,
      interests: ["epictetus"],
      subjects: ["philosophy" as const],
      limit: 5,
    };
    const first = recommendForLearner(args);
    const second = recommendForLearner(args);
    expect(second).toEqual(first);
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.results.every((row) => row.band === "little")).toBe(true);
    expect(first.results.every((row) => row.rationale.length > 0)).toBe(true);
    expect(first.learner.band).toBe("little");
  });

  it("boosts audio for auditory learners and excludes ids", () => {
    const auditory = recommendForLearner({
      age: 16,
      learning_style: "auditory",
      interests: ["basil"],
      limit: 5,
    });
    expect(auditory.results.some((row) => row.type === "audio")).toBe(true);
    expect(auditory.results.every((row) => row.band === "emerging")).toBe(true);

    const top = auditory.results[0]?.item_id;
    expect(top).toBeTruthy();
    const excluded = recommendForLearner({
      age: 16,
      learning_style: "auditory",
      interests: ["basil"],
      exclude_ids: [top ?? ""],
      limit: 5,
    });
    expect(excluded.results.map((row) => row.item_id)).not.toContain(top);
  });

  it("prefers a hands-on lesson for a kinesthetic little thinker", () => {
    const result = recommendForLearner({
      age: 7,
      learning_style: "kinesthetic",
      interests: ["circle"],
      subjects: ["philosophy"],
      limit: 3,
    });
    expect(result.results[0]?.type).toBe("lesson");
    expect(result.results[0]?.item_id).toBe(CIRCLE);
  });
});

describe("get_catalog_info", () => {
  it("reports committed counts and the pinned source", () => {
    const info = getCatalogInfo();
    expect(info.counts.lesson).toBe(446);
    expect(info.counts.book).toBe(43);
    expect(info.counts.booklet).toBe(168);
    expect(info.counts.audio).toBe(72);
    expect(info.counts.demo).toBe(8);
    expect(info.counts.index_doc).toBe(1332);
    expect(info.searchIndex.docCount).toBe(1332);
    expect(info.searchIndex.built.startsWith("2026-09-21")).toBe(true);
    expect(info.content_version.sourceSha).toBe("565aa884b0c7cee103505ad1597ced2e9a49e33e");
    expect(info.license).toContain("MIT");
    expect(info.childSafety.toLowerCase()).toContain("read-only");
    expect(info.bands).toBe(4);
    expect(info.subjects).toBe(10);
  });
});
