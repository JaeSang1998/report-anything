import type { ChartSpec } from "../spec.js";
import type { DataContext } from "../data/types.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { ChartBuildOptions, ChartModel } from "./types.js";
import { buildCartesian } from "./cartesian.js";
import { buildHeatmap, prepareHeatmap } from "./heatmap.js";
import { loadSource, prepareCategorical } from "./prepare.js";
import { buildRadial } from "./radial.js";
import { buildScatter, prepareScatter } from "./scatter.js";
import { DEFAULT_FONT_SIZE } from "./text.js";

/** 8 accessible, mutually distinguishable series colors (Tailwind 600 tones). */
export const DEFAULT_PALETTE: readonly string[] = ["#1f4e79", "#d1792b", "#3f8f5a", "#a23b3b", "#6b5b95", "#2f8f9d", "#8c6d46", "#7a7a7a"];

/** Pure: dataset rows → scene graph in pixel space [0,width]×[0,height]. Never throws on bad data; see `warnings`. */
export function buildChart(spec: ChartSpec, ctx: DataContext, opts: ChartBuildOptions): ChartModel {
  const width = Math.max(1, opts.width);
  const height = Math.max(1, opts.height);
  const o: SceneOptions = { width, height, fontSize: opts.fontSize ?? DEFAULT_FONT_SIZE, legendBand: (opts.legend ?? "top") === "top" };
  const { source, warnings } = loadSource(spec, ctx);
  const empty = (reason: string[]): ChartModel => ({
    kind: spec.kind,
    width,
    height,
    plot: { x: 0, y: 0, width, height },
    axes: [],
    grid: [],
    marks: [],
    legend: [],
    description: "No data to display.",
    empty: true,
    warnings: reason,
  });
  if (!source) return empty(warnings);
  const noRows = `No plottable rows in dataset "${spec.data}" for this chart.`;

  let scene: Scene;
  switch (spec.kind) {
    case "scatter": {
      const data = prepareScatter(spec, source, ctx);
      if (data.points.length === 0) return empty([noRows]);
      scene = buildScatter(spec, data, o, ctx);
      break;
    }
    case "heatmap": {
      const data = prepareHeatmap(spec, source, ctx);
      if (data.cells.length === 0) return empty([noRows]);
      scene = buildHeatmap(spec, data, o, ctx);
      break;
    }
    default: {
      const radial = spec.kind === "pie" || spec.kind === "donut";
      const prep = prepareCategorical(radial ? { ...spec, series: undefined, secondary: undefined } : spec, source, ctx);
      const series = radial ? prep.series.slice(0, 1) : prep.series;
      if (!series.some((s) => s.values.some((v) => v !== null && (!radial || v > 0)))) return empty([noRows]);
      scene = radial ? buildRadial(spec, prep, o, ctx) : buildCartesian(spec, prep, o, ctx);
      if (radial && (spec.series || spec.secondary || prep.series.length > 1)) {
        scene.warnings.unshift(`${spec.kind} charts show one measure; only "${prep.series[0]?.label}" is plotted.`);
      }
    }
  }
  return { kind: spec.kind, width, height, ...scene, empty: false };
}
