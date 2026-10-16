import { Component, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, KeyboardEvent, ReactNode, RefObject } from "react";
import { createReportSession, layoutReport, METRICS, SpecError, uiStrings } from "@report-anything/core";
import type { Block, Issue, LayoutMode, LayoutPlan, Page, PageItem, Pane, Placement, ReportSession, ReportSnapshot, ReportSpec, Section } from "@report-anything/core";
import { DEFAULT_BLOCKS } from "./blocks.js";
import type { BlockComponents, BlockProps, TableSlice } from "./blocks.js";
import { Markdown } from "./Markdown.js";
import { rootStyle } from "./theme.js";

export interface ReportProps {
  /** Untrusted ReportSpec JSON (validated here). Ignored when `session` is given. */
  spec?: unknown;
  /** Live session: re-renders on every applied op (streaming / incremental edits). */
  session?: ReportSession;
  /**
   * "web": responsive flow. "print": paginated sheets that match the PDF output. "slides": a 16:9 slide deck
   * (interactive viewer; stacked slide sheets when not interactive).
   */
  mode?: LayoutMode;
  /**
   * Default true. False renders static output (server HTML): no controls that need scripts. Tables show maxRows
   * with a "showing N of M" note, tabs/carousel sections render as flow, slides render as stacked sheets.
   */
  interactive?: boolean;
  /** Replace the body renderer of any block type. */
  components?: BlockComponents;
  className?: string;
}

type Source = { session: ReportSession; issues?: undefined } | { session?: undefined; issues: Issue[] };

const noopSubscribe = () => () => {};

/** Render a ReportSpec (or live session) with the headless layout engine. */
export function Report({ spec, session, mode = "web", interactive = true, components, className }: ReportProps) {
  const local = useMemo<Source | null>(() => {
    if (session || spec === undefined) return null;
    try {
      return { session: createReportSession(spec) };
    } catch (err) {
      if (err instanceof SpecError) return { issues: err.issues };
      throw err;
    }
  }, [spec, session]);
  const active = session ?? local?.session;
  const snapshot = useSyncExternalStore(
    active?.subscribe ?? noopSubscribe,
    () => active?.getSnapshot(),
    () => active?.getSnapshot(),
  );
  if (local?.issues) return <ReportIssues issues={local.issues} title="This report spec is invalid" />;
  if (!snapshot) return null;
  return <ReportCanvas snapshot={snapshot} mode={mode} interactive={interactive} components={components} className={className} />;
}

