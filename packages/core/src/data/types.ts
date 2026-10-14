import type { ChartSpec, FieldType, Row, Scalar } from "../spec.js";

export interface FieldInfo {
  name: string;
  type: FieldType;
  /** Display label: FieldDef.label, else a humanized field name. */
  label: string;
  format?: string;
  description?: string;
}

export interface ResolvedDataset {
  id: string;
  rows: Row[];
  fields: FieldInfo[];
  source?: string;
  description?: string;
}

/** Formatting context shared by every renderer. */
export interface FormatContext {
  locale: string;
  currency: string;
}

/** Everything renderers need: the validated spec plus materialized datasets. */
export interface DataContext extends FormatContext {
  datasets: ReadonlyMap<string, ResolvedDataset>;
}

export interface FieldProfile {
  name: string;
  type: FieldType;
  /** Semantic role used by chart suggestion. */
  role: "measure" | "dimension" | "time" | "identifier";
  count: number;
  nulls: number;
  distinct: number;
  /** Up to 5 most frequent values for dimensions. */
  top?: Array<{ value: Scalar; count: number }>;
  min?: number | string;
  max?: number | string;
  sum?: number;
  mean?: number;
  /** Detected ratio scale (all values within [-1, 1] with fractional parts and name hints) → suggest percent. */
  suggestedFormat?: string;
}

export interface DatasetProfile {
  id: string;
  rowCount: number;
  fields: FieldProfile[];
}

export interface ChartSuggestion {
  /** Why this chart fits, one sentence (shown to agents). */
  reason: string;
  score: number;
  chart: ChartSpec;
}
