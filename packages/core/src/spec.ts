import { z } from "zod";

/**
 * ReportSpec — the server-driven intermediate representation an agent authors.
 *
 * The agent decides WHAT to show (datasets, sections, blocks, chart encodings).
 * The layout engine decides HOW it is arranged (spans, rows, pages).
 * Renderers (React adapter, SVG serializer) draw the result.
 *
 * Every `.describe()` string is exported verbatim into the JSON Schema handed to LLMs.
 */

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const Id = z
  .string()
  .regex(ID_PATTERN, "ids start with a letter and contain only letters, digits, '_' or '-'")
  .describe("Stable identifier (letters, digits, '_' or '-'; starts with a letter). Ops address blocks/sections by id.");

export const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export const Row = z.record(z.string(), Scalar);
export type Row = z.infer<typeof Row>;

export const FieldType = z.enum(["number", "string", "date", "boolean"]);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Format grammar: `kind[:arg[:arg]]`.
 *  number | number:2 | integer | percent | percent:1 | currency | currency:KRW | currency:USD:2
 *  compact | compact:1 | date | date:year | date:quarter | date:month | date:week | date:day | datetime | text
 * `percent` expects ratios (0.125 → 12.5%).
 */
export const FORMAT_PATTERN =
  /^(number(:\d)?|integer|percent(:\d)?|currency(:[A-Z]{3})?(:\d)?|compact(:\d)?|date(:(year|quarter|month|week|day))?|datetime|text)$/;
export const Format = z
  .string()
  .regex(FORMAT_PATTERN, "unknown format; see the Format grammar")
  .describe(
    "Value format: number | number:<digits> | integer | percent[:digits] (expects ratios, 0.12 → 12%) | currency[:ISO][:digits] | compact[:digits] | date[:year|quarter|month|week|day] | datetime | text",
  );
export type Format = z.infer<typeof Format>;

export const Agg = z
  .enum(["sum", "avg", "min", "max", "count", "countDistinct", "median", "first", "last"])
  .describe("Aggregation applied to a field's values.");
export type Agg = z.infer<typeof Agg>;

/** A sort key: field name, prefixed with '-' for descending. */
export const SortKey = z.string().min(1).describe("Field name; prefix with '-' for descending (e.g. '-revenue').");

export const FieldDef = z
  .object({
    name: z.string().min(1),
    type: FieldType.optional().describe("Override the inferred type."),
    label: z.string().optional().describe("Human-readable label used in axes, legends and table headers."),
    format: Format.optional().describe("Default display format for this field."),
    description: z.string().optional(),
  })
  .describe("Field metadata override.");
export type FieldDef = z.infer<typeof FieldDef>;

// ─── Transforms ────────────────────────────────────────────────────────────────

const ExprString = z
  .string()
  .min(1)
  .describe(
    "Expression over row fields. Operators: + - * / % == != > >= < <= and or not, parentheses. Fields: bare identifiers or `backticked names`. Strings: 'single' or \"double\" quoted. Functions: abs round floor ceil min max sqrt log pow coalesce if year quarter month day lower upper concat len contains.",
  );

