import { describe, expect, it } from "vitest";
import type { DataContext } from "../data/types.js";
import type { ChartModel } from "./types.js";
import { buildChart } from "./build.js";
import { chartToSvg } from "./svg.js";

const ctx: DataContext = {
  locale: "en-US",
  currency: "USD",
  datasets: new Map([
    [
      "d",
      {
        id: "d",
        rows: [
          { c: "<b>Tom & Jerry</b>", s: "x<y", v: 3 },
          { c: "Plain", s: "x<y", v: 5 },
          { c: "Plain", s: "a&b", v: 2 },
        ],
        fields: [
          { name: "c", type: "string", label: "Category" },
          { name: "s", type: "string", label: "Series" },
          { name: "v", type: "number", label: "Value <raw>" },
        ],
      },
    ],
  ]),
};

/** Tag balance check: every opened element is closed in order. */
function expectWellFormed(svg: string) {
  const stack: string[] = [];
  for (const [, close, name, selfClose] of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    if (selfClose) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  // No stray markup characters inside text nodes.
  for (const [, text] of svg.matchAll(/>([^<]*)</g)) expect(text).not.toMatch(/[<>]|&(?!(amp|lt|gt|quot|#39);)/);
}

describe("chartToSvg", () => {
  it("emits a standalone, well-formed, escaped SVG document", () => {
    const model = buildChart({ kind: "bar", data: "d", x: "c", y: "v", series: "s", reference: [{ value: 4, label: "Goal <&>", axis: "y" }] }, ctx, { width: 480, height: 240 });
    const svg = chartToSvg(model);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" width="480" height="240"')).toBe(true);
    expect(svg).toMatch(/<title>Bar chart of Value &lt;raw&gt; by Category<\/title>/);
    expect(svg).toContain("<desc>");
    expect(svg).toContain("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
    expect(svg).toContain("Goal &lt;&amp;&gt;");
    expect(svg).toContain("x&lt;y");
    expect(svg).not.toContain("<b>");
    expectWellFormed(svg);
  });

  it.each(["waterfall", "funnel", "dumbbell"] as const)("renders %s charts as well-formed, escaped SVG", (kind) => {
    const model = buildChart({ kind, data: "d", x: "c", y: kind === "dumbbell" ? ["v", "v"] : "v", ...(kind === "waterfall" ? { base: "first" as const } : {}) }, ctx, { width: 480, height: 240 });
    expect(model.empty).toBe(false);
    const svg = chartToSvg(model);
    expectWellFormed(svg);
    expect(svg).toContain("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
    expect(svg).toMatch(kind === "dumbbell" ? /<circle / : /<rect x=/);
  });

  it("resolves palette indices, sequential scales and named roles", () => {
    const model: ChartModel = {
      kind: "bar",
      width: 100,
      height: 100,
      plot: { x: 0, y: 0, width: 100, height: 100 },
      axes: [],
      grid: [],
      legend: [],
      description: "d",
      empty: false,
      warnings: [],
      marks: [
        { type: "rect", key: "a", series: "s", x: 0, y: 0, width: 1, height: 1, fill: 3, datum: { x: 1, y: 1, label: "a" } },
        { type: "rect", key: "b", series: "s", x: 0, y: 0, width: 1, height: 1, fill: { scale: 1 }, datum: { x: 1, y: 1, label: "b" } },
        { type: "rect", key: "c", series: "s", x: 0, y: 0, width: 1, height: 1, fill: { scale: 0 }, datum: { x: 1, y: 1, label: "c" } },
        { type: "rect", key: "d", series: "s", x: 0, y: 0, width: 1, height: 1, fill: "negative", datum: { x: 1, y: 1, label: "d" } },
      ],
    };
    const svg = chartToSvg(model, { palette: ["#000000", "#111111"], colors: { negative: "#ff0000" } });
    const fills = [...svg.matchAll(/<rect x="0"[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills).toEqual(["#111111", "#000000", "#ebebeb", "#ff0000"]);
  });

  it("draws the legend only when a top band is reserved", () => {
    const spec = { kind: "line" as const, data: "d", x: "c", y: "v", series: "s" };
    const top = chartToSvg(buildChart(spec, ctx, { width: 400, height: 200 }));
    const external = chartToSvg(buildChart(spec, ctx, { width: 400, height: 200, legend: "external" }));
    expect(top).toContain('class="legend"');
    expect(external).not.toContain('class="legend"');
  });

  it("renders a centered message for empty models", () => {
    const svg = chartToSvg(buildChart({ kind: "bar", data: "d", x: "c", y: "nope" }, ctx, { width: 300, height: 150 }));
    expect(svg).toContain(">No data to display</text>");
    expectWellFormed(svg);
  });

  it("rotates crowded bottom tick labels", () => {
    const many: DataContext = {
      ...ctx,
      datasets: new Map([["m", { id: "m", rows: Array.from({ length: 30 }, (_, i) => ({ c: `Long category ${i}`, v: i })), fields: [{ name: "c", type: "string", label: "C" }, { name: "v", type: "number", label: "V" }] }]]),
    };
    const svg = chartToSvg(buildChart({ kind: "bar", data: "m", x: "c", y: "v" }, many, { width: 400, height: 240 }));
    expect(svg).toMatch(/transform="rotate\(-35 /);
    expectWellFormed(svg);
  });
});
