---
name: report-anything
description: Turn data (JSON, CSV, API payloads, query results) into a validated, paginated report — web page or print/PDF — by writing a ReportSpec JSON instead of UI code. Use when asked to build a report, analysis write-up, KPI summary or chart document from data, or to revise an existing ReportSpec.
---

# report-anything

You write **what** to show as a `ReportSpec` JSON: datasets, sections, blocks. The engine decides **how**: it computes every number from the data, composes each section (feature, sidebar, hero, grid, pairs), estimates heights, paginates, and renders. You never write HTML, CSS, coordinates or page breaks.

CLI: `report-anything <command>` (in this repo: `node packages/cli/dist/bin.js <command>`; build first with `pnpm build`). Every command prints JSON; issues carry `path`, `message` and an actionable `hint`.

## Steps

1. **Profile the data.** Save it to a file and run `report-anything profile data.json` (or `.csv`; `--path a.b` for a nested array). Read field `role`s (time / measure / dimension / identifier), cardinalities, `suggestedFormat`s and ranked chart suggestions. Done when you can name the primary measure, the time field (if any) and the 1–3 dimensions worth breaking down.
2. **Decide the questions.** Write down, in one line each, the 3–6 questions the report answers, in reading order (headline → trend → breakdown → detail → actions). Every block you add must answer one of them.
3. **Write the spec.** Optional starting point: `report-anything auto data.json --shape <overview|brief|trend|compare|breakdown|bridge> --title "…" -o spec.json` — pick the shape that matches the question (why did X change → `bridge`; this vs last period → `compare`), then rewrite it around your questions. Rules:
   - Put raw data in one dataset; derive every aggregate with `from` + `transform` (`aggregate`, `filter`, `window`, `timeUnit`, `top`, `fold`, `pivot`, `lookup`, `derive`). Compute in the data layer, not in your head.
   - Numbers in prose and KPIs are **bound**, never typed: KPI `value`/`compareTo` are Measures `{ "data", "field", "agg", "where" }`; text uses `{{sum(sales.revenue) | currency:KRW}}`. A literal number in a spec is a hallucination risk.
   - Give fields `label` and `format` in `datasets.<id>.fields` once; charts, tables and templates reuse them.
   - Steer the layout with `importance` (`lead` for the block that carries a section, `supporting` for notes and callouts) and reading order, not `span`. Open with a `stat` when one number is the story. Choose a section `layout` (`feature`, `sidebar`, `grid`, …) only when the auto composition is wrong for the content.
4. **Validate until clean.** `report-anything validate spec.json`. Fix every error using its `hint` (did-you-mean field names, wrong encodings). Done when `"ok": true` with zero errors.
5. **Inspect the layout.** `report-anything inspect spec.json --mode print` shows each section's compositions, each block's placement, estimated height, page and layout diagnostics (`block_too_tall`, `page_target_exceeded`). Fix by cutting blocks, `height: "sm"`, `maxRows`, `limit` or `importance` — not by adding `span`s. Done when diagnostics are empty or each remaining one is a deliberate choice.
6. **Render.** `report-anything render spec.json -o report.html` (`--mode print` for paginated sheets; print to PDF from the browser). Single chart preview: `report-anything chart spec.json <blockId> -o chart.svg`.
7. **Revise with ops, not rewrites.** For "make the second chart a table" or "shorten the conclusion", write JSONL ops and run `report-anything apply spec.json ops.jsonl -o spec.json`. Ops are id-addressed and transactional: `setReport`, `setDataset`, `removeDataset`, `addSection`, `updateSection`, `removeSection`, `moveSection`, `addBlock`, `updateBlock` (deep merge, `null` deletes), `replaceBlock`, `removeBlock`, `moveBlock`. Re-run step 4.

## Editorial rules

A report is a document someone reads top to bottom, not a widget inventory.

- One chart per question. Never chart the same dimension twice, and never repeat a total already shown in a KPI unless the new view adds a comparison.
- Every comparison states its baseline: KPI `compareTo` + `deltaLabel` ("vs last year"), comparison `entities`.
- Charts with ≤ 2 categories become a sentence; > 12 categories get `limit` + `others` or a horizontal bar; exact lookups belong in a `table`.
- Never put measures with different units or magnitudes on one axis; use `secondary` only for a rate next to an amount.
- Text next to a chart says what the chart does not: the cause, the exception, the decision. Callouts carry a `variant` (`insight`, `risk`, `recommendation`, `note`) so their role is in words.
- Table `emphasis` (`bar`, `heat`, `delta`) only where the encoding answers a question; `delta` for signed changes.
- Pick the chart for the question: change between two totals → `waterfall`; drop-off through ordered stages → `funnel`; before/after per category → `dumbbell`; share of a whole (≤ 6 parts) → `donut`; everything else usually `bar` or `line`.
- Processes, escalation paths, org or data structures → a `diagram` block with Mermaid source, never an image or ASCII art.

## Reference

- Block, chart, transform and format cheat sheet with a full example: [reference.md](reference.md).
- Exact schema (field names, enums, descriptions): `report-anything schema` (report) and `report-anything schema op`.
