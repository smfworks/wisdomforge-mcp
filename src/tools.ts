import {
  compareItems,
  contentVersion,
  courseById,
  courses,
  itemById,
  itemByIndexPath,
  items,
  loadCatalog,
  matchesBand,
} from "./catalog.js";
import { bandForAge, scoreForLearner } from "./recommend.js";
import { lexicalScore, prepareLexical, searchIndex, snippetFor, tokenize } from "./search.js";
import type {
  BandId,
  CatalogItem,
  ItemType,
  LearningStyle,
  MediaKind,
  SubjectId,
} from "./types.js";
import { BANDS, ITEM_TYPES, MEDIA_KINDS, SUBJECTS } from "./types.js";

export class ToolError extends Error {}

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;
const RECOMMEND_LIMIT_DEFAULT = 10;
const RECOMMEND_LIMIT_MAX = 25;

function versioned<T extends Record<string, unknown>>(data: T): T & { content_version: ReturnType<typeof contentVersion> } {
  return { content_version: contentVersion(), ...data };
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function requireBand(band: string): BandId {
  if (!(BANDS as readonly string[]).includes(band)) {
    throw new ToolError(`Unknown band "${band}". Expected one of ${BANDS.join(", ")}.`);
  }
  return band as BandId;
}

function requireSubject(subject: string): SubjectId {
  if (!(SUBJECTS as readonly string[]).includes(subject)) {
    throw new ToolError(`Unknown subject "${subject}". Expected one of ${SUBJECTS.join(", ")}.`);
  }
  return subject as SubjectId;
}

function requireType(type: string): ItemType {
  if (!(ITEM_TYPES as readonly string[]).includes(type)) {
    throw new ToolError(`Unknown type "${type}". Expected one of ${ITEM_TYPES.join(", ")}.`);
  }
  return type as ItemType;
}

function card(item: CatalogItem) {
  return {
    item_id: item.id,
    type: item.type,
    band: item.band,
    subject: item.subject,
    figure: item.figure,
    title: item.title,
    summary: item.summary,
    url: item.url,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(text)) throw new Error("bad");
    return Number(text);
  } catch {
    throw new ToolError("Invalid cursor.");
  }
}

export interface SearchArgs {
  query: string;
  band?: BandId;
  subject?: SubjectId;
  type?: ItemType;
  figure?: string;
  limit?: number;
}

