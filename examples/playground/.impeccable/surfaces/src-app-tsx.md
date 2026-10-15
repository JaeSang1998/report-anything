---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/Chat.tsx","src/ReportArtifact.tsx","src/app.css"]
---

# Playground chat surface

Scope: the playground app shell (examples/playground). Mode: operate. Audience: developers evaluating report-anything from the README. Task: pick or attach data, ask, watch the report build inline, refine by asking, switch Web/Print, take the spec.

## Direction contract

THESIS: The category standard played straight: an AI chat app at the craft level of Vercel's AI Chatbot and v0, so nothing about the shell needs learning and the report is the only new thing on screen. Refuses the bare single-column page it replaces.

OWN-WORLD: Neutral zinc greys, white / near-black grounds, one blue for focus and active state; Geist for UI, Geist Mono for spec and code; lucide icons at one stroke. Separation by fills and space, never borders; no cards, pills, gradients.

STORY: The visitor sees a familiar chat, clicks a suggestion, watches tool steps tick and the report assemble block by block, edits it in words, opens the data, downloads the spec.

FIRST VIEWPORT: Left sidebar (brand, New chat, chat history, footer links); header with sidebar toggle, agent label, theme and GitHub; empty state centres a greeting and the composer with suggestions beneath; after the first send the composer docks to the bottom.

FORM: Category-standard chat shell; collapsible sidebar, drawer under 900px.

SIGNATURE: Report blocks rise into place as ops land, while tool steps show live status.
