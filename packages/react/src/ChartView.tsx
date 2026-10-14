import { useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { buildChart, buildFacetCharts, uiStrings } from "@report-anything/core";
import type { ChartModel, ChartSpec, DataContext, Datum, LegendItem, Mark } from "@report-anything/core";
import { cssColor } from "./theme.js";

export interface ChartViewProps {
  spec: ChartSpec;
  context: DataContext;
  width: number;
  height: number;
  /** Number of palette colors (wraps series colors). Default 8. */
  paletteSize?: number;
}

/** Headless hook: the pure chart scene graph for custom renderers. */
export function useChartModel(spec: ChartSpec, context: DataContext, width: number, height: number): ChartModel {
  return useMemo(() => buildChart(spec, context, { width, height, legend: "external" }), [spec, context, width, height]);
}

function datumOf(mark: Mark): Datum | undefined {
  return mark.type === "rect" || mark.type === "circle" || mark.type === "arc" ? mark.datum : undefined;
}

export interface ChartSvgProps {
  model: ChartModel;
  /** Locale of the "no data" message. */
  locale: string;
  paletteSize?: number;
}

/** One chart model as SVG (model.width × model.height) with a hover tooltip. Draws no legend. */
export function ChartSvg({ model, locale, paletteSize = 8 }: ChartSvgProps) {
  const { width, height } = model;
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const color = (ref: Parameters<typeof cssColor>[0]) => cssColor(ref, paletteSize);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest("[data-i]");
    if (!target) return setHover(null);
    const box = e.currentTarget.getBoundingClientRect();
    setHover({ i: Number(target.getAttribute("data-i")), x: e.clientX - box.left, y: e.clientY - box.top });
  };

  const hovered = hover ? model.marks[hover.i] : undefined;
  const tip = hovered ? datumOf(hovered) : undefined;

  return (
    <div className="ra-chart__canvas" style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={model.description} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {model.empty ? (
          <text className="ra-chart__empty" x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle">
            {uiStrings(locale).noData}
          </text>
        ) : null}
        <g className="ra-chart__grid">
          {model.grid.map((g, i) => (
            <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
          ))}
        </g>
        {model.marks.map((m, i) => {
          const active = hover?.i === i;
          switch (m.type) {
            case "rect":
              return <rect key={m.key} data-i={i} x={m.x} y={m.y} width={m.width} height={m.height} rx={m.rx} fill={color(m.fill)} className={active ? "ra-mark ra-mark--active" : "ra-mark"} />;
            case "circle":
              return <circle key={m.key} data-i={i} cx={m.cx} cy={m.cy} r={m.r} fill={color(m.fill)} fillOpacity={m.opacity} className={active ? "ra-mark ra-mark--active" : "ra-mark"} />;
            case "arc":
              return <path key={m.key} data-i={i} d={m.d} fill={color(m.fill)} className={active ? "ra-mark ra-mark--active" : "ra-mark"} />;
            case "path":
              return m.variant === "area" ? (
                <path key={m.key} d={m.d} fill={color(m.fill ?? m.stroke)} fillOpacity={m.opacity ?? 0.25} stroke="none" />
              ) : (
                <path key={m.key} d={m.d} fill="none" stroke={color(m.stroke ?? m.fill)} strokeWidth={2} strokeOpacity={m.opacity} strokeDasharray={m.dash ? "4 3" : undefined} strokeLinejoin="round" strokeLinecap="round" />
              );
            case "line":
              return (
                <g key={m.key} className="ra-chart__ref">
                  <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={color(m.stroke)} strokeDasharray={m.dash ? "4 4" : undefined} />
                  {m.label ? (
                    <text x={Math.max(m.x1, m.x2) - 4} y={Math.min(m.y1, m.y2) - 4} textAnchor="end" fill={color(m.stroke)}>
                      {m.label}
                    </text>
                  ) : null}
                </g>
              );
            case "text":
              return (
                <text key={m.key} x={m.x} y={m.y} textAnchor={m.anchor} dominantBaseline={m.baseline === "hanging" ? "hanging" : m.baseline === "middle" ? "central" : "auto"} fill={color(m.fill)} className={`ra-chart__text ra-chart__text--${m.role}`}>
                  {m.text}
                </text>
              );
          }
        })}
        {model.axes.map((axis) => (
          <g key={axis.position} className={`ra-chart__axis ra-chart__axis--${axis.position}`}>
            {axis.position === "bottom" || axis.position === "top" ? <line {...axis.line} /> : null}
            {axis.ticks.map((t, i) => {
              const vertical = axis.position === "left" || axis.position === "right";
              const x = vertical ? (axis.position === "left" ? axis.line.x1 - 6 : axis.line.x1 + 6) : t.offset;
              const y = vertical ? t.offset : axis.position === "bottom" ? axis.line.y1 + 14 : axis.line.y1 - 6;
              const anchor = vertical ? (axis.position === "left" ? "end" : "start") : axis.labelAngle ? "end" : "middle";
              return (
                <text key={i} x={x} y={y} textAnchor={anchor} dominantBaseline={vertical ? "central" : "auto"} transform={axis.labelAngle ? `rotate(${axis.labelAngle} ${x} ${y})` : undefined}>
                  {t.label}
                </text>
              );
            })}
            {axis.title ? <AxisTitle axis={axis} model={model} /> : null}
          </g>
        ))}
      </svg>
      {tip && hover ? (
        <div className="ra-chart__tooltip" style={{ left: Math.max(0, Math.min(hover.x + 12, width - 180)), top: Math.max(0, hover.y - 36) }}>
          {tip.label}
        </div>
      ) : null}
    </div>
  );
}