export function searchContent(args: SearchArgs) {
  const query = args.query?.trim() ?? "";
  if (!query) throw new ToolError("query is required.");
  const limit = clamp(args.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const figure = args.figure?.trim().toLowerCase();
  const queryTokens = tokenize(query);
  const merged = new Map<string, { item: CatalogItem; score: number }>();

  if (!args.band && args.type !== "lesson" && args.type !== "book" && args.type !== "booklet" && args.type !== "audio" && args.type !== "demo") {
    for (const hit of searchIndex(query, Math.max(limit * 8, 40))) {
      const item = itemByIndexPath(hit.path);
      if (!item) continue;
      if (!passes(item, args.band, args.subject, args.type, figure)) continue;
      const prev = merged.get(item.id);
      if (!prev || hit.score > prev.score) merged.set(item.id, { item, score: hit.score });
    }
  }

  if (args.type !== "index_doc") {
    for (const doc of prepareLexical(items())) {
      if (!passes(doc.item, args.band, args.subject, args.type, figure)) continue;
      const score = lexicalScore(doc, queryTokens);
      if (score <= 0) continue;
      const prev = merged.get(doc.item.id);
      if (!prev || score > prev.score) merged.set(doc.item.id, { item: doc.item, score });
    }
  }

  const results = [...merged.values()]
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .slice(0, limit)
    .map(({ item, score }) => ({
      item_id: item.id,
      title: item.title,
      type: item.type,
      band: item.band,
      subject: item.subject,
      figure: item.figure,
      score,
      snippet: snippetFor(item, query),
      url: item.url,
    }));

  return versioned({ query, count: results.length, results });
}

function passes(
  item: CatalogItem,
  band: BandId | undefined,
  subject: SubjectId | undefined,
  type: ItemType | undefined,
  figure: string | undefined,
): boolean {
  if (band && !matchesBand(item, band)) return false;
  if (subject && item.subject !== subject) return false;
  if (type && item.type !== type) return false;
  if (figure && (item.figure ?? "").toLowerCase() !== figure) return false;
  return true;
}

export function getItem(itemId: string, include: "summary" | "full" | "chapters" = "summary") {
  const item = itemById(itemId);
  if (!item) throw new ToolError(`Unknown item_id "${itemId}".`);
  if (include === "summary") {
    return versioned({
      include,
      item: {
        ...card(item),
        level: item.level,
        bands: item.bands,
        excerpt: item.excerpt.slice(0, 500),
        media: item.media,
        hermes: item.hermes ?? null,
        unit: item.unit ?? null,
        number: item.number ?? null,
        durationMin: item.durationMin ?? null,
        objective: item.objective ?? null,
        relatedItemIds: item.relatedItemIds ?? [],
        textSource: item.textSource,
      },
    });
  }
  if (include === "chapters") {
    return versioned({
      include,
      item: {
        ...card(item),
        level: item.level,
        chapters: item.chapters,
        media: item.media,
        hermes: item.hermes ?? null,
      },
    });
  }
  return versioned({
    include,
    item: {
      ...item,
      hermes: item.hermes ?? null,
    },
  });
}

export function listAgeBands() {
  const catalog = loadCatalog();
  return versioned({
    count: catalog.bands.length,
    mappingNote: catalog.mappingNote,
    levelToBand: catalog.levelToBand,
    bandToLevel: catalog.bandToLevel,
    bands: catalog.bands,
  });
}

export function listSubjects(band?: BandId) {
  const catalog = loadCatalog();
  const pool = items().filter((item) => item.type !== "index_doc");
  const subjects = catalog.subjects.map((subject) => {
    const matching = pool.filter((item) => {
      if (item.subject !== subject.id) return false;
      if (band && !matchesBand(item, band)) return false;
      return true;
    });
    const byType: Record<string, number> = {};
    for (const item of matching) byType[item.type] = (byType[item.type] ?? 0) + 1;
    return {
      id: subject.id,
      name: subject.name,
      short: subject.short,
      promise: subject.promise,
      count: matching.length,
      byType,
    };
  });
  return versioned({
    band: band ?? null,
    count: subjects.length,
    subjects,
  });
}

export interface ListByBandArgs {
  band: BandId;
  subject?: SubjectId;
  type?: ItemType;
  cursor?: string;
  limit?: number;
}

export function listByAgeBand(args: ListByBandArgs) {
  const band = requireBand(args.band);
  const subject = args.subject ? requireSubject(args.subject) : undefined;
  const type = args.type ? requireType(args.type) : undefined;
  const limit = clamp(args.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const offset = args.cursor ? decodeCursor(args.cursor) : 0;
  const filtered = items()
    .filter((item) => item.type !== "index_doc")
    .filter((item) => matchesBand(item, band))
    .filter((item) => (subject ? item.subject === subject : true))
    .filter((item) => (type ? item.type === type : true))
    .sort(compareItems);
  const page = filtered.slice(offset, offset + limit);
  const next = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
  return versioned({
    band,
    subject: subject ?? null,
    type: type ?? null,
    total: filtered.length,
    limit,
    nextCursor: next,
    items: page.map(card),
  });
}

export function listCourses(args: { band?: BandId; subject?: SubjectId } = {}) {
  const band = args.band ? requireBand(args.band) : undefined;
  const subject = args.subject ? requireSubject(args.subject) : undefined;
  const list = courses()
    .filter((course) => (band ? course.band === band : true))
    .filter((course) => (subject ? course.subject === subject : true))
    .map((course) => ({
      course_id: course.id,
      kind: course.kind,
      title: course.title,
      band: course.band,
      subject: course.subject,
      summary: course.summary,
      weeks: course.weeks ?? null,
      status: course.status ?? null,
      url: course.url,
      entryCount: course.entries.length,
      itemIds: course.entries.map((entry) => entry.itemId),
    }));
  return versioned({
    band: band ?? null,
    subject: subject ?? null,
    count: list.length,
    courses: list,
  });
}

export function getCourseOutline(courseId: string) {
  const course = courseById(courseId);
  if (!course) throw new ToolError(`Unknown course_id "${courseId}".`);
  return versioned({
    course_id: course.id,
    kind: course.kind,
    title: course.title,
    band: course.band,
    subject: course.subject,
    summary: course.summary,
    url: course.url,
    entries: course.entries,
  });
}

export function getMediaUrls(itemId: string, kinds?: MediaKind[]) {
  const item = itemById(itemId);
  if (!item) throw new ToolError(`Unknown item_id "${itemId}".`);
  const allowed = kinds && kinds.length > 0 ? new Set(kinds) : null;
  if (allowed) {
    for (const kind of allowed) {
      if (!(MEDIA_KINDS as readonly string[]).includes(kind)) {
        throw new ToolError(`Unknown media kind "${kind}".`);
      }
    }
  }
  const media = item.media.filter((entry) => (allowed ? allowed.has(entry.kind) : true));
  return versioned({
    item_id: item.id,
    title: item.title,
    url: item.url,
    media,
  });
}

export interface LearnerProfile {
  age?: number;
  learning_style?: LearningStyle;
  interests?: string[];
}

export function getLessonPlanSeed(itemId: string, learnerProfile?: LearnerProfile) {
  const item = itemById(itemId);
  if (!item) throw new ToolError(`Unknown item_id "${itemId}".`);
  const discussion = [
    ...(item.dinnerQuestion ? [item.dinnerQuestion] : []),
    ...(item.prompts ?? []),
  ];
  if (discussion.length === 0) {
    for (const chapter of item.chapters.slice(0, 5)) {
      discussion.push(`What is the point of "${chapter.title}"?`);
    }
  }
  const objectives = item.objective
    ? [item.objective]
    : [`Read and discuss: ${item.title}`];
  if (item.bigIdea) objectives.push(item.bigIdea);
  const printableLinks = item.media
    .filter((media) => media.kind === "pdf" || media.kind === "epub")
    .map((media) => ({
      kind: media.kind,
      url: media.url,
      label: media.label ?? media.kind,
      bytes: media.bytes,
    }));
  return versioned({
    item_id: item.id,
    title: item.title,
    type: item.type,
    band: item.band,
    subject: item.subject,
    figure: item.figure,
    url: item.url,
    objectives,
    hermes: item.hermes ?? null,
    discussionQuestions: discussion,
    activities: item.activities ?? [],
    cautions: item.hardEdges ?? [],
    printableLinks,
    adaptation: adapt(item, learnerProfile),
  });
}

function adapt(item: CatalogItem, profile: LearnerProfile | undefined): string | null {
  if (!profile) return null;
  const notes: string[] = [];
  if (profile.age !== undefined) {
    const band = bandForAge(profile.age);
    if (item.band && item.band !== band) {
      notes.push(
        `Learner age ${profile.age} maps to the ${band} band. This item is written for ${item.band}.`,
      );
    } else {
      notes.push(`Learner age ${profile.age} maps to the ${band} band, which matches this item.`);
    }
  }
  const style = profile.learning_style;
  if (style === "auditory") {
    const audio = item.media.filter((media) => media.kind === "mp3");
    notes.push(
      audio.length > 0
        ? `Auditory learner: start with the ${audio.length} audio file(s).`
        : "Auditory learner: no chapter audio on this item. Read the pairing line aloud.",
    );
  } else if (style === "reading") {
    notes.push("Reading learner: start with the PDF or EPUB when one is linked, then the sitting text.");
  } else if (style === "visual") {
    notes.push("Visual learner: use the printable and have the learner sketch the big idea before discussion.");
  } else if (style === "kinesthetic") {
    notes.push("Kinesthetic learner: lead with Try This before the longer reading.");
  }
  const interests = (profile.interests ?? []).map((interest) => interest.trim()).filter(Boolean);
  if (interests.length > 0) {
    notes.push(`Connect the objective to: ${interests.join(", ")}.`);
  }
  return notes.join(" ");
}

export interface RecommendArgs {
  age: number;
  learning_style: LearningStyle;
  interests?: string[];
  subjects?: SubjectId[];
  exclude_ids?: string[];
  limit?: number;
}

export function recommendForLearner(args: RecommendArgs) {
  if (!Number.isFinite(args.age)) throw new ToolError("age is required.");
  const band = bandForAge(args.age);
  const limit = clamp(args.limit, RECOMMEND_LIMIT_DEFAULT, RECOMMEND_LIMIT_MAX);
  const excluded = new Set(args.exclude_ids ?? []);
  const interests = args.interests ?? [];
  const ranked = items()
    .filter((item) => !excluded.has(item.id))
    .map((item) =>
      scoreForLearner(item, {
        band,
        learningStyle: args.learning_style,
        interests,
        subjects: args.subjects,
      }),
    )
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id))
    .slice(0, limit)
    .map((row) => ({
      item_id: row.item.id,
      title: row.item.title,
      type: row.item.type,
      band: row.item.band,
      subject: row.item.subject,
      figure: row.item.figure,
      url: row.item.url,
      score: row.score,
      rationale: row.rationale,
    }));
  return versioned({
    learner: {
      age: args.age,
      band,
      learning_style: args.learning_style,
      interests,
      subjects: args.subjects ?? [],
    },
    count: ranked.length,
    results: ranked,
  });
}

export function getCatalogInfo() {
  const catalog = loadCatalog();
  const counts: Record<string, number> = { ...catalog.counts };
  const figureCount = new Set(
    items()
      .map((item) => item.figure)
      .filter((figure): figure is string => Boolean(figure)),
  ).size;
  return versioned({
    site: catalog.site,
    counts,
    figures: figureCount,
    bands: catalog.bands.length,
    subjects: catalog.subjects.length,
    courses: courses().length,
    levelToBand: catalog.levelToBand,
    bandToLevel: catalog.bandToLevel,
    mappingNote: catalog.mappingNote,
    searchIndex: {
      version: catalog.contentVersion.searchIndexVersion,
      built: catalog.contentVersion.searchIndexBuilt,
      docCount: catalog.contentVersion.searchIndexDocCount,
    },
    license:
      "Server code is MIT, Copyright (c) 2026 SMF Works. Curriculum text is ingested from the public smfworks/wisdomforge repo (MIT) and from public PDFs on smfwisdomforge.com. Confirm content redistribution before a marketplace listing.",
    childSafety:
      "Read-only catalog. The server stores no learner profiles, names, or transcripts. Age and learning style are used only to score the current request. Recommendations stay inside the learner's age band.",
  });
}
