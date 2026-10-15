import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { contentVersion } from "./catalog.js";
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
  searchContent,
  ToolError,
} from "./tools.js";
import { BANDS, ITEM_TYPES, LEARNING_STYLES, SUBJECTS } from "./types.js";

export const TOOL_NAMES = [
  "search_content",
  "get_item",
  "list_age_bands",
  "list_subjects",
  "list_by_age_band",
  "list_courses",
  "get_course_outline",
  "get_media_urls",
  "get_lesson_plan_seed",
  "recommend_for_learner",
  "get_catalog_info",
] as const;

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const BandSchema = z.enum(BANDS);
const SubjectSchema = z.enum(SUBJECTS);
const TypeSchema = z.enum(ITEM_TYPES);
const StyleSchema = z.enum(LEARNING_STYLES);
const KindSchema = z.enum(["pdf", "epub", "mp3", "image", "markdown"]);

function wrap(data: object): CallToolResult {
  const payload = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof ToolError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Tool failed";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      error: message,
      content_version: contentVersion(),
    },
  };
}

async function run(fn: () => object): Promise<CallToolResult> {
  try {
    return wrap(fn());
  } catch (err) {
    return fail(err);
  }
}

export function createWisdomForgeServer(): McpServer {
  const server = new McpServer(
    { name: "wisdomforge", version: "1.0.0" },
    {
      instructions:
        "Read-only catalog of SMF WisdomForge lessons, books, booklets, audio, demos, and search-index documents. " +
        "Do not send a learner's name, school, photo, or other personal data. This server stores nothing between calls. " +
        "Recommendations stay inside the age band for the given age. Media tools return public URLs; they do not proxy file bytes.",
    },
  );

  server.registerTool(
    "search_content",
    {
      title: "Search content",
      description:
        "Rank WisdomForge items for a query. Uses the site's BM25 search index for corpus documents and the same tokenizer over catalog titles and excerpts. Optional filters: band, subject, type, figure. Default limit 10.",
      inputSchema: {
        query: z.string().describe("Search text"),
        band: BandSchema.optional().describe("Age band: little, young, emerging, or adult"),
        subject: SubjectSchema.optional(),
        type: TypeSchema.optional(),
        figure: z.string().optional().describe("Figure slug, for example epictetus"),
        limit: z.number().int().min(1).max(50).optional().describe("Max hits, default 10"),
      },
      annotations: READONLY,
    },
    async (args) => run(() => searchContent(args)),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Fetch one catalog item. include=summary returns metadata, a short excerpt, media, and the Hermes prompt. include=chapters adds chapter text. include=full adds the stored body text.",
      inputSchema: {
        item_id: z.string(),
        include: z.enum(["summary", "full", "chapters"]).optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => getItem(args.item_id, args.include ?? "summary")),
  );

  server.registerTool(
    "list_age_bands",
    {
      title: "List age bands",
      description:
        "The four WisdomForge age bands with age ranges, promises, and the booklet level mapping (elementary, middle, high, adult).",
      inputSchema: {},
      annotations: READONLY,
    },
    async () => run(() => listAgeBands()),
  );

  server.registerTool(
    "list_subjects",
    {
      title: "List subjects",
      description:
        "The ten subjects with item counts. Pass band to count only items in that age band. Index documents are not counted.",
      inputSchema: {
        band: BandSchema.optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => listSubjects(args.band)),
  );

  server.registerTool(
    "list_by_age_band",
    {
      title: "List by age band",
      description:
        "Page lessons, books, booklets, audio, and demos for one age band. Optional subject and type filters. cursor is opaque; pass nextCursor back for the next page. Default limit 20.",
      inputSchema: {
        band: BandSchema,
        subject: SubjectSchema.optional(),
        type: TypeSchema.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => listByAgeBand(args)),
  );

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "Books and lesson tracks in title order. A course is a book or a subject unit's sittings for one band. Each row includes ordered item ids.",
      inputSchema: {
        band: BandSchema.optional(),
        subject: SubjectSchema.optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => listCourses(args)),
  );

  server.registerTool(
    "get_course_outline",
    {
      title: "Get course outline",
      description:
        "Ordered chapters or sittings for a course_id from list_courses. Each entry has an item_id.",
      inputSchema: {
        course_id: z.string(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => getCourseOutline(args.course_id)),
  );

  server.registerTool(
    "get_media_urls",
    {
      title: "Get media URLs",
      description:
        "Public media URLs for an item (pdf, epub, mp3, image, markdown), with MIME type and size when known. The server does not proxy bytes. kinds filters the list; omit it for every kind on the item.",
      inputSchema: {
        item_id: z.string(),
        kinds: z.array(KindSchema).optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => getMediaUrls(args.item_id, args.kinds)),
  );

  server.registerTool(
    "get_lesson_plan_seed",
    {
      title: "Get lesson plan seed",
      description:
        "Objectives, Hermes pairing line and prompt, discussion questions, activities, cautions, and printable links for an item. learner_profile is optional and is not stored.",
      inputSchema: {
        item_id: z.string(),
        learner_profile: z
          .object({
            age: z.number().int().min(0).max(120).optional(),
            learning_style: StyleSchema.optional(),
            interests: z.array(z.string()).optional(),
          })
          .optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => getLessonPlanSeed(args.item_id, args.learner_profile)),
  );

  server.registerTool(
    "recommend_for_learner",
    {
      title: "Recommend for learner",
      description:
        "Deterministic ranking for one request. Age maps to a band (through 10 little, 11–14 young, 15–18 emerging, 19+ adult). Other bands are excluded. Auditory learners are boosted toward audio, reading learners toward books and printables, visual learners toward images and art, kinesthetic learners toward lessons with a Try This. No model is called and nothing is stored.",
      inputSchema: {
        age: z.number().int().min(0).max(120),
        learning_style: StyleSchema,
        interests: z.array(z.string()).optional(),
        subjects: z.array(SubjectSchema).optional(),
        exclude_ids: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: READONLY,
    },
    async (args) => run(() => recommendForLearner(args)),
  );

  server.registerTool(
    "get_catalog_info",
    {
      title: "Get catalog info",
      description:
        "Counts by item type, content version (source git SHA and search-index build time), level mapping, and the license and child-safety notes.",
      inputSchema: {},
      annotations: READONLY,
    },
    async () => run(() => getCatalogInfo()),
  );

  server.registerResource(
    "item",
    new ResourceTemplate("wisdomforge://item/{id}", { list: undefined }),
    {
      description: "One catalog item as JSON. Mirrors get_item with include=full.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? "" : String(raw ?? ""));
      const payload = getItem(id, "full");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );

  return server;
}
