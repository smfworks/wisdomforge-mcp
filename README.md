# wisdomforge-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the [SMF WisdomForge](https://smfwisdomforge.com) curriculum. It exposes lessons, books, age-leveled booklets, chapter audio, demo transcripts, and the public search index to Cursor and Grok Bot.

The server stores no learner data. Age and learning style are used only to score the request in front of it. Media tools return public URLs and do not proxy file bytes.

This package is not deployed yet. The remote URL below is a placeholder until a Vercel project exists.

## Content sources

The live search index (`public/search-index.json` in [smfworks/wisdomforge](https://github.com/smfworks/wisdomforge), 1,332 documents, built 2026-09-21) is produced by `scripts/build-search-index.mjs`. That script reads markdown from `~/Documents/WisdomForge/wisdomforge/content` on an authoring machine. Those 1,332 markdown files are not in the public site repository and are not served by smfwisdomforge.com.

Full text in this server comes from three places:

1. **Curriculum TypeScript** in the site repo (`src/lib/curriculum`): lesson objects (reading, objectives, activities, Hermes prompts), book records (summary and chapter outline), and demo transcripts. Ingest imports them. `WF_SRC` defaults to `../wisdomforge-src`.
2. **Public PDFs** in `public/downloads`. Ingest runs `pdftotext` and stores an excerpt plus per-chapter text on each book and booklet. A missing local PDF can be fetched from `https://smfwisdomforge.com/downloads/<name>`. If extraction returns almost no text, ingest falls back to the sibling `.md` published next to that PDF. Those markdown files are the public manuscripts, not the private 1,332-document corpus.
3. **Search-index rows** become `index_doc` items. They are searchable through the ported BM25 index (tokenizer and ranking copied from `src/app/api/search/route.ts`) and link to the related booklet PDF when that figure has one. They do not contain the unpublished markdown body.

Media URLs are `https://smfwisdomforge.com` plus the path under `public/`. This checkout does not include `public/audio` (sparse clone). Ingest reads paths and byte sizes with `git ls-tree -r --long HEAD public/audio` and builds the MP3 URLs from that listing.

`data/catalog.json` and `data/search-index.json` are committed. A running server does not need the source clone.

Booklet filename levels follow `booklets.ts` `BAND_TO_LEVEL`, checked against age ranges in `bands.ts`:

| Booklet level | Age band | Ages |
| --- | --- | --- |
| elementary | little | 5–10 |
| middle | young | 11–14 |
| high | emerging | 15–18 |
| adult | adult | Adult |

Books whose titles name an age use that band. Other books (parent manuals, full readers, and operator books) are tagged adult. Age-leveled booklets carry the child bands.

`get_catalog_info` reports `content_version`: the wisdomforge git SHA plus the search-index `built` time.

## Tools

Every tool is read-only (`readOnlyHint: true`), returns text content and `structuredContent`, and includes `content_version`. Resource template: `wisdomforge://item/{id}` (same payload as `get_item` with `include=full`).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_content` | `query`, `band?`, `subject?`, `type?`, `figure?`, `limit=10` | Ranked hits with snippet, url, item_id |
| `get_item` | `item_id`, `include=summary\|full\|chapters` | Metadata, body or outline, media, Hermes prompt |
| `list_age_bands` | — | 4 bands, age ranges, level mapping |
| `list_subjects` | `band?` | 10 subjects with counts |
| `list_by_age_band` | `band`, `subject?`, `type?`, `cursor?`, `limit?` | Paged items and `nextCursor` |
| `list_courses` | `band?`, `subject?` | Books and lesson tracks, ordered item ids |
| `get_course_outline` | `course_id` | Ordered chapters or sittings with item ids |
| `get_media_urls` | `item_id`, `kinds?` | Public URLs, MIME type, size when known |
| `get_lesson_plan_seed` | `item_id`, `learner_profile?` `{age, learning_style, interests}` | Objectives, Hermes pairing line and prompt, discussion questions, printables |
| `recommend_for_learner` | `age`, `learning_style` (`visual\|auditory\|reading\|kinesthetic`), `interests[]`, `subjects?`, `exclude_ids?`, `limit?` | Deterministic ranking and a rationale. No model call |
| `get_catalog_info` | — | Counts, content version, license note |

`recommend_for_learner` keeps results inside the age band: through 10 little, 11–14 young, 15–18 emerging, 19 and over adult. Auditory learners are boosted toward MP3s, reading learners toward books and PDFs, visual learners toward images and art, kinesthetic learners toward lessons with a Try This.

## Cursor

Stdio, after this package is published:

```json
{
  "mcpServers": {
    "wisdomforge": {
      "command": "npx",
      "args": ["-y", "wisdomforge-mcp"]
    }
  }
}
```

Stdio from a local checkout (build first):

```json
{
  "mcpServers": {
    "wisdomforge": {
      "command": "node",
      "args": ["/absolute/path/to/wisdomforge-mcp/dist/stdio.js"]
    }
  }
}
```

Remote URL, once deployed (placeholder until then):

```json
{
  "mcpServers": {
    "wisdomforge": {
      "url": "https://wisdomforge-mcp.vercel.app/mcp"
    }
  }
}
```

Put that object in `.cursor/mcp.json` in the project, or in Cursor’s user MCP config.

## Grok Bot

Add the remote MCP URL as a plugin connection. The marketplace listing targets Grok Bot and Cursor. The endpoint is stateless Streamable HTTP at `/mcp` (rewritten to `/api/mcp`). No API key is required, and this server does not call a model.

Placeholder until deploy: `https://wisdomforge-mcp.vercel.app/mcp`

## Local development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev:http
```

`dev:http` listens on `http://127.0.0.1:3000/mcp`. Override with `PORT` and `HOST`.

```bash
npm run typecheck
npm test
npm run build
npm run smoke
```

`smoke` builds nothing by itself. Run `npm run build` first. It spawns `dist/stdio.js`, expects 11 tools, calls every tool, then does the same check against the HTTP handler.

The stdio bin is `wisdomforge-mcp` (`node dist/stdio.js`).

## Vercel

Not deployed yet. When you are ready:

1. Push the repo to GitHub under the `smfworks` org (this workspace does not push).
2. Import the project in Vercel. Framework preset: Other. Install command: `npm ci`. Build command can be empty; the function is `api/mcp.ts` and reads `data/` at runtime.
3. Do not add a model API key. None is used.
4. `vercel.json` rewrites `/mcp` to `/api/mcp` and includes `data/**` in the function bundle.
5. Deploy. The public URL will look like `https://<project>.vercel.app/mcp`. Replace the placeholder in this README and in the marketplace form.
6. Confirm `POST /mcp` with an MCP `initialize` returns a result, and that `GET` and `DELETE` respond (stateless servers answer those with 405).

The handler creates a new server and transport for every request. Nothing about the learner is written to disk or to a session.

## Refresh the catalog

From a machine that has the wisdomforge checkout and `pdftotext` (poppler):

```bash
WF_SRC=../wisdomforge-src npm run ingest
```

Ingest records the source git SHA, copies `public/search-index.json`, and rewrites `data/catalog.json`. Commit `data/` afterward. CI does not re-run ingest; it tests the committed catalog.

If `booklets.ts` changes `BAND_TO_LEVEL`, ingest fails until `src/types.ts` is updated to match.

## Marketplace checklist

Form: [https://x.ai/bot/marketplace/submit-a-plugin](https://x.ai/bot/marketplace/submit-a-plugin)

- Org handle: `smfworks`
- Website: `https://smfwisdomforge.com`
- Logo: `assets/logo.svg` is a 1:1 mark with a solid background plate. Export a PNG from it if the form requires one.
- Listing targets: Grok Bot and Cursor (the form also mentions Grok as coming soon)
- Public HTTPS MCP URL: the deployed `/mcp` URL. The placeholder `https://wisdomforge-mcp.vercel.app/mcp` is not live yet.
- License: this repository is MIT, Copyright (c) 2026 SMF Works. The curriculum repo is also MIT. Confirm content redistribution before submitting.
- Child safety: the plugin is read-only, holds no learner profiles, and does not ask for names, schools, or photos. Recommendations stay in the requested age band. Say that on the listing.

## License

MIT. Copyright (c) 2026 SMF Works. See [LICENSE](LICENSE).
