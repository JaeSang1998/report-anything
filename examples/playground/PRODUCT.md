# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and AI-agent builders evaluating report-anything: they open the public playground (GitHub Pages, no API key) to see an agent turn a dataset and a plain-language question into a finished report, then decide whether to adopt the library. Secondary: people who run it locally with their own model key to iterate on real data. [Inferred from the README and repository; not separately confirmed.]

## Product Purpose

report-anything is a headless report engine. Agents write a `ReportSpec` (datasets, sections, blocks, bound numbers); the engine computes every number, composes the layout, paginates for print and renders. The playground proves this in one sitting: attach or pick data, ask a question, watch the report build live inside the conversation, edit it by asking, switch web/print, inspect the spec.

## Positioning

The agent writes intent, never pixels or numbers: figures are bound to data, layout is solved by a composition engine (feature, sidebar, hero, grid), print pagination is real. Works keyless with a deterministic local agent; an LLM is optional.

## Operating Context

Desktop browser, usually opened from the GitHub README; sessions are short demos. Data comes from five bundled samples (sales, SaaS MRR, web traffic CSV, support tickets, orders API JSON) or the user's CSV/JSON. The report is rendered inline in the chat thread, with Web/Print toggle and Spec JSON view; data chips open a sheet with the table and field roles.

## Capabilities and Constraints

- Report embedded inside the conversation, not in a side panel (user decision).
- Runs without an API key; LLM via `.env.local` when developing locally.
- English UI and examples; the local agent also understands Korean.
- Static build for GitHub Pages under `/report-anything/`.

## Brand Commitments

- Follow anti-ai-default-ui (github.com/JaeSang1998/anti-ai-default-ui): no cards or tiles, no pills, no accent edges, no gradients, no emoji status. Reconfirmed by the user for the playground redesign.
- No borders in the chat UI; separation by grey fills and space.
- Light and dark themes, following the system setting, with a toggle.
- Standing preference: the category standard for the shell (an AI chat app at the craft level of Vercel's AI Chatbot and v0), chosen by the user over invented visual worlds.

## Evidence on Hand

Real, working demonstrations only: the bundled sample datasets (`src/samples.ts`), the example specs in `examples/specs/`, and screenshots in `docs/screenshots/`. No users, testimonials, benchmarks or adoption numbers exist; do not invent any.

## Product Principles

- The report is the product; chrome recedes around it.
- Show the mechanism working (live ops, bound numbers, solved layout) instead of describing it.
- Nothing requires setup: the first click produces a real report.
