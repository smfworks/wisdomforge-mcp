export const BANDS = ["little", "young", "emerging", "adult"] as const;
export type BandId = (typeof BANDS)[number];

export const SUBJECTS = [
  "ai",
  "thinking",
  "philosophy",
  "math",
  "science",
  "english",
  "history",
  "art",
  "cs",
  "language",
] as const;
export type SubjectId = (typeof SUBJECTS)[number];

export const ITEM_TYPES = [
  "lesson",
  "book",
  "booklet",
  "audio",
  "demo",
  "index_doc",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const LEVELS = ["elementary", "middle", "high", "adult"] as const;
export type LevelId = (typeof LEVELS)[number];

export const LEARNING_STYLES = [
  "visual",
  "auditory",
  "reading",
  "kinesthetic",
] as const;
export type LearningStyle = (typeof LEARNING_STYLES)[number];

export const MEDIA_KINDS = ["pdf", "epub", "mp3", "image", "markdown"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const SITE = "https://smfwisdomforge.com";

/**
 * Booklet filename levels map onto age bands.
 * Source of truth in the curriculum repo: booklets.ts BAND_TO_LEVEL.
 * Age ranges come from bands.ts and line up with elementary / middle / high / adult.
 */
export const LEVEL_TO_BAND: Record<LevelId, BandId> = {
  elementary: "little",
  middle: "young",
  high: "emerging",
  adult: "adult",
};

export const BAND_TO_LEVEL: Record<BandId, LevelId> = {
  little: "elementary",
  young: "middle",
  emerging: "high",
  adult: "adult",
};

export const LEVEL_LABEL: Record<LevelId, string> = {
  elementary: "Elementary",
  middle: "Middle",
  high: "High School",
  adult: "Adult",
};

export interface ContentVersion {
  sourceRepo: string;
  sourceSha: string;
  searchIndexVersion: number;
  searchIndexBuilt: string;
  searchIndexDocCount: number;
  ingestedAt: string;
}

export interface MediaLink {
  kind: MediaKind;
  url: string;
  mime: string;
  bytes?: number;
  label?: string;
}

export interface Chapter {
  number: number;
  label: string;
  title: string;
  text?: string;
}

export interface HermesBlock {
  pairingLine: string;
  prompt: string;
  allowedTools: string[];
}

export interface Activity {
  title: string;
  minutes: number;
  steps: string[];
}

export interface CatalogItem {
  id: string;
  type: ItemType;
  band: BandId | null;
  bands: BandId[];
  subject: SubjectId | null;
  figure: string | null;
  figures?: string[];
  level: LevelId | null;
  title: string;
  summary: string;
  excerpt: string;
  text: string;
  textSource: "curriculum" | "pdf" | "markdown" | "index" | "none";
  chapters: Chapter[];
  media: MediaLink[];
  hermes?: HermesBlock;
  url: string;
  relatedItemIds?: string[];
  objective?: string;
  bigIdea?: string;
  dinnerQuestion?: string;
  prompts?: string[];
  activities?: Activity[];
  hardEdges?: string[];
  unit?: string;
  number?: number;
  durationMin?: number;
  ritual?: string;
  authors?: string[];
  lessonSlug?: string;
  /** Path inside the search index, for index_doc items. */
  indexPath?: string;
}

export interface BandRecord {
  id: BandId;
  name: string;
  ages: string;
  level: LevelId;
  levelLabel: string;
  promise: string;
  sitting: string;
  ritual: string;
  aiRule: string;
  hermes: string;
}

export interface SubjectRecord {
  id: SubjectId;
  name: string;
  short: string;
  promise: string;
  aiSpine: string;
}

export interface PathRecord {
  id: string;
  name: string;
  promise: string;
  subjects: SubjectId[];
  startSlug: string;
}

export interface UnitRecord {
  id: string;
  subject: SubjectId;
  title: string;
  status: string;
  bands: BandId[];
  weeks: string;
  blurb: string;
}

export interface CatalogFile {
  contentVersion: ContentVersion;
  site: string;
  levelToBand: Record<LevelId, BandId>;
  bandToLevel: Record<BandId, LevelId>;
  mappingNote: string;
  bands: BandRecord[];
  subjects: SubjectRecord[];
  paths: PathRecord[];
  units: UnitRecord[];
  counts: Record<string, number>;
  items: CatalogItem[];
}

export interface SearchDocument {
  id: number;
  path: string;
  figure: string;
  file: string;
  title: string;
  len: number;
}

export interface SearchPostingEntry {
  t: string;
  p: number[];
  idf: number;
}

export interface SearchIndexFile {
  version: number;
  built: string;
  docCount: number;
  documents: SearchDocument[];
  index: SearchPostingEntry[];
}

export interface CourseEntry {
  order: number;
  title: string;
  itemId: string;
  chapterNumber?: number;
}

export interface Course {
  id: string;
  kind: "track" | "book";
  title: string;
  band: BandId | null;
  subject: SubjectId | null;
  summary: string;
  weeks?: string;
  status?: string;
  itemId: string;
  url: string;
  entries: CourseEntry[];
}