export const Transform = z.discriminatedUnion("op", [
  z.object({ op: z.literal("filter"), expr: ExprString }).describe("Keep rows where expr is truthy."),
  z.object({ op: z.literal("derive"), as: z.string().min(1), expr: ExprString }).describe("Add/overwrite a computed field."),
  z
    .object({
      op: z.literal("aggregate"),
      groupBy: z.array(z.string()).default([]),
      measures: z
        .array(
          z.object({
            field: z.string().optional().describe("Omit only for agg 'count'."),
            agg: Agg,
            as: z.string().min(1),
          }),
        )
        .min(1),
    })
    .describe("Group rows and aggregate measures."),
  z
    .object({ op: z.literal("sort"), by: z.union([SortKey, z.array(SortKey).min(1)]) })
    .describe("Sort rows; '-field' sorts descending."),
  z.object({ op: z.literal("limit"), count: z.number().int().positive(), offset: z.number().int().min(0).optional() }),
  z
    .object({
      op: z.literal("top"),
      n: z.number().int().positive(),
      by: z.string().describe("Numeric field ranked descending."),
      field: z.string().optional().describe("Category field relabelled for the remainder bucket."),
      othersLabel: z.string().optional().describe("If set, remaining rows are summed into one row with this label."),
    })
    .describe("Keep the top N rows by a measure, optionally bucketing the rest."),
  z
    .object({
      op: z.literal("fold"),
      fields: z.array(z.string()).min(1),
      as: z.tuple([z.string(), z.string()]).optional().describe("[keyField, valueField]; default ['key','value']."),
    })
    .describe("Wide → long: turn several columns into key/value rows."),
  z
    .object({
      op: z.literal("pivot"),
      index: z.array(z.string()).min(1),
      columns: z.string(),
      values: z.string(),
      agg: Agg.optional(),
    })
    .describe("Long → wide: one output column per distinct value of `columns`."),
  z
    .object({
      op: z.literal("timeUnit"),
      field: z.string(),
      unit: z.enum(["year", "quarter", "month", "week", "day"]),
      as: z.string().optional(),
    })
    .describe("Truncate dates to the start of a period (ISO date string)."),
  z
    .object({
      op: z.literal("bin"),
      field: z.string(),
      bins: z.number().int().positive().optional(),
      step: z.number().positive().optional(),
      as: z.string().optional(),
    })
    .describe("Bucket a numeric field; writes `<as>` (start) and `<as>_end`."),
  z
    .object({
      op: z.literal("window"),
      fn: z.enum(["cumsum", "diff", "pctChange", "share", "rank", "movingAvg", "rowNumber"]),
      field: z.string().optional(),
      as: z.string().min(1),
      groupBy: z.array(z.string()).optional(),
      sortBy: SortKey.optional(),
      size: z.number().int().positive().optional().describe("movingAvg window size (default 3)."),
    })
    .describe("Running / relative calculations within optional groups."),
  z
    .object({
      op: z.literal("lookup"),
      from: Id.describe("Dataset id to join."),
      on: z.union([z.string(), z.tuple([z.string(), z.string()])]).describe("Join key, or [leftKey, rightKey]."),
      fields: z.array(z.string()).optional().describe("Fields to copy (default: all)."),
    })
    .describe("Left join fields from another dataset."),
  z.object({ op: z.literal("select"), fields: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("rename"), fields: z.record(z.string(), z.string()) }),
]);
export type Transform = z.infer<typeof Transform>;

// ─── Datasets ──────────────────────────────────────────────────────────────────

export const Dataset = z
  .object({
    rows: z.array(Row).optional().describe("Tabular rows (array of flat objects)."),
    json: z.unknown().optional().describe("Any JSON (nested objects/arrays). Normalized into rows."),
    path: z.string().optional().describe("Dot path inside `json` to the array of records (e.g. 'data.items')."),
    unnest: z.string().optional().describe("Dot path of a nested array in each record to explode into rows."),
    csv: z.string().optional().describe("CSV text with a header row."),
    from: Id.optional().describe("Derive from another dataset id."),
    transform: z.array(Transform).optional().describe("Pipeline applied after loading."),
    fields: z.array(FieldDef).optional(),
    source: z.string().optional().describe("Provenance shown as citation (query, file, URL)."),
    description: z.string().optional(),
  })
  .refine((d) => [d.rows, d.json, d.csv, d.from].filter((v) => v !== undefined).length === 1, {
    message: "dataset needs exactly one of rows | json | csv | from",
  })
  .describe("A dataset. Provide exactly one source: rows, json, csv or from.");
export type Dataset = z.infer<typeof Dataset>;

/** Data-bound value: aggregates a dataset field so numbers are computed, never hallucinated. */
export const Measure = z
  .object({
    data: Id.describe("Dataset id."),
    field: z.string().optional().describe("Field to aggregate (omit for count)."),
    agg: Agg.default("sum"),
    where: ExprString.optional().describe("Row filter applied before aggregating."),
  })
  .describe("Computed value: agg(field) over a dataset.");
export type Measure = z.infer<typeof Measure>;

export const ValueOrMeasure = z.union([Scalar, Measure]);
export type ValueOrMeasure = z.infer<typeof ValueOrMeasure>;

// ─── Charts ────────────────────────────────────────────────────────────────────

export const ChartKind = z.enum(["bar", "line", "area", "scatter", "pie", "donut", "heatmap", "waterfall", "funnel", "dumbbell"]);
export type ChartKind = z.infer<typeof ChartKind>;

