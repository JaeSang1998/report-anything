import { useMemo, useState } from "react";
import type { PointerEvent } from "react";
import { buildChart, uiStrings } from "@report-anything/core";
import type { ChartModel, ChartSpec, DataContext, Datum, Mark } from "@report-anything/core";
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

/** SVG chart with hover tooltip and an HTML legend below the plot. */
export function ChartView({ spec, context, width, height, paletteSize = 8 }: ChartViewProps) {
  const model = useChartModel(spec, context, width, height);
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
    <figure className="ra-chart" style={{ width }}>
      <div className="ra-chart__canvas" style={{ height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={model.description}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {model.empty ? (
            <text className="ra-chart__empty" x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle">
              {uiStrings(context.locale).noData}
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
                return (
                  <rect key={m.key} data-i={i} x={m.x} y={m.y} width={m.width} height={m.height} rx={m.rx} fill={color(m.fill)} className={active ? "ra-mark ra-mark--active" : "ra-mark"} />
                );
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
          <div className="ra-chart__tooltip" style={{ left: Math.min(hover.x + 12, width - 180), top: Math.max(0, hover.y - 36) }}>
            {tip.label}
          </div>
        ) : null}
      </div>
      {model.legend.length > 0 ? (
        <figcaption className="ra-chart__legend">
          {model.legend.map((l) => (
            <span key={l.key} className="ra-chart__legend-item">
              <span className={`ra-chart__swatch ra-chart__swatch--${l.shape}`} style={{ background: color(l.color) }} />
              {l.label}
            </span>
          ))}
        </figcaption>
      ) : null}
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
