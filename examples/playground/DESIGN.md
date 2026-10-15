---
name: report-anything playground
description: A category-standard AI chat shell where the report is the only new thing on screen.
colors:
  bg: "#ffffff"
  bg-elevated: "#ffffff"
  surface-1: "#fafafa"
  surface-2: "#f4f4f5"
  surface-3: "#e9e9ec"
  fg: "#09090b"
  fg-2: "#52525b"
  fg-3: "#71717a"
  accent: "#2563eb"
  danger: "#dc2626"
  dark-bg: "#0a0a0b"
  dark-bg-elevated: "#18181b"
  dark-surface-1: "#111113"
  dark-surface-2: "#1c1c1f"
  dark-surface-3: "#2a2a2e"
  dark-fg: "#fafafa"
  dark-fg-2: "#a1a1aa"
  dark-fg-3: "#8b8b94"
  dark-accent: "#60a5fa"
  dark-danger: "#f87171"
  dark-report-fg: "#ededed"
  dark-report-grid: "#2e2e33"
  dark-report-positive: "#4ade80"
  dark-report-warning: "#fbbf24"
  dark-series-c1: "#5b9bd5"
  dark-series-c2: "#f0a35e"
  dark-series-c3: "#6cc08b"
  dark-series-c4: "#e07a7a"
  dark-series-c5: "#a99ad6"
  dark-series-c6: "#5cc3cf"
  dark-series-c7: "#c9a074"
  dark-series-c8: "#a3a3a3"
typography:
  headline:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: "36px"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "26px"
  body-sm:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "18px"
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
  bubble: "20px"
  composer: "24px"
  composer-lg: "28px"
  full: "50%"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  column: "880px"
  sidebar: "264px"
  bar: "52px"
components:
  sidebar:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.fg}"
    typography: "{typography.body-sm}"
    width: "{spacing.sidebar}"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    height: "34px"
    padding: "0 10px"
  sidebar-item-active:
    backgroundColor: "{colors.surface-3}"
  header:
    height: "{spacing.bar}"
    padding: "0 12px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.md}"
    size: "36px"
  icon-button-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
  composer:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "12px 12px 10px 16px"
  composer-large:
    rounded: "{rounded.composer-lg}"
    padding: "16px 14px 12px 18px"
  send-button:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
    rounded: "{rounded.full}"
    size: "34px"
  send-button-disabled:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.fg-3}"
  user-bubble:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.bubble}"
    padding: "10px 16px"
  suggestion:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    height: "44px"
    padding: "0 12px"
  attach-menu:
    backgroundColor: "{colors.bg-elevated}"
    rounded: "{rounded.2xl}"
    width: "280px"
    padding: "6px"
  attach-menu-item:
    rounded: "{rounded.md}"
    padding: "8px 10px"
    typography: "{typography.body-sm}"
  tool-step:
    textColor: "{colors.fg-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 8px 3px 6px"
  tool-step-detail:
    backgroundColor: "{colors.surface-2}"
    typography: "{typography.mono}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
  segmented:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-active:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "26px"
  report-print-frame:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.2xl}"
    padding: "24px"
  version-row:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg-2}"
    typography: "{typography.label}"
    rounded: "{rounded.xl}"
    padding: "10px 14px"
  version-row-hover:
    backgroundColor: "{colors.surface-3}"
  data-sheet:
    backgroundColor: "{colors.bg-elevated}"
    width: "min(760px, 94vw)"
    padding: "20px 24px"
  data-sheet-field:
    backgroundColor: "{colors.surface-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
---

# Design System: report-anything playground

## Overview

**Creative North Star: "The Familiar Room"**

The playground is an AI chat app played straight, at the craft level of the category's best shells, so a visitor learns nothing about the frame and spends all their attention on the report. Zinc neutrals on a white or near-black ground, one blue reserved for focus and caret, Geist for everything the UI says and Geist Mono for everything the machine says.