export const ChartSpec = z
  .object({
    kind: ChartKind,
    data: Id.describe("Dataset id."),
    x: z.string().describe("Category / time / numeric field on the x axis (category for pie/donut)."),
    y: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe("Measure field(s). Several fields become several series. Heatmap: the row category field."),
    series: z.string().optional().describe("Field whose values split data into colored series (long format)."),
    value: z.string().optional().describe("Heatmap cell value field; scatter bubble size field."),
    aggregate: Agg.optional().describe("How duplicate x(/series) rows combine. Default sum; scatter never aggregates."),
    stack: z.union([z.boolean(), z.literal("percent")]).optional().describe("Stack bar/area series; 'percent' normalizes to 100%."),
    horizontal: z.boolean().optional().describe("Horizontal bars (good for long category labels)."),
    sort: z.enum(["x", "-x", "y", "-y", "none"]).optional().describe("Category order. Default: time/number x ascending, otherwise data order."),
    limit: z.number().int().positive().optional().describe("Keep the top N categories by total."),
    others: z.boolean().optional().describe("With limit: merge the remainder into an 'Other' category."),
    secondary: z
      .object({
        y: z.union([z.string(), z.array(z.string()).min(1)]),
        format: Format.optional(),
        label: z.string().optional(),
      })
      .optional()
      .describe("Extra measure(s) drawn as lines on a right axis (e.g. growth rate over revenue bars)."),
    reference: z
      .array(z.object({ value: z.number(), label: z.string().optional(), axis: z.enum(["y", "x"]).default("y") }))
      .optional()
      .describe("Reference lines (targets, thresholds)."),
    xFormat: Format.optional(),
    yFormat: Format.optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    labels: z.boolean().optional().describe("Print value labels on marks."),
    legend: z.boolean().optional().describe("Force legend on/off (default: shown with 2+ series)."),
    curve: z.enum(["linear", "monotone", "step"]).optional(),
    base: z
      .enum(["zero", "first"])
      .optional()
      .describe("Waterfall only. 'first': the first row is the starting level (drawn as a total bar) and later rows are signed changes. Default 'zero'."),
    total: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe("Waterfall only. Append an ending total bar; a string sets its label. Default true when base is 'first', else false."),
  })
  .describe("Declarative chart encoding. The engine aggregates, scales and lays out marks.");
export type ChartSpec = z.infer<typeof ChartSpec>;

// ─── Blocks ────────────────────────────────────────────────────────────────────

const blockBase = {
  id: Id,
  title: z.string().optional(),
  caption: z.string().optional().describe("Small note under the block (methodology, footnote)."),
  span: z.number().int().min(1).max(12).optional().describe("Force a 12-column span. Usually omit; the layout engine decides."),
  sourceRefs: z.array(z.string()).optional().describe("Dataset ids or citations backing this block."),
};

const Markdown = z
  .string()
  .describe(
    "Markdown subset: paragraphs, '- ' bullets, '1. ' lists, **bold**, *italic*, `code`. Data placeholders: {{sum(sales.revenue) | currency:KRW}}, {{count(orders)}}, {{last(trend.value) | percent}}.",
  );

export const TextBlock = z.object({ ...blockBase, type: z.literal("text"), content: Markdown });

export const KpiItem = z.object({
  label: z.string(),
  value: ValueOrMeasure,
  format: Format.optional(),
  compareTo: ValueOrMeasure.optional().describe("Baseline; delta = (value - compareTo) / |compareTo|."),
  delta: z.number().optional().describe("Precomputed delta ratio (0.12 = +12%). Ignored when compareTo is set."),
  deltaLabel: z.string().optional().describe("e.g. 'vs last year'."),
  goodWhen: z.enum(["up", "down"]).optional().describe("Which delta direction is favorable (default up)."),
  sparkline: z.object({ data: Id, x: z.string(), y: z.string() }).optional(),
  description: z.string().optional(),
});
export type KpiItem = z.infer<typeof KpiItem>;

export const KpiBlock = z.object({ ...blockBase, type: z.literal("kpi"), items: z.array(KpiItem).min(1).max(8) });

export const ChartBlock = z.object({
  ...blockBase,
  type: z.literal("chart"),
  chart: ChartSpec,
  height: z.enum(["sm", "md", "lg"]).optional().describe("Plot height preset (default md)."),
});

export const TableColumn = z.object({
  field: z.string(),
  label: z.string().optional(),
  format: Format.optional(),
  align: z.enum(["left", "right", "center"]).optional(),
  emphasis: z
    .enum(["bar", "heat", "delta"])
    .optional()
    .describe("bar: inline data bar; heat: background intensity; delta: green/red by sign."),
});
export type TableColumn = z.infer<typeof TableColumn>;

export const TableBlock = z.object({
  ...blockBase,
  type: z.literal("table"),
  data: Id,
  columns: z.array(TableColumn).optional().describe("Default: all fields."),
  sortBy: z.union([SortKey, z.array(SortKey)]).optional(),
  maxRows: z.number().int().positive().optional(),
  totals: z.union([z.boolean(), z.array(z.string())]).optional().describe("Sum row for numeric (or listed) columns."),
  density: z.enum(["compact", "normal"]).optional(),
  paginate: z.boolean().optional().describe("Allow splitting across printed pages (default true)."),
});

export const CalloutBlock = z.object({
  ...blockBase,
  type: z.literal("callout"),
  tone: z.enum(["neutral", "info", "positive", "warning", "critical"]).default("info"),
  variant: z.enum(["insight", "recommendation", "note", "risk"]).optional(),
  content: Markdown,
});

