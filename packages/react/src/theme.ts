import { DEFAULT_PALETTE, METRICS } from "@report-anything/core";
import type { ColorRef, ReportSpec } from "@report-anything/core";
import type { CSSProperties } from "react";

/** METRICS groups that are not CSS lengths (ratios, page tables, solver-only thresholds). */
const NON_CSS: Record<string, true> = { glyph: true, templateChars: true, minWidth: true, page: true, web: true, "grid.columns": true };

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function flatten(obj: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (NON_CSS[path]) continue;
    if (typeof v === "number") out[`--ra-m-${path.split(".").map(kebab).join("-")}`] = `${v}px`;
    else if (v && typeof v === "object") flatten(v as Record<string, unknown>, path, out);
  }
}

/**
 * Layout metrics as CSS custom properties (`--ra-m-card-padding: 16px`, …). The stylesheet only reads these,
 * so the solver's height estimates and the DOM come from one source of truth.
 */
const METRIC_VARS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  flatten(METRICS as unknown as Record<string, unknown>, "", out);
  return out;
})();

export function rootStyle(spec: ReportSpec): CSSProperties {
  const style: Record<string, string> = { ...METRIC_VARS };
  const palette = spec.theme?.palette ?? DEFAULT_PALETTE;
  palette.forEach((c, i) => {
    style[`--ra-c${i + 1}`] = c;
  });
  if (spec.theme?.accent) style["--ra-accent"] = spec.theme.accent;
  return style as CSSProperties;
}

/** Map a renderer-agnostic ColorRef to a CSS color backed by theme variables. */
export function cssColor(ref: ColorRef | undefined, paletteSize: number): string {
  if (ref === undefined) return "none";
  if (typeof ref === "number") return `var(--ra-c${(ref % paletteSize) + 1})`;
  if (typeof ref === "object") {
    const pct = Math.round(8 + Math.min(1, Math.max(0, ref.scale)) * 92);
    return `color-mix(in srgb, var(--ra-c1) ${pct}%, var(--ra-surface))`;
  }
  return `var(--ra-${ref})`;
}