Separation comes from fills and space, never from lines. The sidebar is one tonal step off the ground, the composer and user bubble one step further, hover one step beyond that. Shadows exist only where something floats above the page (composer, menu, sheet, drawer). The report itself renders bare in the thread in Web mode; it is re-themed through the `--ra-*` and `--ra-theme-c1..8` variables, so it reads as part of the same room in dark mode.

**Key Characteristics:**
- Three-step tonal ladder (surface-1, -2, -3) does all structural work.
- One accent, used for focus rings, caret and selection only.
- Rounded, soft geometry (6–28px), circles for avatar and send.
- Ghost controls: icon buttons, suggestions, menu items and history rows have no fill until hover.
- Motion is quiet and eased; the one expressive moment is report blocks rising as they land.

## Colors

Neutral zinc greys with a single cool blue; dark mode swaps every token under `:root[data-theme="dark"]`.

### Primary
- **Focus Blue** (`accent` / `dark-accent`): focus-visible outline (2px, 2px offset), text caret, and selection tint at 24% mix. Nothing else.

### Neutral
- **Paper White / Ink Black** (`bg` / `dark-bg`): the page ground and the Web-mode report surface.
- **Lifted Ground** (`bg-elevated` / `dark-bg-elevated`): menus, data sheet, active segment. Same as ground in light, one step lighter in dark.
- **Sidebar Wash** (`surface-1`): the sidebar's single tone.
- **Soft Fill** (`surface-2`): composer, user bubble, avatar, step detail, version row, print frame, zebra rows, hover on ghost controls.
- **Pressed Fill** (`surface-3`): sidebar hover/active, version hover, disabled send, scrollbar thumb.
- **Ink** (`fg`), **Secondary Ink** (`fg-2`), **Quiet Ink** (`fg-3`): primary text; meta and icons; placeholders, group labels, timestamps.
- **Alarm Red** (`danger`): delete-hover and errors; errors sit on a 10% danger tint, not a bordered box.

### Report re-theme (dark)
In dark Web mode the report takes `dark-report-fg` for text and rules, `dark-fg-2` secondary, `dark-report-grid` gridlines, `dark-bg` surface, green/red/amber tones, and the eight `dark-series-c1..8` series colors. Light mode uses the report package's defaults.

### Named Rules
**The One Blue Rule.** The accent marks focus and the caret only; active state is shown with fill and ink, never blue.

**The Tonal Ladder Rule.** Structure is expressed by stepping ground → surface-1 → surface-2 → surface-3. If a line seems needed, step a fill instead.

## Typography

**Display Font:** Geist Variable (ui-sans-serif, system-ui)
**Body Font:** Geist Variable
**Label/Mono Font:** Geist Mono Variable (ui-monospace, SF Mono, Menlo) for spec, code and tool detail

**Character:** A neutral grotesk set tight at heading sizes and relaxed in the thread; mono marks machine output.

### Hierarchy
- **Headline** (600, 30/36px, -0.025em, balanced): the empty-state greeting only.
- **Title** (600, 20/28px, -0.015em): data sheet heading.
- **Body** (400, 15px; 26px in the thread, 24px in the composer): messages, capped at 68ch for assistant text.
- **Body small** (14px): sidebar, suggestions, menu items. Brand and agent name at 600, -0.01em.
- **Label** (13/20px): tool steps, artifact head, version row, file rows, header note.
- **Caption** (12/18px, 500 for group labels): menu hints, footnote, field chips, table cells (tabular numerals).

### Named Rules
**The No-Ligature Rule.** Message bubbles and the composer disable contextual alternates (`calt` 0) so code like `-->` stays literal.

## Layout

