/**
 * Build data/catalog.json and data/search-index.json from a wisdomforge checkout.
 *
 * WF_SRC defaults to ../wisdomforge-src. Runtime does not need that checkout;
 * commit data/ after ingest.
 *
 * Text for books and booklets comes from pdftotext on the public PDFs.
 * If a PDF is missing locally it is fetched from https://smfwisdomforge.com.
 * If extraction is almost empty, the sibling public .md is used instead.
 * Those .md files are published manuscripts, not the private 1,332-document corpus.
 *
 * config/blocked-terms.json lists words to drop from catalog text, titles, and
 * excerpts, and tokens to drop from the search index. The rest of each document stays.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { filterJsonStrings, filterSearchIndex, loadBlockedTerms } from "./blocked-terms.js";
import type {
  Activity,
  BandId,
  CatalogFile,
  CatalogItem,
  Chapter,
  LevelId,
  MediaKind,
  MediaLink,
  SearchIndexFile,
  SubjectId,
} from "../src/types.js";
import {
  BAND_TO_LEVEL,
  BANDS,
  LEVEL_LABEL,
  LEVEL_TO_BAND,
  SITE,
  SUBJECTS,
} from "../src/types.js";

const execFileAsync = promisify(execFile);

const EXCERPT_LEN = 1000;
const TEXT_LEN = 12000;
const CHAPTER_LEN = 2000;
const MAX_CHAPTERS = 20;

const OPERATOR_SLUGS = new Set([
  "hermes-ai-for-beginners",
  "hermes-mastery",
  "ai-agents-projects-for-beginners",
  "openclaw-for-beginners",
]);

const GENERIC_FIGURES = new Set(["student", "parent-teacher", "parent-operator", "child"]);

const FIGURE_ALIASES: Record<string, string> = {
  "declaration-of-independence": "declaration-independence",
};

interface SourceBand {
  id: BandId;
  ages: string;
  name: string;
  ritual: string;
  sitting: string;
  promise: string;
  aiRule: string;
  hermes: string;
}

interface SourceSubject {
  id: SubjectId;
  name: string;
  short: string;
  promise: string;
  aiSpine: string;
}

interface SourcePath {
  id: string;
  name: string;
  promise: string;
  subjects: SubjectId[];
  startSlug: string;
}

interface SourceUnit {
  id: string;
  subject: SubjectId;
  title: string;
  status: string;
  bands: BandId[];
  weeks: string;
  blurb: string;
}

interface SourceLesson {
  slug: string;
  subject: SubjectId;
  band: BandId;
  unit: string;
  number: number;
  title: string;
  dek: string;
  durationMin: number;
  ritual: string;
  objective: string;
  parentBriefing: string;
  hardEdges: string[];
  reading: { heading: string; body: string }[];
  bigIdea: string;
  tryThis: Activity[];
  dinnerQuestion: string;
  ifTheySay: { heard: string; reply: string }[];
  integrity: string;
  aiLab: { setup: string; childDoes: string; evaluate: string[] };
  hermes: { allowedTools: string[]; pairingLine: string; prompt: string };
}

interface SourceBookChapter {
  number: number;
  label: string;
  title: string;
  question: string;
}

interface SourceBookFigure {
  slug: string;
  name: string;
}

interface SourceBook {
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  chapters: SourceBookChapter[];
  figures: SourceBookFigure[];
  authors: string[];
  pdfHref?: string;
  epubHref?: string;
  mdHref?: string;
  coverImage?: string;
  catalogSubject?: SubjectId;
  academySubject?: SubjectId;
}

interface SourceDemoSection {
  label: string;
  context?: string;
  kind: "dialogue" | "prose";
  turns?: { speaker: string; text: string }[];
  body?: string;
}

interface SourceDemo {
  slug: string;
  title: string;
  excerpt: string;
  band: BandId;
  subject: SubjectId;
  unit: string;
  lessonSlug: string;
  sections: SourceDemoSection[];
  reflect: string;
}

interface Extracted {
  text: string;
  source: "pdf" | "markdown" | "none";
}

interface BookletFiles {
  figure: string;
  level: LevelId;
  pdf?: { abs: string; bytes: number; publicPath: string };
  epub?: { abs: string; bytes: number; publicPath: string };
  md?: { abs: string; bytes: number; publicPath: string };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function unwrap(raw: string): string {
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    paragraphs.push(buf.join(" ").replace(/\s+/g, " ").trim());
    buf = [];
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) flush();
    else buf.push(line.trim());
  }
  flush();
  return paragraphs.join("\n\n");
}

function isSubject(value: string | undefined): value is SubjectId {
  return Boolean(value && (SUBJECTS as readonly string[]).includes(value));
}

function isBand(value: string): value is BandId {
  return (BANDS as readonly string[]).includes(value);
}

function siteUrl(publicPath: string): string {
  const path = publicPath.startsWith("/") ? publicPath : `/${publicPath}`;
  return `${SITE}${path}`;
}

function mimeFor(kind: MediaKind, filePath: string): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "epub") return "application/epub+zip";
  if (kind === "mp3") return "audio/mpeg";
  if (kind === "markdown") return "text/markdown";
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function kindForExt(ext: string): MediaKind | null {
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if (ext === ".mp3") return "mp3";
  if (ext === ".md") return "markdown";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg" || ext === ".gif") {
    return "image";
  }
  return null;
}

function mediaLink(publicPath: string, bytes?: number, label?: string): MediaLink | null {
  const kind = kindForExt(extname(publicPath).toLowerCase());
  if (!kind) return null;
  const link: MediaLink = {
    kind,
    url: siteUrl(publicPath),
    mime: mimeFor(kind, publicPath),
  };
  if (bytes !== undefined) link.bytes = bytes;
  if (label) link.label = label;
  return link;
}

function addMedia(item: CatalogItem, link: MediaLink | null): void {
  if (!link) return;
  if (item.media.some((entry) => entry.kind === link.kind && entry.url === link.url)) return;
  item.media.push(link);
}

function displayFigure(slug: string, figureDisplayName: (figure: string) => string): string {
  const name = figureDisplayName(slug);
  if (name !== slug) return name;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function bandsForBook(slug: string, title: string): BandId {
  if (OPERATOR_SLUGS.has(slug)) return "adult";
  const blob = `${slug} ${title}`.toLowerCase();
  if (/\blittle\b/.test(blob)) return "little";
  if (/\byoung\b/.test(blob)) return "young";
  if (/\bemerging\b/.test(blob)) return "emerging";
  if (/\badults?\b/.test(blob)) return "adult";
  return "adult";
}

function canonicalFigure(figure: string): string {
  return FIGURE_ALIASES[figure] ?? figure;
}

function splitChapters(raw: string): Chapter[] {
  const chunks: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim().replace(/^#{1,6}\s+/, "");
    const isChapter = /^chapter\s+\d+\b/i.test(trimmed) && trimmed.length < 160 && !/^illustration\b/i.test(trimmed);
    if (isChapter) {
      current = { title: trimmed.replace(/\s+/g, " "), lines: [] };
      chunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return chunks
    .map((chunk, index) => ({
      number: index + 1,
      label: `Chapter ${index + 1}`,
      title: chunk.title,
      text: clip(unwrap(chunk.lines.join("\n")), CHAPTER_LEN),
    }))
    .filter((chapter) => (chapter.text?.length ?? 0) > 40)
    .slice(0, MAX_CHAPTERS);
}

function chaptersFromOutline(outline: SourceBookChapter[], raw: string): Chapter[] {
  const lower = raw.toLowerCase();
  const found: { index: number; chapter: SourceBookChapter }[] = [];
  for (const chapter of outline) {
    const needle = chapter.title.trim().toLowerCase();
    if (needle.length < 4) continue;
    const index = lower.indexOf(needle);
    if (index >= 0) found.push({ index, chapter });
  }
  found.sort((a, b) => a.index - b.index);
  if (found.length >= Math.min(3, outline.length) && found.length > 0) {
    return found.slice(0, MAX_CHAPTERS).map((entry, index) => {
      const end = found[index + 1]?.index ?? raw.length;
      const text = clip(unwrap(raw.slice(entry.index, end)), CHAPTER_LEN);
      return {
        number: entry.chapter.number,
        label: entry.chapter.label,
        title: entry.chapter.title,
        text: text || (entry.chapter.question ? `Question: ${entry.chapter.question}` : undefined),
      };
    });
  }
  const split = splitChapters(raw);
  if (split.length >= 2) {
    return outline.slice(0, MAX_CHAPTERS).map((chapter, index) => ({
      number: chapter.number,
      label: chapter.label,
      title: chapter.title,
      text: split[index]?.text || (chapter.question ? `Question: ${chapter.question}` : undefined),
    }));
  }
  return outline.slice(0, MAX_CHAPTERS).map((chapter) => ({
    number: chapter.number,
    label: chapter.label,
    title: chapter.title,
    text: chapter.question ? `Question: ${chapter.question}` : undefined,
  }));
}

function lessonText(lesson: SourceLesson): string {
  const parts = [
    lesson.title,
    lesson.dek,
    `Objective: ${lesson.objective}`,
    `Parent briefing: ${lesson.parentBriefing}`,
    lesson.hardEdges.length > 0 ? `Hard edges:\n${lesson.hardEdges.map((edge) => `- ${edge}`).join("\n")}` : "",
    ...lesson.reading.map((section) => `## ${section.heading}\n${section.body}`),
    `Big idea: ${lesson.bigIdea}`,
    ...lesson.tryThis.map(
      (activity) => `Try this: ${activity.title} (${activity.minutes} min)\n${activity.steps.map((step) => `- ${step}`).join("\n")}`,
    ),
    `Dinner question: ${lesson.dinnerQuestion}`,
    lesson.integrity,
    `AI lab: ${lesson.aiLab.setup} ${lesson.aiLab.childDoes}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function demoText(demo: SourceDemo): string {
  const parts = [demo.title, demo.excerpt];
  for (const section of demo.sections) {
    const body = section.kind === "prose"
      ? section.body ?? ""
      : (section.turns ?? []).map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
    parts.push(`## ${section.label}\n${section.context ? `${section.context}\n` : ""}${body}`);
  }
  parts.push(`Reflect: ${demo.reflect}`);
  return parts.join("\n\n");
}

function pdftotextAvailable(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}

async function ensurePdf(abs: string, publicPath: string): Promise<{ path: string; bytes: number } | null> {
  if (existsSync(abs)) {
    return { path: abs, bytes: statSync(abs).size };
  }
  const url = siteUrl(publicPath);
  log(`fetch ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    log(`missing ${publicPath} (${response.status})`);
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const dest = join(tmpdir(), "wisdomforge-mcp-ingest", publicPath.replace(/\//g, "_"));
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, bytes);
  return { path: dest, bytes: bytes.length };
}

async function pdftotext(pdfPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "pdftotext",
    ["-q", "-enc", "UTF-8", "-nopgbrk", pdfPath, "-"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 90_000 },
  );
  return stdout;
}

async function extractPdf(abs: string, publicPath: string): Promise<Extracted> {
  const file = await ensurePdf(abs, publicPath);
  if (file && pdftotextAvailable()) {
    try {
      const text = await pdftotext(file.path);
      if (text.trim().length >= 200) return { text, source: "pdf" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`pdftotext failed for ${publicPath}: ${message.split("\n")[0]}`);
    }
  }
  const mdAbs = abs.replace(/\.pdf$/i, ".md");
  if (existsSync(mdAbs)) {
    return { text: readFileSync(mdAbs, "utf8"), source: "markdown" };
  }
  return { text: "", source: "none" };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function verifyLevelMapping(bookletSource: string): void {
  for (const band of BANDS) {
    const level = BAND_TO_LEVEL[band];
    const pattern = new RegExp(`${band}:\\s*"${level}"`);
    if (!pattern.test(bookletSource)) {
      throw new Error(
        `Level mapping drift: expected ${band} -> ${level} in booklets.ts BAND_TO_LEVEL. Update src/types.ts after checking bands.ts ages.`,
      );
    }
  }
}

function lessonId(band: BandId, subject: SubjectId, slug: string): string {
  return `lesson:${band}:${subject}:${slug}`;
}

function parseAudio(path: string, bytes: number): {
  figure: string;
  level: LevelId;
  chapter: number | null;
  base: string;
  publicPath: string;
  bytes: number;
} | null {
  if (!path.endsWith(".mp3")) return null;
  const publicPath = path.replace(/^public\//, "");
  const base = basename(path, ".mp3");
  const parts = publicPath.split("/");
  const figure = parts[1] ?? "";
  const level = (["elementary", "middle", "high", "adult"] as const).find((candidate) =>
    base.includes(`-${candidate}-`) || base.endsWith(`-${candidate}`),
  );
  if (!figure || !level) return null;
  const chapterMatch = base.match(/-ch(\d+)$/i);
  return {
    figure,
    level,
    chapter: chapterMatch ? Number(chapterMatch[1]) : null,
    base,
    publicPath: `/${publicPath}`,
    bytes,
  };
}

async function main(): Promise<void> {
  const srcRoot = resolve(process.env.WF_SRC ?? join(process.cwd(), "..", "wisdomforge-src"));
  const curriculumDir = join(srcRoot, "src", "lib", "curriculum");
  if (!existsSync(join(curriculumDir, "bands.ts"))) {
    throw new Error(`WF_SRC does not look like wisdomforge: ${srcRoot}`);
  }
  if (!pdftotextAvailable()) {
    throw new Error("pdftotext is required for ingest (poppler-utils).");
  }

  const bookletSource = readFileSync(join(curriculumDir, "booklets.ts"), "utf8");
  verifyLevelMapping(bookletSource);

  const sha = execFileSync("git", ["-C", srcRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  log(`source ${sha}`);

  const curriculum = (await import(pathToFileURL(join(curriculumDir, "index.ts")).href)) as {
    lessons: SourceLesson[];
    bands: SourceBand[];
    subjects: SourceSubject[];
    paths: SourcePath[];
    catalog: SourceUnit[];
  };
  const booksMod = (await import(pathToFileURL(join(curriculumDir, "books.ts")).href)) as {
    books: SourceBook[];
  };
  const demosMod = (await import(pathToFileURL(join(curriculumDir, "demos.ts")).href)) as {
    demos: SourceDemo[];
  };
  const bookletsMod = (await import(pathToFileURL(join(curriculumDir, "booklets.ts")).href)) as {
    figureForLesson: (slug: string) => string | null;
    figureDisplayName: (figure: string) => string;
  };

  const searchIndexPath = join(srcRoot, "public", "search-index.json");
  const searchIndexRaw = readFileSync(searchIndexPath, "utf8");
  const searchIndex = JSON.parse(searchIndexRaw) as SearchIndexFile;

  const downloadsDir = join(srcRoot, "public", "downloads");
  const bookletFiles = new Map<string, BookletFiles>();
  const looseFiles = new Map<string, { abs: string; bytes: number; publicPath: string }>();
  for (const name of readdirSync(downloadsDir)) {
    const abs = join(downloadsDir, name);
    if (!statSync(abs).isFile()) continue;
    const ext = extname(name).toLowerCase();
    const publicPath = `/downloads/${name}`;
    const bytes = statSync(abs).size;
    const match = name.match(/^(.+)-(elementary|middle|high|adult)\.(pdf|epub|md)$/i);
    if (match) {
      const figure = match[1] ?? "";
      const level = (match[2] ?? "").toLowerCase() as LevelId;
      const key = `${figure}:${level}`;
      const slot = bookletFiles.get(key) ?? { figure, level };
      if (ext === ".pdf") slot.pdf = { abs, bytes, publicPath };
      else if (ext === ".epub") slot.epub = { abs, bytes, publicPath };
      else if (ext === ".md") slot.md = { abs, bytes, publicPath };
      bookletFiles.set(key, slot);
    } else if (ext === ".pdf" || ext === ".epub" || ext === ".md") {
      looseFiles.set(publicPath, { abs, bytes, publicPath });
    }
  }

  const pdfJobs: { abs: string; publicPath: string }[] = [];
  for (const slot of bookletFiles.values()) {
    if (slot.pdf) pdfJobs.push({ abs: slot.pdf.abs, publicPath: slot.pdf.publicPath });
  }
  for (const book of booksMod.books) {
    if (!book.pdfHref) continue;
    const abs = join(srcRoot, "public", book.pdfHref.replace(/^\//, ""));
    pdfJobs.push({ abs, publicPath: book.pdfHref });
  }
  log(`extracting ${pdfJobs.length} PDFs`);
  let extractedCount = 0;
  const extractedList = await mapPool(pdfJobs, 4, async (job) => {
    const extracted = await extractPdf(job.abs, job.publicPath);
    extractedCount += 1;
    if (extractedCount % 25 === 0 || extractedCount === pdfJobs.length) {
      log(`extracted ${extractedCount}/${pdfJobs.length}`);
    }
    return { publicPath: job.publicPath, extracted };
  });
  const extractedByPath = new Map<string, Extracted>();
  for (const row of extractedList) {
    if (row) extractedByPath.set(row.publicPath, row.extracted);
  }

  const figureSubject = new Map<string, SubjectId>();
  for (const lesson of curriculum.lessons) {
    const figure = bookletsMod.figureForLesson(lesson.slug);
    if (figure && !figureSubject.has(figure)) figureSubject.set(figure, lesson.subject);
  }
  for (const book of booksMod.books) {
    const subject = book.catalogSubject ?? book.academySubject;
    if (!isSubject(subject)) continue;
    for (const figure of book.figures) {
      if (GENERIC_FIGURES.has(figure.slug)) continue;
      if (!figureSubject.has(figure.slug)) figureSubject.set(figure.slug, subject);
    }
  }

  const items: CatalogItem[] = [];
  const lessonsByFigureBand = new Map<string, CatalogItem[]>();

  for (const lesson of curriculum.lessons) {
    if (!isBand(lesson.band) || !isSubject(lesson.subject)) continue;
    const figure = bookletsMod.figureForLesson(lesson.slug);
    const text = lessonText(lesson);
    const item: CatalogItem = {
      id: lessonId(lesson.band, lesson.subject, lesson.slug),
      type: "lesson",
      band: lesson.band,
      bands: [lesson.band],
      subject: lesson.subject,
      figure,
      level: BAND_TO_LEVEL[lesson.band],
      title: lesson.title,
      summary: lesson.dek,
      excerpt: clip(text, EXCERPT_LEN),
      text,
      textSource: "curriculum",
      chapters: lesson.reading.map((section, index) => ({
        number: index + 1,
        label: `Reading ${index + 1}`,
        title: section.heading,
        text: section.body,
      })),
      media: [],
      hermes: {
        pairingLine: lesson.hermes.pairingLine,
        prompt: lesson.hermes.prompt,
        allowedTools: lesson.hermes.allowedTools,
      },
      url: `${SITE}/learn/${lesson.band}/${lesson.subject}/${lesson.slug}`,
      objective: lesson.objective,
      bigIdea: lesson.bigIdea,
      dinnerQuestion: lesson.dinnerQuestion,
      prompts: lesson.ifTheySay.map((row) => row.heard),
      activities: lesson.tryThis,
      hardEdges: lesson.hardEdges,
      unit: lesson.unit,
      number: lesson.number,
      durationMin: lesson.durationMin,
      ritual: lesson.ritual,
      lessonSlug: lesson.slug,
    };
    items.push(item);
    if (figure) {
      const key = `${figure}:${lesson.band}`;
      const list = lessonsByFigureBand.get(key) ?? [];
      list.push(item);
      lessonsByFigureBand.set(key, list);
    }
  }

  for (const book of booksMod.books) {
    const subject = book.catalogSubject ?? book.academySubject ?? null;
    const band = bandsForBook(book.slug, book.title);
    const pdf = book.pdfHref ? extractedByPath.get(book.pdfHref) : undefined;
    const plain = pdf?.text ? unwrap(pdf.text) : "";
    const chapters = chaptersFromOutline(book.chapters, pdf?.text ?? "");
    const figures = book.figures.map((figure) => figure.slug).filter((slug) => !GENERIC_FIGURES.has(slug));
    const item: CatalogItem = {
      id: `book:${book.slug}`,
      type: "book",
      band,
      bands: [band],
      subject: isSubject(subject ?? undefined) ? subject : null,
      figure: figures.length === 1 ? figures[0] ?? null : null,
      figures,
      level: BAND_TO_LEVEL[band],
      title: book.title,
      summary: book.summary,
      excerpt: clip(plain || book.summary, EXCERPT_LEN),
      text: clip(plain || book.summary, TEXT_LEN),
      textSource: pdf?.source === "pdf" || pdf?.source === "markdown" ? pdf.source : "curriculum",
      chapters,
      media: [],
      url: `${SITE}/books/${book.slug}`,
      authors: book.authors,
    };
    if (book.pdfHref) {
      const local = looseFiles.get(book.pdfHref);
      addMedia(item, mediaLink(book.pdfHref, local?.bytes, "PDF"));
    }
    if (book.epubHref) {
      const local = looseFiles.get(book.epubHref);
      addMedia(item, mediaLink(book.epubHref, local?.bytes, "EPUB"));
    }
    if (book.mdHref) {
      const local = looseFiles.get(book.mdHref);
      addMedia(item, mediaLink(book.mdHref, local?.bytes, "Markdown"));
    }
    if (book.coverImage) {
      const abs = join(srcRoot, "public", book.coverImage.replace(/^\//, ""));
      const bytes = existsSync(abs) ? statSync(abs).size : undefined;
      addMedia(item, mediaLink(book.coverImage, bytes, "Cover"));
    }
    items.push(item);
  }

  for (const slot of bookletFiles.values()) {
    if (!slot.pdf) continue;
    const band = LEVEL_TO_BAND[slot.level];
    const extracted = extractedByPath.get(slot.pdf.publicPath);
    const plain = extracted?.text ? unwrap(extracted.text) : "";
    const chapters = splitChapters(extracted?.text ?? "");
    const name = displayFigure(slot.figure, bookletsMod.figureDisplayName);
    const levelLabel = LEVEL_LABEL[slot.level];
    const item: CatalogItem = {
      id: `booklet:${slot.figure}:${band}`,
      type: "booklet",
      band,
      bands: [band],
      subject: figureSubject.get(slot.figure) ?? null,
      figure: slot.figure,
      level: slot.level,
      title: `${name} (${levelLabel})`,
      summary: plain
        ? clip(plain, 280)
        : `${levelLabel} booklet for ${name} (${band} band).`,
      excerpt: clip(plain, EXCERPT_LEN),
      text: clip(plain, TEXT_LEN),
      textSource: extracted?.source ?? "none",
      chapters,
      media: [],
      url: siteUrl(slot.pdf.publicPath),
      relatedItemIds: (lessonsByFigureBand.get(`${slot.figure}:${band}`) ?? []).map((lesson) => lesson.id),
    };
    addMedia(item, mediaLink(slot.pdf.publicPath, slot.pdf.bytes, `${levelLabel} PDF`));
    if (slot.epub) addMedia(item, mediaLink(slot.epub.publicPath, slot.epub.bytes, `${levelLabel} EPUB`));
    if (slot.md) addMedia(item, mediaLink(slot.md.publicPath, slot.md.bytes, `${levelLabel} Markdown`));
    items.push(item);
    for (const lesson of lessonsByFigureBand.get(`${slot.figure}:${band}`) ?? []) {
      for (const link of item.media) addMedia(lesson, link);
      const related = new Set(lesson.relatedItemIds ?? []);
      related.add(item.id);
      lesson.relatedItemIds = [...related];
    }
  }

  const audioListing = execFileSync(
    "git",
    ["-C", srcRoot, "ls-tree", "-r", "--long", "HEAD", "public/audio"],
    { encoding: "utf8" },
  );
  for (const line of audioListing.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const bytes = Number(meta[3]);
    const path = line.slice(tab + 1).trim();
    const audio = parseAudio(path, Number.isFinite(bytes) ? bytes : 0);
    if (!audio) continue;
    const band = LEVEL_TO_BAND[audio.level];
    const name = displayFigure(audio.figure, bookletsMod.figureDisplayName);
    const chapterLabel = audio.chapter ? `, chapter ${audio.chapter}` : "";
    const item: CatalogItem = {
      id: `audio:${audio.figure}:${audio.base}`,
      type: "audio",
      band,
      bands: [band],
      subject: figureSubject.get(audio.figure) ?? null,
      figure: audio.figure,
      level: audio.level,
      title: `${name}${chapterLabel} (${LEVEL_LABEL[audio.level]})`,
      summary: `Chapter audio for ${name}, ${LEVEL_LABEL[audio.level].toLowerCase()} (${band} band).`,
      excerpt: "",
      text: "",
      textSource: "none",
      chapters: [],
      media: [],
      url: siteUrl(audio.publicPath),
    };
    const link = mediaLink(audio.publicPath, audio.bytes, item.title);
    addMedia(item, link);
    const booklet = items.find((candidate) => candidate.id === `booklet:${audio.figure}:${band}`);
    if (booklet && link) {
      addMedia(booklet, link);
      const related = new Set(item.relatedItemIds ?? []);
      related.add(booklet.id);
      item.relatedItemIds = [...related];
    }
    for (const lesson of lessonsByFigureBand.get(`${audio.figure}:${band}`) ?? []) {
      if (link) addMedia(lesson, link);
    }
    items.push(item);
  }

  const lessonIds = new Set(items.filter((item) => item.type === "lesson").map((item) => item.id));
  for (const demo of demosMod.demos) {
    if (!isBand(demo.band) || !isSubject(demo.subject)) continue;
    const text = demoText(demo);
    const lesson = lessonIds.has(lessonId(demo.band, demo.subject, demo.lessonSlug))
      ? lessonId(demo.band, demo.subject, demo.lessonSlug)
      : undefined;
    const figure = bookletsMod.figureForLesson(demo.lessonSlug);
    const item: CatalogItem = {
      id: `demo:${demo.slug}`,
      type: "demo",
      band: demo.band,
      bands: [demo.band],
      subject: demo.subject,
      figure,
      level: BAND_TO_LEVEL[demo.band],
      title: demo.title,
      summary: demo.excerpt,
      excerpt: clip(text, EXCERPT_LEN),
      text,
      textSource: "curriculum",
      chapters: demo.sections.map((section, index) => ({
        number: index + 1,
        label: section.label,
        title: section.label,
        text: clip(
          section.kind === "prose"
            ? section.body ?? ""
            : (section.turns ?? []).map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"),
          CHAPTER_LEN,
        ),
      })),
      media: [],
      url: `${SITE}/demos/${demo.slug}`,
      unit: demo.unit,
      lessonSlug: demo.lessonSlug,
      relatedItemIds: lesson ? [lesson] : [],
      dinnerQuestion: demo.reflect,
      prompts: [demo.reflect],
    };
    items.push(item);
  }

  const bookletByFigure = new Map<string, CatalogItem[]>();
  for (const item of items) {
    if (item.type !== "booklet" || !item.figure) continue;
    const list = bookletByFigure.get(item.figure) ?? [];
    list.push(item);
    bookletByFigure.set(item.figure, list);
  }

  const usedIndexIds = new Set<string>();
  for (const doc of searchIndex.documents) {
    const figure = doc.figure;
    const linkedFigure = canonicalFigure(figure);
    let id = `index:${figure}:${doc.file}`;
    if (usedIndexIds.has(id)) id = `${id}:${doc.id}`;
    usedIndexIds.add(id);
    const related = bookletByFigure.get(linkedFigure) ?? bookletByFigure.get(figure) ?? [];
    const preferred = related.find((item) => item.level === "adult") ?? related[0];
    const item: CatalogItem = {
      id,
      type: "index_doc",
      band: null,
      bands: [],
      subject: figureSubject.get(linkedFigure) ?? figureSubject.get(figure) ?? null,
      figure,
      level: null,
      title: doc.title,
      summary: `${doc.title}. Search-index document in the ${figure} collection. The source markdown is not published.`,
      excerpt: doc.title,
      text: "",
      textSource: "index",
      chapters: [],
      media: [],
      url: preferred?.url ?? `${SITE}/library`,
      relatedItemIds: related.map((entry) => entry.id),
      indexPath: doc.path,
    };
    for (const booklet of related) {
      const pdf = booklet.media.find((media) => media.kind === "pdf");
      if (pdf) addMedia(item, { ...pdf, label: pdf.label ?? booklet.title });
    }
    items.push(item);
  }

  items.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  const counts: Record<string, number> = { total: items.length };
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  const textSources: Record<string, number> = {};
  for (const item of items) {
    if (item.type === "book" || item.type === "booklet") {
      textSources[item.textSource] = (textSources[item.textSource] ?? 0) + 1;
    }
  }

  const ageNote = curriculum.bands
    .map((band) => `${band.id} (${band.ages}) = ${BAND_TO_LEVEL[band.id]}`)
    .join("; ");
  const catalog: CatalogFile = {
    contentVersion: {
      sourceRepo: "smfworks/wisdomforge",
      sourceSha: sha,
      searchIndexVersion: searchIndex.version,
      searchIndexBuilt: searchIndex.built,
      searchIndexDocCount: searchIndex.docCount,
      ingestedAt: new Date().toISOString(),
    },
    site: SITE,
    levelToBand: LEVEL_TO_BAND,
    bandToLevel: BAND_TO_LEVEL,
    mappingNote:
      `Booklet filename levels follow booklets.ts BAND_TO_LEVEL, verified at ingest. ` +
      `Age ranges are copied from bands.ts: ${ageNote}. ` +
      `Books whose titles name an age use that band. Other books (parent manuals, full readers, operator books) are tagged adult; age-leveled booklets carry the child bands.`,
    bands: curriculum.bands.map((band) => ({
      id: band.id,
      name: band.name,
      ages: band.ages,
      level: BAND_TO_LEVEL[band.id],
      levelLabel: LEVEL_LABEL[BAND_TO_LEVEL[band.id]],
      promise: band.promise,
      sitting: band.sitting,
      ritual: band.ritual,
      aiRule: band.aiRule,
      hermes: band.hermes,
    })),
    subjects: curriculum.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      short: subject.short,
      promise: subject.promise,
      aiSpine: subject.aiSpine,
    })),
    paths: curriculum.paths.map((path) => ({
      id: path.id,
      name: path.name,
      promise: path.promise,
      subjects: path.subjects,
      startSlug: path.startSlug,
    })),
    units: curriculum.catalog.map((unit) => ({
      id: unit.id,
      subject: unit.subject,
      title: unit.title,
      status: unit.status,
      bands: unit.bands,
      weeks: unit.weeks,
      blurb: unit.blurb,
    })),
    counts,
    items,
  };

  const terms = loadBlockedTerms();
  const catalogOut = filterJsonStrings(catalog, terms);
  const indexOut = filterSearchIndex(searchIndex, terms);

  const outDir = join(process.cwd(), "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "catalog.json"), `${JSON.stringify(catalogOut)}\n`);
  const indexSuffix = searchIndexRaw.endsWith("\n") ? "\n" : "";
  writeFileSync(join(outDir, "search-index.json"), `${JSON.stringify(indexOut)}${indexSuffix}`);

  const catalogBytes = statSync(join(outDir, "catalog.json")).size;
  const indexBytes = statSync(join(outDir, "search-index.json")).size;
  process.stdout.write(
    `${JSON.stringify({ sha, counts, textSources, catalogBytes, indexBytes, searchIndexBuilt: searchIndex.built }, null, 2)}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
