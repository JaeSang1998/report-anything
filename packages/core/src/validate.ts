import { MERMAID_DIAGRAMS, ReportSpec } from "./spec.js";
import type { Block, Issue, Measure, ValueOrMeasure } from "./spec.js";
import type { DataContext, ResolvedDataset } from "./data/types.js";
import { createDataContext } from "./data/resolve.js";
import { DataError } from "./data/errors.js";
import { evaluateMeasure } from "./data/measure.js";
import { renderTemplate } from "./data/template.js";
import { closest } from "./data/values.js";
import { zodIssues } from "./issues.js";
import { mermaidKind } from "./diagram.js";
import { FACET_KINDS } from "./chart/facet.js";

export interface Analysis {
  context: DataContext;
  /** Errors and warnings, dataset issues first. */
  issues: Issue[];
  /** Ids of blocks with at least one error (renderers show a placeholder instead). */
  brokenBlocks: ReadonlySet<string>;
}

export type ValidationResult =
  | ({ ok: true; spec: ReportSpec } & Analysis)
  | ({ ok: false; spec?: ReportSpec } & Partial<Analysis> & { issues: Issue[] });

/** Reuse resolved datasets when the datasets object is unchanged (immutable updates keep identity). */
export interface AnalysisCache {
  datasets: ReportSpec["datasets"];
  context: DataContext;
  issues: Issue[];
}

function isMeasure(v: ValueOrMeasure | undefined): v is Measure {
  return typeof v === "object" && v !== null;
}

class BlockChecker {
  readonly issues: Issue[] = [];
  constructor(
    private readonly ctx: DataContext,
    private readonly path: string,
  ) {}

  error(code: string, rel: string, message: string, hint?: string): void {
    this.issues.push({ severity: "error", code, path: `${this.path}${rel}`, message, ...(hint ? { hint } : {}) });
  }

  warn(code: string, rel: string, message: string, hint?: string): void {
    this.issues.push({ severity: "warning", code, path: `${this.path}${rel}`, message, ...(hint ? { hint } : {}) });
  }

  dataset(id: string, rel: string): ResolvedDataset | undefined {
    const ds = this.ctx.datasets.get(id);
    if (!ds) {
      const guess = closest(id, this.ctx.datasets.keys());
      const known = [...this.ctx.datasets.keys()].join(", ") || "(none)";
      this.error("unknown_dataset", rel, `dataset '${id}' does not exist or failed to resolve`, guess ? `did you mean '${guess}'?` : `datasets: ${known}`);
    }
    return ds;
  }

  field(ds: ResolvedDataset, field: string | undefined, rel: string): void {
    if (field === undefined || ds.fields.some((f) => f.name === field)) return;
    const names = ds.fields.map((f) => f.name);
    const guess = closest(field, names);
    this.error("unknown_field", rel, `field '${field}' is not in dataset '${ds.id}'`, guess ? `did you mean '${guess}'?` : `fields: ${names.join(", ")}`);
  }

  value(v: ValueOrMeasure | undefined, rel: string): void {
    if (!isMeasure(v)) return;
    try {
      evaluateMeasure(v, this.ctx);
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      this.error(err.code, rel, err.message, err.hint);
    }
  }

  template(text: string | undefined, rel: string): void {
    if (text === undefined || !text.includes("{{")) return;
    for (const iss of renderTemplate(text, this.ctx).issues) this.error(iss.code, rel, iss.message);
  }
}