export const ListBlock = z.object({
  ...blockBase,
  type: z.literal("list"),
  style: z.enum(["bullet", "numbered", "check"]).default("bullet"),
  items: z
    .array(
      z.object({
        text: z.string(),
        detail: z.string().optional(),
        tag: z.string().optional().describe("Short badge: owner, priority, due date."),
        tone: z.enum(["neutral", "info", "positive", "warning", "critical"]).optional(),
      }),
    )
    .min(1),
});

export const ComparisonBlock = z.object({
  ...blockBase,
  type: z.literal("comparison"),
  entities: z.array(z.string()).min(2).max(4).describe("Column headers being compared (periods, segments, products)."),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        values: z.array(ValueOrMeasure).min(2).max(4),
        format: Format.optional(),
        goodWhen: z.enum(["up", "down"]).optional(),
      }),
    )
    .min(1),
  showDelta: z.boolean().optional().describe("Show change from first to last entity (default true)."),
});

/** Diagram types a Mermaid source may start with (after optional `---` front matter and `%%` comments). */
export const MERMAID_DIAGRAMS = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "quadrantChart",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "gitGraph",
  "requirementDiagram",
  "C4Context",
] as const;

export const DiagramBlock = z.object({
  ...blockBase,
  type: z.literal("diagram"),
  syntax: z.literal("mermaid").default("mermaid").describe("Diagram language. Only Mermaid for now."),
  source: z
    .string()
    .min(1)
    .describe(
      "Mermaid source, e.g. 'flowchart LR\\n  A[Ticket] --> B{P1?}\\n  B -- yes --> C[Page on-call]'. Use for processes, sequences, org/ER structures, timelines — not for data charts (use chart blocks, which bind to datasets).",
    ),
  height: z.enum(["sm", "md", "lg"]).optional().describe("Box the diagram is fitted into (default md)."),
});

export const Block = z.discriminatedUnion("type", [TextBlock, KpiBlock, ChartBlock, TableBlock, CalloutBlock, ListBlock, ComparisonBlock, DiagramBlock]);
export type Block = z.infer<typeof Block>;
export type BlockType = Block["type"];
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

// ─── Sections & report ─────────────────────────────────────────────────────────

export const LayoutPattern = z
  .enum(["auto", "stack", "main-side", "side-main", "split", "thirds", "quarters"])
  .describe(
    "Row pattern. auto: engine decides by content; stack: full width; main-side: 8/4; side-main: 4/8; split: 6/6; thirds: 4/4/4; quarters: 3/3/3/3.",
  );
export type LayoutPattern = z.infer<typeof LayoutPattern>;

export const Section = z.object({
  id: Id,
  title: z.string().optional(),
  description: z.string().optional().describe("One or two sentence lead-in."),
  role: z.enum(["summary", "analysis", "detail", "appendix"]).optional(),
  layout: LayoutPattern.optional(),
  breakBefore: z.boolean().optional().describe("Start this section on a new printed page."),
  blocks: z.array(Block),
});
export type Section = z.infer<typeof Section>;

export const PageSize = z.enum(["A4", "Letter"]);
export type PageSize = z.infer<typeof PageSize>;

export const ReportSpec = z
  .object({
    version: z.literal("1").default("1"),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    summary: Markdown.optional().describe("Lead paragraph under the title."),
    meta: z
      .object({
        author: z.string().optional(),
        date: z.string().optional(),
        audience: z.enum(["executive", "analyst", "general"]).optional(),
        locale: z.string().optional().describe("BCP-47 locale for number/date formatting (default en-US)."),
        currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Default ISO currency (default USD)."),
        tags: z.array(z.string()).optional(),
      })
      .optional(),
    page: z
      .object({
        size: PageSize.default("A4"),
        orientation: z.enum(["portrait", "landscape"]).default("portrait"),
        targetPages: z.number().int().positive().optional().describe("Intended length; the engine reports overruns."),
      })
      .optional(),
    theme: z
      .object({
        palette: z.array(z.string()).min(1).optional().describe("Series colors (CSS colors)."),
        accent: z.string().optional(),
        density: z.enum(["comfortable", "compact"]).optional(),
      })
      .optional(),
    datasets: z.record(Id, Dataset).default({}),
    sections: z.array(Section),
  })
  .describe("A complete report. Datasets hold data; sections hold blocks that reference datasets by id.");
export type ReportSpec = z.infer<typeof ReportSpec>;
/** Input shape accepted before defaults are applied (what agents write). */
export type ReportSpecInput = z.input<typeof ReportSpec>;

// ─── Shared diagnostics ────────────────────────────────────────────────────────

export interface Issue {
  severity: "error" | "warning";
  /** Stable machine code, e.g. `unknown_field`, `unknown_dataset`, `page_overflow`. */
  code: string;
  /** Dotted path into the spec, e.g. `sections[1].blocks[0].chart.y`. */
  path: string;
  message: string;
  /** Actionable fix suggestion for agents. */
  hint?: string;
}