A two-column grid: a 264px sidebar and a fluid main column; the sidebar collapses to 0 with a 320ms eased column transition. Header and sidebar top share a 52px bar height. The thread centres an 880px column (24px gutters; 16px under 900px) with 32px between messages; the composer docks below it at the column width minus 48px. The empty state centres a 720px welcome stack: mark, greeting, sub-line, large composer, and a two-column suggestion list (one column on narrow). Assistant messages use a 28px avatar column with a 16px gap; under 900px the avatar drops and the sidebar becomes a fixed drawer over a 36% black scrim. Spacing runs on 4px steps (4, 8, 12, 16, 20, 24, 32).

## Elevation & Depth

Flat by default with tonal layering; shadows are reserved for floating layers.

### Shadow Vocabulary
- **Float** (`--shadow-float`): the composer, so it reads as hovering over the thread when docked.
- **Menu** (`--shadow-menu`): attach menu, data sheet, mobile drawer.
- **Segment lift** (`0 1px 2px` at 8%): the pressed segment in the Web/Print toggle.

### Named Rules
**The Float-Only Shadow Rule.** Only things that sit above the page get a shadow; nothing inline in the thread does.

## Shapes

Soft, consistent rounding scaled to size: 6px for tiny file controls, 8px for small buttons and step rows, 10px for standard controls and history rows, 12px for suggestions and code panels, 14–16px for version row, menu and print frame, 20px for the bubble, 24/28px for the composer, full circles for avatar and send. No borders anywhere in the shell; `border: none` is the reset on every control.

## Components

### Sidebar
- Surface-1 wash, 14px text. Brand, ghost "New chat", history grouped under 12px quiet labels, footer links. Rows 34px, 10px radius; hover and current page fill with surface-3; delete appears on hover/focus and turns red on hover.

### Header
- 52px, sidebar toggle, agent name (600) with a quiet 13px note (hidden on narrow), spacer, theme and GitHub as 36px ghost icon buttons.

### Composer
- Surface-2 slab with float shadow, 24px radius (28px large on the empty state). Borderless textarea, attach button left, a 34px ink-circle send right that scales to 0.94 on press and greys out when disabled. Attached files show inline above the text as icon/name/meta rows, no boxes.

### Attach menu
- Floats 8px above the attach button: 280px, 16px radius, elevated ground, menu shadow, 180ms rise-and-scale in. Items are ghost rows with an icon, title and 12px hint; hover/focus fill surface-2.

### Tool steps
- Inline 13px disclosure rows, no container. Spinner while running (0.9s spin), quiet check when done, red on error, chevron rotates 90° on open. Detail opens into a surface-2 mono panel capped at 300px.

### Inline report artifact
- Rendered directly in the assistant message: a 13px head (icon, meta, Web/Print segmented toggle, actions), then the report. Web mode is bare on the page ground; Print mode sits on a surface-2 frame with 24px padding and 16px radius.

### Version row
- Full-width surface-2 row, 14px radius, under a refined report: title (500, ink, truncated) and meta in fg-2; hover steps to surface-3.

### Data sheet
- Right-side sheet, `min(760px, 94vw)`, elevated ground and menu shadow over a 36% scrim; slides 24px in over 320ms. Title, field chips on surface-2, a segmented table/source toggle, a zebra-striped table with sticky header and right-aligned numerals, or the source in a surface-2 mono panel.

### Messages
- User: right-aligned surface-2 bubble, 20px radius, max 75%/640px. Assistant: avatar circle plus text; copy actions fade in on hover. Thinking is a pulsing 8px dot.

## Do's and Don'ts

### Do:
- **Do** separate regions with the surface-1/2/3 ladder and space.
- **Do** keep controls ghost until hover, then fill one step.
- **Do** use lucide icons at their default stroke, 14–18px.
- **Do** let report blocks rise once while the report is building (520ms, 10px up, 3px blur clearing, ease-out) and nowhere else.
- **Do** honour reduced motion: all animations and transitions collapse to 1ms.

### Don't:
- **Don't** put borders, cards or outlined boxes in the chat; errors and files included.
- **Don't** use pills or gradients.
- **Don't** use the accent for active, selected or brand color.
- **Don't** add shadows to inline thread elements.