export function ReportIssues({ issues, title = "Report issues" }: { issues: readonly Issue[]; title?: string }) {
  return (
    <div className="ra-issues" role="alert">
      <strong>{title}</strong>
      <ul>
        {issues.map((i, k) => (
          <li key={k} className={`ra-issues__item ra-issues__item--${i.severity}`}>
            <code>{i.path}</code> {i.message}
            {i.hint ? <em> — {i.hint}</em> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Measured {
  blocks: Record<string, number>;
  headers: Record<string, number>;
  report?: number;
}

const EMPTY_MEASURED: Measured = { blocks: {}, headers: {} };
const MAX_MEASURE_PASSES = 4;

function useContainerWidth(enabled: boolean): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(METRICS.web.contentWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const update = () => setWidth(Math.min(METRICS.web.contentWidth, Math.floor(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);
  return [ref, width];
}

function ReportCanvas({
  snapshot,
  mode,
  interactive,
  components,
  className,
}: {
  snapshot: ReportSnapshot;
  mode: LayoutMode;
  interactive: boolean;
  components?: BlockComponents | undefined;
  className?: string | undefined;
}) {
  const { spec, context } = snapshot;
  const [rootRef, width] = useContainerWidth(mode === "web");
  const [measured, setMeasured] = useState<Measured>(EMPTY_MEASURED);
  const passes = useRef(0);

  // New content → measure again from scratch.
  useLayoutEffect(() => {
    passes.current = 0;
  }, [snapshot, mode]);

  const plan = useMemo(
    () =>
      layoutReport(spec, context, {
        mode,
        interactive,
        ...(mode === "web" ? { contentWidth: width } : { measured: measured.blocks, measuredHeaders: measured.headers }),
        ...(mode !== "web" && measured.report !== undefined ? { measuredReportHeader: measured.report } : {}),
      }),
    [spec, context, mode, interactive, width, measured],
  );

  // Print/slides: feed real DOM heights back into the paginator until estimates and DOM agree.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (mode === "web" || !root || passes.current >= MAX_MEASURE_PASSES) return;
    // The deck shows scaled slides: it marks the subtree that holds every slide once, with its scale.
    const scope = root.querySelector<HTMLElement>("[data-ra-measure-root]") ?? root;
    const scale = Number(scope.dataset.raScale ?? 1);
    const next: Measured = { blocks: { ...measured.blocks }, headers: { ...measured.headers }, ...(measured.report !== undefined ? { report: measured.report } : {}) };
    let changed = false;
    const put = (bucket: Record<string, number>, key: string, h: number) => {
      if (Math.abs((bucket[key] ?? -1) - h) > 0.5) {
        bucket[key] = h;
        changed = true;
      }
    };
    for (const el of scope.querySelectorAll<HTMLElement>("[data-ra-measure]")) {
      const [kind, id] = (el.dataset.raMeasure ?? "").split(":");
      // Elastic blocks report their chrome only: the engine solves their body (`plotHeight`).
      const h = Math.max(0, el.getBoundingClientRect().height / scale - Number(el.dataset.raPlot ?? 0));
      if (kind === "block" && id) put(next.blocks, id, h);
      else if (kind === "section" && id) put(next.headers, id, h);
      else if (kind === "report" && Math.abs((next.report ?? -1) - h) > 0.5) {
        next.report = h;
        changed = true;
      }
    }
    if (changed) {
      passes.current++;
      setMeasured(next);
    }
  });

  const paletteSize = spec.theme?.palette?.length ?? 8;
  const index = useMemo(() => indexSpec(spec, snapshot.issues), [spec, snapshot.issues]);
  const env: RenderEnv = { snapshot, plan, mode, interactive, components, paletteSize, index };
  const deck = mode === "slides" && interactive;
  const classes = ["ra-report", `ra-report--${mode}`, deck ? "ra-report--deck" : undefined, className].filter(Boolean).join(" ");

  if (mode === "web") {
    return (
      <div ref={rootRef} className={classes} style={rootStyle(spec)}>
        <div className="ra-flow" style={{ maxWidth: METRICS.web.contentWidth }}>
          {plan.pages[0]?.items.map((item, k) => (
            <PageItemView key={k} env={env} item={item} />
          ))}
        </div>
      </div>
    );
  }

  if (deck) {
    return (
      <div ref={rootRef} className={classes} style={rootStyle(spec)}>
        <SlideDeck env={env} />
      </div>
    );
  }

  const page = plan.page!;
  return (
    <div ref={rootRef} className={classes} style={rootStyle(spec)}>
      <style>{`@page { size: ${page.width}px ${page.height}px; margin: 0; }`}</style>
      {plan.pages.map((p) => (
        <SheetView key={p.index} env={env} sheet={p} />
      ))}
    </div>
  );
}

/** One printed page or slide: content box inside the margins, footer (report title, n / N) in the bottom margin. */
function SheetView({ env, sheet }: { env: RenderEnv; sheet: Page }) {
  const page = env.plan.page!;
  const title = env.mode === "slides" && sheet.items.length === 1 && sheet.items[0]!.kind === "report-header";
  return (
    <div className={`ra-page${env.mode === "slides" ? " ra-slide" : ""}${title ? " ra-slide--title" : ""}`} style={{ width: page.width, height: page.height, padding: page.margin }}>
      <div className="ra-page__content" style={{ width: page.contentWidth, height: page.contentHeight }}>
        {sheet.items.map((item, k) => (
          <PageItemView key={k} env={env} item={item} />
        ))}
      </div>
      <div className="ra-page__footer" style={{ bottom: page.margin / 2 - 8, left: page.margin, right: page.margin }}>
        <span>{env.snapshot.spec.title}</span>
        <span>
          {sheet.index + 1} / {env.plan.pages.length}
        </span>
      </div>
    </div>
  );
}

interface SpecIndex {
  sections: Map<string, Section>;
  blocks: Map<string, Block>;
  blockIssues: Map<string, Issue[]>;
}

function indexSpec(spec: ReportSpec, issues: readonly Issue[]): SpecIndex {
  const sections = new Map<string, Section>();
  const blocks = new Map<string, Block>();
  const blockIssues = new Map<string, Issue[]>();
  spec.sections.forEach((s, si) => {
    sections.set(s.id, s);
    s.blocks.forEach((b, bi) => {
      blocks.set(b.id, b);
      const prefix = `sections[${si}].blocks[${bi}]`;
      const own = issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`));
      if (own.length) blockIssues.set(b.id, own);
    });
  });
  return { sections, blocks, blockIssues };
}

interface RenderEnv {
  snapshot: ReportSnapshot;
  plan: LayoutPlan;
  mode: LayoutMode;
  /** Web/slides output with script-driven controls (pagers, tabs, carousels, deck). */
  interactive: boolean;
  components: BlockComponents | undefined;
  paletteSize: number;
  index: SpecIndex;
}

function ReportHeader({ spec, env }: { spec: ReportSpec; env: RenderEnv }) {
  const meta = [spec.meta?.author, spec.meta?.date].filter(Boolean).join(" · ");
  return (
    <header className="ra-report-header" data-ra-measure="report">
      <h1 className="ra-report-header__title">{spec.title}</h1>
      {spec.subtitle ? <p className="ra-report-header__subtitle">{spec.subtitle}</p> : null}
      {meta ? <p className="ra-report-header__meta">{meta}</p> : null}
      {spec.summary ? <Markdown className="ra-report-header__summary" text={spec.summary} context={env.snapshot.context} /> : null}
    </header>
  );
}

function SectionHeader({ section }: { section: Section }) {
  if (!section.title && !section.description) return null;
  return (
    <header className="ra-section-header" data-ra-measure={`section:${section.id}`}>
      {section.title ? <h2 className="ra-section-header__title">{section.title}</h2> : null}
      {section.description ? <p className="ra-section-header__desc">{section.description}</p> : null}
    </header>
  );
}

function PageItemView({ env, item }: { env: RenderEnv; item: PageItem }) {
  const style = { marginTop: item.spacingBefore };
  switch (item.kind) {
    case "report-header":
      return (
        <div className="ra-page-item" style={style}>
          <ReportHeader spec={env.snapshot.spec} env={env} />
        </div>
      );
    case "section-header": {
      const section = env.index.sections.get(item.sectionId);
      return section ? (
        <div className="ra-page-item" style={style}>
          <SectionHeader section={section} />
        </div>
      ) : null;
    }
    case "band": {
      // Interactive web tabs/carousel sections: the section's bands grouped into panes, shown one at a time.
      const panes = env.plan.sections.find((s) => s.id === item.sectionId)?.panes;
      const section = env.index.sections.get(item.sectionId);
      if (panes && section) {
        if (item.band > 0) return null;
        return (
          <div className="ra-page-item" style={style}>
            {section.view === "tabs" ? <SectionTabs env={env} section={section} panes={panes} /> : <SectionCarousel env={env} section={section} panes={panes} />}
          </div>
        );
      }
      return (
        <div className="ra-page-item" style={style}>
          <BandView env={env} sectionId={item.sectionId} band={item.band} />
        </div>
      );
    }
    case "table-slice": {
      const placement = env.plan.sections.find((s) => s.id === item.sectionId)?.bands[item.band]?.placements.find((p) => p.blockId === item.blockId);
      if (!placement) return null;
      return (
        <div className="ra-page-item" style={style}>
          <div className="ra-band ra-band--full">
            <CellView env={env} placement={placement} slice={{ from: item.from, to: item.to, continued: item.continued }} />
          </div>
        </div>
      );
    }
  }
}

/**
 * A 12-column grid region; each placement sets its own column and row lines, so blocks can span row tracks.
 * `untitledBlockId`: the block of a tab pane whose title the tab already shows.
 */
function BandView({ env, sectionId, band, untitledBlockId }: { env: RenderEnv; sectionId: string; band: number; untitledBlockId?: string | undefined }) {
  const layout = env.plan.sections.find((s) => s.id === sectionId)?.bands[band];
  if (!layout) return null;
  return (
    <div className={`ra-band ra-band--${layout.composition}`} style={{ gridTemplateRows: `repeat(${layout.rows}, auto)` }}>
      {layout.placements.map((placement) => (
        <CellView key={placement.blockId} env={env} placement={placement} untitled={placement.blockId === untitledBlockId} />
      ))}
    </div>
  );
}

/** One tab or carousel slide: its bands stacked with the grid gap. */
function PaneView({ env, sectionId, pane, untitledBlockId }: { env: RenderEnv; sectionId: string; pane: Pane; untitledBlockId?: string }) {
  const bands = Array.from({ length: pane.to - pane.from }, (_, k) => pane.from + k);
  return (
    <div className="ra-pane">
      {bands.map((band) => (
        <BandView key={band} env={env} sectionId={sectionId} band={band} untitledBlockId={untitledBlockId} />
      ))}
    </div>
  );
}

/** Pane names: the label block's title, else its block type. */
function paneLabels(env: RenderEnv, panes: readonly Pane[]): string[] {
  const strings = uiStrings(env.snapshot.context.locale);
  return panes.map((p) => {
    const block = env.index.blocks.get(p.labelBlockId);
    return block?.title ?? (block ? strings.blockType[block.type] : p.labelBlockId);
  });
}

function CellView({ env, placement, slice, untitled = false }: { env: RenderEnv; placement: Placement; slice?: TableSlice; untitled?: boolean }) {
  const block = env.index.blocks.get(placement.blockId);
  if (!block) return null;
  const strings = uiStrings(env.snapshot.context.locale);
  let lastSlice = true;
  if (slice && block.type === "table") {
    const total = env.snapshot.context.datasets.get(block.data)?.rows.length ?? 0;
    lastSlice = slice.to >= Math.min(total, block.maxRows ?? total);
  }
  const issues = env.index.blockIssues.get(block.id);
  const broken = env.snapshot.brokenBlocks.has(block.id);
  const Body = (env.components?.[block.type] ?? DEFAULT_BLOCKS[block.type]) as ComponentType<BlockProps>;
  // Callouts lead with their variant word ("Risk: …"); tone color only reinforces the word.
  const variant = block.type === "callout" && block.variant ? strings.variant[block.variant] : undefined;
  const tone = block.type === "callout" ? block.tone : undefined;
  const title = untitled ? undefined : block.title;
  return (
    <article
      className={`ra-block ra-block--${block.type}`}
      style={{ gridColumn: `${placement.col} / span ${placement.span}`, gridRow: `${placement.row} / span ${placement.rowSpan}` }}
      data-block-id={block.id}
      data-ra-measure={slice ? undefined : `block:${block.id}`}
      data-ra-plot={placement.plotHeight}
    >
      {title || variant ? (
        <h3 className="ra-block__title">
          {variant ? <span className={`ra-block__variant ra-tone--${tone}`}>{title ? `${variant}: ` : variant}</span> : null}
          {title}
          {slice?.continued ? <span className="ra-block__continued"> ({strings.continued})</span> : null}
        </h3>
      ) : null}
      {broken ? (
        <BlockIssues issues={issues ?? []} />
      ) : (
        <BlockBoundary blockId={block.id}>
          <Body
            block={block}
            context={env.snapshot.context}
            cell={placement}
            mode={env.mode}
            interactive={env.interactive}
            paletteSize={env.paletteSize}
            {...(slice ? { slice } : {})}
            {...(placement.plotHeight !== undefined ? { plotHeight: placement.plotHeight } : {})}
          />
        </BlockBoundary>
      )}
      {block.caption && lastSlice ? <p className="ra-block__caption">{block.caption}</p> : null}
    </article>
  );
}

function BlockIssues({ issues }: { issues: readonly Issue[] }) {
  return (
    <div className="ra-block-error" role="note">
      {issues
        .filter((i) => i.severity === "error")
        .map((i, k) => (
          <p key={k}>
            <strong>Cannot render:</strong> {i.message}
            {i.hint ? <span className="ra-block-error__hint"> ({i.hint})</span> : null}
          </p>
        ))}
    </div>
  );
}

class BlockBoundary extends Component<{ blockId: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidUpdate(prev: { blockId: string; children: ReactNode }) {
    if (this.state.error && prev.children !== this.props.children) this.setState({ error: null });
  }
  override render() {
    if (this.state.error) return <BlockIssues issues={[{ severity: "error", code: "render", path: this.props.blockId, message: this.state.error.message }]} />;
    return this.props.children;
  }
}

/** Keyboard navigation shared by tab lists, carousels and the deck: index, count → next index (callers clamp or wrap). */
const NAV_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (i) => i - 1,
  ArrowRight: (i) => i + 1,
  Home: () => 0,
  End: (_, n) => n - 1,
};
/** Presentation remotes send PageUp / PageDown. */
const DECK_KEYS: Record<string, (index: number, count: number) => number> = { ...NAV_KEYS, PageUp: (i) => i - 1, PageDown: (i) => i + 1 };

/** Target index for a navigation key, or undefined when the key is not navigation (or carries a modifier). */
function navTarget(e: KeyboardEvent, keys: Record<string, (index: number, count: number) => number>, index: number, count: number): number | undefined {
  const move = keys[e.key];
  if (!move || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return undefined;
  e.preventDefault();
  return move(index, count);
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg className="ra-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={dir === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Web tabs section: one tab per pane (labelled by its lead block's title), one pane shown at a time at full width. */
function SectionTabs({ env, section, panes }: { env: RenderEnv; section: Section; panes: readonly Pane[] }) {
  const labels = paneLabels(env, panes);
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const n = panes.length;
  const current = Math.min(active, n - 1);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = navTarget(e, NAV_KEYS, current, n);
    if (target === undefined) return;
    const next = (target + n) % n;
    setActive(next);
    tabs.current[next]?.focus();
  };
  return (
    <div className="ra-tabs">
      <div className="ra-tabs__list" role="tablist" aria-label={section.title} onKeyDown={onKeyDown}>
        {panes.map((p, k) => (
          <button
            key={p.labelBlockId}
            ref={(el) => {
              tabs.current[k] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${k}`}
            className="ra-tabs__tab"
            aria-selected={k === current}
            aria-controls={`${id}-panel-${k}`}
            tabIndex={k === current ? 0 : -1}
            onClick={() => setActive(k)}
          >
            {labels[k]}
          </button>
        ))}
      </div>
      {panes.map((p, k) => (
        <div key={p.labelBlockId} className="ra-tabs__panel" role="tabpanel" id={`${id}-panel-${k}`} aria-labelledby={`${id}-tab-${k}`} hidden={k !== current}>
          <PaneView env={env} sectionId={section.id} pane={p} untitledBlockId={p.labelBlockId} />
        </div>
      ))}
    </div>
  );
}

/** Web carousel section: one pane per slide, arrows, counter and dots; the track slides (no motion if reduced). */
function SectionCarousel({ env, section, panes }: { env: RenderEnv; section: Section; panes: readonly Pane[] }) {
  const strings = uiStrings(env.snapshot.context.locale).slides;
  const labels = paneLabels(env, panes);
  const [active, setActive] = useState(0);
  const n = panes.length;
  const current = Math.min(active, n - 1);
  const go = (k: number) => setActive(Math.max(0, Math.min(n - 1, k)));
  // The viewport takes the active slide's height (animated in CSS), so a short slide leaves no gap and
  // taller inactive slides never affect the page.
  const trackRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const slide = trackRef.current?.children[current];
    if (!slide) return;
    const update = () => setHeight(slide.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(slide);
    return () => ro.disconnect();
  }, [current]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = navTarget(e, NAV_KEYS, current, n);
    if (target !== undefined) go(target);
  };
  return (
    <div className="ra-carousel" role="region" aria-roledescription={strings.carousel} aria-label={section.title ?? strings.carousel} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="ra-carousel__viewport" style={height === undefined ? undefined : { height }}>
        <div ref={trackRef} className="ra-carousel__track" style={{ transform: `translateX(${-current * 100}%)` }}>
          {panes.map((p, k) => (
            <div key={p.labelBlockId} className="ra-carousel__slide" role="group" aria-label={`${strings.slide(k + 1, n)}: ${labels[k]}`} aria-hidden={k !== current} inert={k !== current}>
              <PaneView env={env} sectionId={section.id} pane={p} />
            </div>
          ))}
        </div>
      </div>
      <div className="ra-carousel__controls">
        <div className="ra-carousel__dots">
          {panes.map((p, k) => (
            <button
              key={p.labelBlockId}
              type="button"
              className="ra-carousel__dot"
              aria-label={`${strings.slide(k + 1, n)}: ${labels[k]}`}
              title={labels[k]}
              aria-current={k === current ? "true" : undefined}
              onClick={() => go(k)}
            />
          ))}
        </div>
        <button type="button" className="ra-nav-button" onClick={() => go(current - 1)} disabled={current === 0} aria-label={strings.previous}>
          <Chevron dir="left" />
        </button>
        <span className="ra-carousel__counter" aria-live="polite">
          {current + 1} / {n}
        </span>
        <button type="button" className="ra-nav-button" onClick={() => go(current + 1)} disabled={current === n - 1} aria-label={strings.next}>
          <Chevron dir="right" />
        </button>
      </div>
    </div>
  );
}

/** Thumbnail width (px) in the deck's slide strip. */
const THUMB_WIDTH = 160;

/** A sheet drawn at `scale` (CSS transform) inside a box of the scaled size. */
function ScaledSheet({ env, sheet, scale, inert = false }: { env: RenderEnv; sheet: Page; scale: number; inert?: boolean }) {
  const page = env.plan.page!;
  return (
    <div className="ra-scaled" style={{ width: page.width * scale, height: page.height * scale }}>
      <div className="ra-scaled__inner" style={{ width: page.width, transform: `scale(${scale})` }} inert={inert}>
        <SheetView env={env} sheet={sheet} />
      </div>
    </div>
  );
}

/**
 * Slides viewer: one slide scaled to the container width (to the screen while presenting), previous/next,
 * counter, arrow/PageUp/PageDown keys while the deck has focus, fullscreen presenting, and a thumbnail strip.
 * The strip holds every slide once at a fixed scale: the measuring pass reads heights there.
 */
function SlideDeck({ env }: { env: RenderEnv }) {
  const { plan } = env;
  const page = plan.page!;
  const strings = uiStrings(env.snapshot.context.locale).slides;
  const total = plan.pages.length;
  const [active, setActive] = useState(0);
  const current = Math.min(active, total - 1);
  const [presenting, setPresenting] = useState(false);
  const [box, setBox] = useState({ width: page.width, height: page.height });
  const deckRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const go = (k: number) => setActive(Math.max(0, Math.min(total - 1, k)));

  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onChange = () => setPresenting(document.fullscreenElement !== null && document.fullscreenElement === deckRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keep the current thumbnail in view by scrolling the strip only (never the page).
  useEffect(() => {
    const strip = thumbsRef.current;
    const thumb = strip?.querySelectorAll<HTMLElement>(".ra-deck__thumb")[current];
    if (!strip || !thumb) return;
    if (thumb.offsetLeft < strip.scrollLeft) strip.scrollLeft = thumb.offsetLeft;
    else if (thumb.offsetLeft + thumb.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = thumb.offsetLeft + thumb.offsetWidth - strip.clientWidth;
  }, [current]);

  const togglePresent = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    deckRef.current?.focus();
    void deckRef.current?.requestFullscreen();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = navTarget(e, DECK_KEYS, current, total);
    if (target !== undefined) go(target);
  };

  const scale = presenting ? Math.min(box.width / page.width, box.height / page.height) : box.width / page.width;
  const thumbScale = THUMB_WIDTH / page.width;
  return (
    <div ref={deckRef} className="ra-deck" role="region" aria-roledescription={strings.deck} aria-label={env.snapshot.spec.title} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="ra-deck__stage">
        <div ref={fitRef} className="ra-deck__fit" style={presenting ? undefined : { height: page.height * scale }}>
          <ScaledSheet env={env} sheet={plan.pages[current]!} scale={scale} />
        </div>
      </div>
      <div className="ra-deck__bar">
        <button type="button" className="ra-nav-button" onClick={() => go(current - 1)} disabled={current === 0} aria-label={strings.previous}>
          <Chevron dir="left" />
        </button>
        <span className="ra-deck__counter" aria-live="polite">
          {current + 1} / {total}
        </span>
        <button type="button" className="ra-nav-button" onClick={() => go(current + 1)} disabled={current === total - 1} aria-label={strings.next}>
          <Chevron dir="right" />
        </button>
        <button type="button" className="ra-nav-button ra-deck__present" onClick={togglePresent}>
          <svg className="ra-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d={presenting ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{presenting ? strings.exitPresent : strings.present}</span>
        </button>
      </div>
      <div ref={thumbsRef} className="ra-deck__thumbs" role="group" aria-label={strings.thumbnails} data-ra-measure-root="" data-ra-scale={thumbScale}>
        {plan.pages.map((p) => (
          <button
            key={p.index}
            type="button"
            className="ra-deck__thumb"
            aria-label={strings.slide(p.index + 1, total)}
            aria-current={p.index === current ? "true" : undefined}
            onClick={() => go(p.index)}
          >
            <ScaledSheet env={env} sheet={p} scale={thumbScale} inert />
          </button>
        ))}
      </div>
    </div>
  );
}