function checkBlock(block: Block, c: BlockChecker): void {
  switch (block.type) {
    case "text":
      c.template(block.content, ".content");
      return;
    case "callout":
      c.template(block.content, ".content");
      return;
    case "stat":
      c.value(block.value, ".value");
      c.value(block.compareTo, ".compareTo");
      c.template(block.description, ".description");
      return;
    case "kpi":
      block.items.forEach((item, i) => {
        c.value(item.value, `.items[${i}].value`);
        c.value(item.compareTo, `.items[${i}].compareTo`);
        if (item.sparkline) {
          const ds = c.dataset(item.sparkline.data, `.items[${i}].sparkline.data`);
          if (ds) {
            c.field(ds, item.sparkline.x, `.items[${i}].sparkline.x`);
            c.field(ds, item.sparkline.y, `.items[${i}].sparkline.y`);
          }
        }
      });
      return;
    case "comparison":
      block.metrics.forEach((m, i) => {
        if (m.values.length !== block.entities.length) {
          c.error("length_mismatch", `.metrics[${i}].values`, `metric '${m.label}' has ${m.values.length} values for ${block.entities.length} entities`, "provide one value per entity, in entity order");
        }
        m.values.forEach((v, j) => c.value(v, `.metrics[${i}].values[${j}]`));
      });
      return;
    case "table": {
      const ds = c.dataset(block.data, ".data");
      if (!ds) return;
      block.columns?.forEach((col, i) => c.field(ds, col.field, `.columns[${i}].field`));
      const sorts = block.sortBy === undefined ? [] : Array.isArray(block.sortBy) ? block.sortBy : [block.sortBy];
      sorts.forEach((k) => c.field(ds, k.replace(/^-/, ""), ".sortBy"));
      if (Array.isArray(block.totals)) block.totals.forEach((f, i) => c.field(ds, f, `.totals[${i}]`));
      return;
    }
    case "chart": {
      const ch = block.chart;
      const ds = c.dataset(ch.data, ".chart.data");
      const ys = Array.isArray(ch.y) ? ch.y : [ch.y];
      const secondary = ch.secondary ? (Array.isArray(ch.secondary.y) ? ch.secondary.y : [ch.secondary.y]) : [];
      if (ds) {
        c.field(ds, ch.x, ".chart.x");
        ys.forEach((y, i) => c.field(ds, y, Array.isArray(ch.y) ? `.chart.y[${i}]` : ".chart.y"));
        c.field(ds, ch.series, ".chart.series");
        c.field(ds, ch.value, ".chart.value");
        secondary.forEach((y) => c.field(ds, y, ".chart.secondary.y"));
        c.field(ds, ch.facet, ".chart.facet");
      }
      const radial = ch.kind === "pie" || ch.kind === "donut";
      if (radial && (ys.length > 1 || ch.series)) {
        c.error("chart_encoding", ".chart", `${ch.kind} charts take one y measure and no series`, "use a stacked bar for multi-measure shares");
      }
      const flowY = ch.kind === "dumbbell" ? 2 : ch.kind === "waterfall" || ch.kind === "funnel" ? 1 : undefined;
      if (flowY !== undefined && ys.length !== flowY) {
        c.error(
          "chart_encoding",
          ".chart.y",
          `${ch.kind} charts take exactly ${flowY === 1 ? "one y measure" : "two y fields [from, to]"}; got ${ys.length}`,
          flowY === 1 ? "plot one signed measure; use a grouped bar to compare several measures" : 'e.g. y: ["h1_2025", "h1_2026"]; pivot long data with a `pivot` transform first',
        );
      }
      if (flowY !== undefined && ch.series) {
        c.error("chart_encoding", ".chart.series", `${ch.kind} charts take no series`, "filter to one series, or use a grouped/stacked bar");
      }
      if (ch.kind === "heatmap" && ch.value === undefined) {
        c.error("chart_encoding", ".chart.value", "heatmap needs `value` (cell measure); x and y are categories");
      }
      if (ch.series && ys.length > 1 && flowY === undefined) {
        c.error("chart_encoding", ".chart", "use either several y fields or a series field, not both", "fold the y fields into long format with a `fold` transform, then set series");
      }
      if (ch.stack && ch.kind !== "bar" && ch.kind !== "area") c.warn("ignored_option", ".chart.stack", `stack has no effect on ${ch.kind} charts`);
      if (ch.horizontal && ch.kind !== "bar") c.warn("ignored_option", ".chart.horizontal", "horizontal applies only to bar charts");
      if (secondary.length && (radial || flowY !== undefined || ch.kind === "heatmap" || ch.kind === "scatter")) {
        c.warn("ignored_option", ".chart.secondary", `secondary axis is not supported on ${ch.kind} charts`);
      }
      if (ch.kind !== "waterfall") {
        if (ch.base !== undefined) c.warn("ignored_option", ".chart.base", "base applies only to waterfall charts");
        if (ch.total !== undefined) c.warn("ignored_option", ".chart.total", "total applies only to waterfall charts");
      }
      if (ch.facet !== undefined && !FACET_KINDS[ch.kind]) {
        c.warn("ignored_option", ".chart.facet", `facet has no effect on ${ch.kind} charts; one chart is drawn`, "small multiples work with bar, line, area and scatter charts");
      } else if (ch.facet !== undefined && secondary.length && ch.kind !== "scatter") {
        c.warn("ignored_option", ".chart.secondary", "faceted charts do not draw a secondary axis");
      }
      if (ds && ds.rows.length === 0) c.warn("empty_data", ".chart.data", `dataset '${ds.id}' has no rows; the chart will be empty`);
      return;
    }
    case "list":
      block.items.forEach((item, i) => {
        c.template(item.text, `.items[${i}].text`);
        c.template(item.detail, `.items[${i}].detail`);
      });
      return;
    case "diagram": {
      // Full Mermaid parsing needs a browser; catch the common mistake (no/unknown diagram type) here.
      const kind = mermaidKind(block.source);
      if (!kind || !(MERMAID_DIAGRAMS as readonly string[]).includes(kind)) {
        const guess = kind ? closest(kind, MERMAID_DIAGRAMS) : undefined;
        c.error("unknown_diagram", ".source", `Mermaid source must start with a diagram type, got '${kind ?? ""}'`, guess ? `did you mean '${guess}'?` : `start with one of: ${MERMAID_DIAGRAMS.slice(0, 6).join(", ")}, …`);
      }
      return;
    }
  }
}

