// Spec (IR)
export * from "./spec.js";

// Data
export type * from "./data/types.js";
export { toNumber, parseDate, compareScalars, sortComparator, humanize } from "./data/values.js";
export { aggregate } from "./data/aggregate.js";
export { formatValue, formatCompact, formatDate, formatDelta, EMPTY_VALUE } from "./data/format.js";
export { parseCsv } from "./data/csv.js";
export { normalizeJson } from "./data/normalize.js";
export { compileExpr, ExprError } from "./data/expr.js";
export type { CompiledExpr } from "./data/expr.js";
export { applyTransforms } from "./data/transform.js";
export { resolveDatasets, createDataContext, inferFields } from "./data/resolve.js";
export { DataError } from "./data/errors.js";
export { evaluateMeasure, resolveValue } from "./data/measure.js";
export { renderTemplate } from "./data/template.js";
export { profileDataset, suggestCharts } from "./data/profile.js";
export { autoReport } from "./auto.js";

// Charts
export type * from "./chart/types.js";
export { buildChart, DEFAULT_PALETTE } from "./chart/build.js";
export { chartToSvg } from "./chart/svg.js";

// Layout
export type * from "./layout/types.js";
export { METRICS } from "./layout/metrics.js";
export { pageGeometry } from "./layout/geometry.js";
export { chartPlotHeight, estimateBlockHeight } from "./layout/estimate.js";
export { layoutReport } from "./layout/engine.js";
export { estimateTextWidth } from "./text.js";
export { uiStrings } from "./i18n.js";
export type { UiStrings } from "./i18n.js";

// Headless view models (adapters only map these to elements)
export { parseMarkdown, parseInline } from "./view/markdown.js";
export type { Inline, MdBlock } from "./view/markdown.js";
export { buildTableModel, buildKpiModels, buildComparisonModel, sparklinePath } from "./view/models.js";
export type { TableModel, TableCell, TableColumnModel, CellEmphasis, KpiModel, ComparisonModel, Sentiment } from "./view/models.js";

// Editing, validation, sessions
export { Op, applyOps, mergePatch } from "./ops.js";
export type { OpInput, ApplyResult } from "./ops.js";
export { validateReport, analyzeReport } from "./validate.js";
export type { Analysis, ValidationResult } from "./validate.js";
export { createReportSession, SpecError } from "./session.js";
export type { ReportSession, ReportSnapshot, SessionResult } from "./session.js";
export { inspectReport } from "./inspect.js";
export type { Inspection } from "./inspect.js";
export { createOpParser } from "./stream.js";
export type { OpChunk } from "./stream.js";
export { reportJsonSchema, opJsonSchema } from "./schema.js";
