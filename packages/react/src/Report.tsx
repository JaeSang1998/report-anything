import { Component, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode, RefObject } from "react";
import { createReportSession, layoutReport, METRICS, SpecError, uiStrings } from "@report-anything/core";
import type { Block, Cell, Issue, LayoutMode, LayoutPlan, PageItem, ReportSession, ReportSnapshot, ReportSpec, Section } from "@report-anything/core";
import { DEFAULT_BLOCKS } from "./blocks.js";
import type { BlockComponents, BlockProps, TableSlice } from "./blocks.js";
import { Markdown } from "./Markdown.js";
import { rootStyle } from "./theme.js";

export interface ReportProps {
  /** Untrusted ReportSpec JSON (validated here). Ignored when `session` is given. */
  spec?: unknown;
  /** Live session: re-renders on every applied op (streaming / incremental edits). */
  session?: ReportSession;
  /** "web": responsive flow. "print": paginated sheets that match the PDF output. */
  mode?: LayoutMode;
  /** Replace the body renderer of any block type. */
  components?: BlockComponents;
  className?: string;
}

type Source = { session: ReportSession; issues?: undefined } | { session?: undefined; issues: Issue[] };

const noopSubscribe = () => () => {};

/** Render a ReportSpec (or live session) with the headless layout engine. */
export function Report({ spec, session, mode = "web", components, className }: ReportProps) {
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
  return <ReportCanvas snapshot={snapshot} mode={mode} components={components} className={className} />;
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

function ReportCanvas({ snapshot, mode, components, className }: { snapshot: ReportSnapshot; mode: LayoutMode; components?: BlockComponents | undefined; className?: string | undefined }) {
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
        ...(mode === "web" ? { contentWidth: width } : { measured: measured.blocks, measuredHeaders: measured.headers }),
        ...(mode === "print" && measured.report !== undefined ? { measuredReportHeader: measured.report } : {}),
      }),
    [spec, context, mode, width, measured],
  );

  // Print: feed real DOM heights back into the paginator until estimates and DOM agree.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (mode !== "print" || !root || passes.current >= MAX_MEASURE_PASSES) return;
    const next: Measured = { blocks: { ...measured.blocks }, headers: { ...measured.headers }, ...(measured.report !== undefined ? { report: measured.report } : {}) };
    let changed = false;
    const put = (bucket: Record<string, number>, key: string, h: number) => {
      if (Math.abs((bucket[key] ?? -1) - h) > 0.5) {
        bucket[key] = h;
        changed = true;
      }
    };
    for (const el of root.querySelectorAll<HTMLElement>("[data-ra-measure]")) {
      const [kind, id] = (el.dataset.raMeasure ?? "").split(":");
      const h = el.getBoundingClientRect().height;
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
  const env: RenderEnv = { snapshot, plan, mode, components, paletteSize, index };
  const classes = ["ra-report", `ra-report--${mode}`, className].filter(Boolean).join(" ");

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

  const page = plan.page!;
  return (
    <div ref={rootRef} className={classes} style={rootStyle(spec)}>
      <style>{`@page { size: ${page.width}px ${page.height}px; margin: 0; }`}</style>
      {plan.pages.map((p) => (
        <div key={p.index} className="ra-page" style={{ width: page.width, height: page.height, padding: page.margin }}>
          <div className="ra-page__content" style={{ width: page.contentWidth, height: page.contentHeight }}>
            {p.items.map((item, k) => (
              <PageItemView key={k} env={env} item={item} />
            ))}
          </div>
          <div className="ra-page__footer" style={{ bottom: page.margin / 2 - 8, left: page.margin, right: page.margin }}>
            <span>{spec.title}</span>
            <span>
              {p.index + 1} / {plan.pages.length}
            </span>
          </div>
        </div>
      ))}
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
    case "row":
      return (
        <div className="ra-page-item" style={style}>
          <RowView env={env} sectionId={item.sectionId} row={item.row} />
        </div>
      );
    case "table-slice": {
      const cell = env.plan.sections.find((s) => s.id === item.sectionId)?.rows[item.row]?.cells.find((c) => c.blockId === item.blockId);
      if (!cell) return null;
      return (
        <div className="ra-page-item" style={style}>
          <div className="ra-row">
            <CellView env={env} cell={cell} slice={{ from: item.from, to: item.to, continued: item.continued }} />
          </div>
        </div>
      );
    }
  }
}

function RowView({ env, sectionId, row }: { env: RenderEnv; sectionId: string; row: number }) {
  const layout = env.plan.sections.find((s) => s.id === sectionId)?.rows[row];
  if (!layout) return null;
  return (
    <div className="ra-row">
      {layout.cells.map((cell) => (
        <CellView key={cell.blockId} env={env} cell={cell} />
      ))}
    </div>
  );
}

function CellView({ env, cell, slice }: { env: RenderEnv; cell: Cell; slice?: TableSlice }) {
  const block = env.index.blocks.get(cell.blockId);
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
  return (
    <article
      className={`ra-block ra-block--${block.type}`}
      style={{ gridColumn: `${cell.start} / span ${cell.span}` }}
      data-block-id={block.id}
      data-ra-measure={slice ? undefined : `block:${block.id}`}
    >
      {block.title || variant ? (
        <h3 className="ra-block__title">
          {variant ? <span className={`ra-block__variant ra-tone--${tone}`}>{block.title ? `${variant}: ` : variant}</span> : null}
          {block.title}
          {slice?.continued ? <span className="ra-block__continued"> ({strings.continued})</span> : null}
        </h3>
      ) : null}
      {broken ? (
        <BlockIssues issues={issues ?? []} />
      ) : (
        <BlockBoundary blockId={block.id}>
          <Body block={block} context={env.snapshot.context} cell={cell} mode={env.mode} paletteSize={env.paletteSize} {...(slice ? { slice } : {})} />
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