/** Semantic analysis of an already schema-valid spec. */
export function analyzeReport(spec: ReportSpec, cache?: AnalysisCache): Analysis & { cache: AnalysisCache } {
  const reuse = cache && cache.datasets === spec.datasets;
  const resolved = reuse ? { context: cache.context, issues: cache.issues } : createDataContext(spec);
  // Locale/currency may change without datasets changing.
  const locale = spec.meta?.locale ?? "en-US";
  const currency = spec.meta?.currency ?? "USD";
  const context: DataContext =
    resolved.context.locale === locale && resolved.context.currency === currency ? resolved.context : { ...resolved.context, locale, currency };

  const issues: Issue[] = [...resolved.issues];
  const brokenBlocks = new Set<string>();
  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) issues.push({ severity: "error", code: "duplicate_id", path, message: `id '${id}' is already used at ${prev}`, hint: "ids must be unique across sections and blocks" });
    else seen.set(id, path);
  };

  spec.sections.forEach((section, s) => {
    const sp = `sections[${s}]`;
    claim(section.id, sp);
    if (section.blocks.length === 0) issues.push({ severity: "warning", code: "empty_section", path: sp, message: `section '${section.id}' has no blocks` });
    section.blocks.forEach((block, b) => {
      const bp = `${sp}.blocks[${b}]`;
      claim(block.id, bp);
      const checker = new BlockChecker(context, bp);
      checkBlock(block, checker);
      if (checker.issues.some((i) => i.severity === "error")) brokenBlocks.add(block.id);
      issues.push(...checker.issues);
    });
  });
  if (spec.sections.length === 0) issues.push({ severity: "warning", code: "empty_report", path: "sections", message: "report has no sections yet" });

  return { context, issues, brokenBlocks, cache: { datasets: spec.datasets, context: resolved.context, issues: resolved.issues } };
}

/** Schema + semantic validation of untrusted agent output. `ok` is false when any error-severity issue exists. */
export function validateReport(input: unknown): ValidationResult {
  const parsed = ReportSpec.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const { cache: _cache, ...analysis } = analyzeReport(parsed.data);
  const ok = !analysis.issues.some((i) => i.severity === "error");
  return ok ? { ok: true, spec: parsed.data, ...analysis } : { ok: false, spec: parsed.data, ...analysis };
}