function ChartLegend({ items, paletteSize }: { items: readonly LegendItem[]; paletteSize: number }) {
  if (items.length === 0) return null;
  return (
    <figcaption className="ra-chart__legend">
      {items.map((l) => (
        <span key={l.key} className="ra-chart__legend-item">
          <span className={`ra-chart__swatch ra-chart__swatch--${l.shape}`} style={{ background: cssColor(l.color, paletteSize) }} />
          {l.label}
        </span>
      ))}
    </figcaption>
  );
}

/** SVG chart with hover tooltip and an HTML legend below the plot. */
export function ChartView({ spec, context, width, height, paletteSize = 8 }: ChartViewProps) {
  const model = useChartModel(spec, context, width, height);
  return (
    <figure className="ra-chart" style={{ width }}>
      <ChartSvg model={model} locale={context.locale} paletteSize={paletteSize} />
      <ChartLegend items={model.legend} paletteSize={paletteSize} />
    </figure>
  );
}

export interface FacetChartViewProps {
  spec: ChartSpec;
  context: DataContext;
  /** Width of the whole panel grid. */
  width: number;
  columns: number;
  /** One grid cell: panel label line + panel SVG. */
  panelHeight: number;
  paletteSize?: number;
}

/** Small multiples: a grid of labelled panels sharing scales, with one HTML legend below. */
export function FacetChartView({ spec, context, width, columns, panelHeight, paletteSize = 8 }: FacetChartViewProps) {
  const facets = useMemo(() => buildFacetCharts(spec, context, { width, panelHeight, columns }), [spec, context, width, panelHeight, columns]);
  const { panels } = facets;
  if (panels.length === 0) return <ChartView spec={spec} context={context} width={width} height={panelHeight} paletteSize={paletteSize} />;
  // Left-column panels carry the value axis, so tracks come from the first row's panel widths.
  const tracks = panels
    .slice(0, Math.min(columns, panels.length))
    .map((p) => `${p.model.width}px`)
    .join(" ");
  return (
    <figure className="ra-chart ra-facet" style={{ width }}>
      <div className="ra-facet__grid" style={{ gridTemplateColumns: tracks }}>
        {panels.map((p) => (
          <div key={p.key} className="ra-facet__panel">
            <div className="ra-facet__label" style={{ paddingLeft: p.model.plot.x, maxWidth: p.model.width }} title={p.label}>
              {p.label}
            </div>
            <ChartSvg model={p.model} locale={context.locale} paletteSize={paletteSize} />
          </div>
        ))}
      </div>
      <ChartLegend items={facets.legend} paletteSize={paletteSize} />
    </figure>
  );
}

function AxisTitle({ axis, model }: { axis: ChartModel["axes"][number]; model: ChartModel }) {
  const { plot } = model;
  switch (axis.position) {
    case "left":
      return (
        <text className="ra-chart__axis-title" x={plot.x} y={Math.max(10, plot.y - 10)} textAnchor="start">
          {axis.title}
        </text>
      );
    case "right":
      return (
        <text className="ra-chart__axis-title" x={plot.x + plot.width} y={Math.max(10, plot.y - 10)} textAnchor="end">
          {axis.title}
        </text>
      );
    case "bottom":
      return (
        <text className="ra-chart__axis-title" x={plot.x + plot.width / 2} y={model.height - 4} textAnchor="middle">
          {axis.title}
        </text>
      );
    default:
      return null;
  }
}
