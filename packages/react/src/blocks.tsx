import { useMemo } from "react";
import type { ComponentType } from "react";
import {
  buildComparisonModel,
  buildKpiModels,
  buildTableModel,
  chartPlotHeight,
  estimateTextWidth,
  METRICS,
  sparklinePath,
  uiStrings,
} from "@report-anything/core";
import type { BlockOf, BlockType, Cell, DataContext, LayoutMode, TableCell } from "@report-anything/core";
import { ChartView } from "./ChartView.js";
import { Markdown } from "./Markdown.js";

/** Rows of a table rendered on one printed page. */
export interface TableSlice {
  from: number;
  to: number;
  continued: boolean;
}

export interface BlockProps<T extends BlockType = BlockType> {
  block: BlockOf<T>;
  context: DataContext;
  /** Grid cell from the layout plan: pixel width and estimated height. */
  cell: Cell;
  mode: LayoutMode;
  paletteSize: number;
  slice?: TableSlice;
}

/** Per-type body overrides — the SDUI extension point. Titles and captions stay with the frame. */
export type BlockComponents = { [T in BlockType]?: ComponentType<BlockProps<T>> };

function TextBody({ block, context }: BlockProps<"text">) {
  return <Markdown text={block.content} context={context} />;
}

function CalloutBody({ block, context }: BlockProps<"callout">) {
  return <Markdown className="ra-callout__body" text={block.content} context={context} />;
}

/** Marker shape carries tone, so status never depends on color alone. */
const TONE_MARK: Record<string, string> = { warning: "!", critical: "!", positive: "✓" };

function ListBody({ block }: BlockProps<"list">) {
  return (
    <ul className={`ra-list ra-list--${block.style}`}>
      {block.items.map((item, i) => {
        const tone = item.tone && TONE_MARK[item.tone] ? item.tone : undefined;
        const mark = tone ? TONE_MARK[tone] : block.style === "numbered" ? `${i + 1}.` : block.style === "check" ? "☐" : "•";
        return (
          <li key={i} className="ra-list__item">
            <span className={tone ? `ra-list__marker ra-tone--${tone}` : "ra-list__marker"}>{mark}</span>
            <span className="ra-list__body">
              <span className="ra-list__text">
                {item.text}
                {item.tag ? <span className="ra-list__tag">{item.tag}</span> : null}
              </span>
              {item.detail ? <span className="ra-list__detail">{item.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const ARROW: Record<string, string> = { positive: "▲", negative: "▼", neutral: "■" };

function KpiBody({ block, context, cell }: BlockProps<"kpi">) {
  const items = useMemo(() => buildKpiModels(block, context), [block, context]);
  const K = METRICS.kpi;
  // Same rule as the layout estimate: as many ≥ minItemWidth items per row as fit.
  const perRow = Math.max(1, Math.min(items.length, Math.floor((cell.width + K.columnGap) / (K.minItemWidth + K.columnGap))));
  const itemWidth = Math.min(K.maxItemWidth, (cell.width - (perRow - 1) * K.columnGap) / perRow);
  const hasDesc = items.some((i) => i.description);
  return (
    <div className="ra-kpis" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, ${K.maxItemWidth}px))` }}>
      {items.map((k, i) => {
        // Never clip a headline number: fall back to compact magnitude when the full figure is too wide.
        const value = estimateTextWidth(k.text, K.value.fontSize) <= itemWidth ? k.text : k.compactText;
        return (
          <div key={i} className="ra-kpi">
            <div className="ra-kpi__label">{k.label}</div>
            <div className="ra-kpi__value" title={value === k.text ? undefined : k.text}>
              {value}
            </div>
            <div className="ra-kpi__delta">
              {k.delta ? (
                <>
                  <span className={`ra-delta ra-delta--${k.delta.sentiment}`}>
                    {ARROW[k.delta.sentiment]} {k.delta.text}
                  </span>
                  {k.delta.label ? <span className="ra-kpi__baseline"> {k.delta.label}</span> : null}
                </>
              ) : null}
            </div>
            {hasDesc ? <div className="ra-kpi__desc">{k.description ?? ""}</div> : null}
            {k.sparkline ? (
              <svg className="ra-kpi__spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden>
                <path d={sparklinePath(k.sparkline, 120, 24)} vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ChartBody({ block, context, cell, paletteSize }: BlockProps<"chart">) {
  return <ChartView spec={block.chart} context={context} width={Math.max(120, Math.floor(cell.width))} height={chartPlotHeight(block)} paletteSize={paletteSize} />;
}

function TableCellView({ c, align }: { c: TableCell; align: string }) {
  const e = c.emphasis;
  const cls = `ra-align--${align}${e?.kind === "delta" ? ` ra-delta ra-delta--${e.sentiment}` : ""}`;
  if (e?.kind === "heat") {
    return (
      <td className={cls} style={{ background: `color-mix(in srgb, var(--ra-c1) ${Math.round(4 + e.t * 30)}%, transparent)` }}>
        {c.text}
      </td>
    );
  }
  if (e?.kind === "bar") {
    return (
      <td className={cls}>
        <span className="ra-databar">
          <span className={e.negative ? "ra-databar__fill ra-databar__fill--neg" : "ra-databar__fill"} style={{ width: `${Math.round(e.ratio * 100)}%` }} />
          <span className="ra-databar__text">{c.text}</span>
        </span>
      </td>
    );
  }
  return <td className={cls}>{c.text}</td>;
}

function TableBody({ block, context, slice }: BlockProps<"table">) {
  const model = useMemo(() => buildTableModel(block, context), [block, context]);
  const rows = slice ? model.rows.slice(slice.from, slice.to) : model.rows;
  const last = !slice || slice.to >= model.rows.length;
  return (
    <>
      <div className="ra-table-scroll">
        <table className={`ra-table${block.density === "compact" ? " ra-table--compact" : ""}`}>
          <thead>
            <tr>
              {model.columns.map((c) => (
                <th key={c.field} className={`ra-align--${c.align}`} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                {r.cells.map((c, j) => (
                  <TableCellView key={c.field} c={c} align={model.columns[j]!.align} />
                ))}
              </tr>
            ))}
          </tbody>
          {model.totals && last ? (
            <tfoot>
              <tr>
                {model.totals.map((c, j) => (
                  <td key={c.field} className={`ra-align--${model.columns[j]!.align}`}>
                    {c.text}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {model.hiddenRows > 0 && last ? <div className="ra-table__note">{uiStrings(context.locale).showingRows(model.rows.length, model.totalRows)}</div> : null}
    </>
  );
}

function ComparisonBody({ block, context, cell }: BlockProps<"comparison">) {
  const model = useMemo(() => buildComparisonModel(block, context), [block, context]);
  const showDelta = model.rows.some((r) => r.delta);
  const C = METRICS.comparison;
  const columnWidth = (cell.width - C.labelColumn) / (model.entities.length + (showDelta ? 1 : 0)) - 16;
  // One precision for the whole table: compact every value if any full value would not fit its column.
  const compact = model.rows.some((r) => r.cells.some((c) => estimateTextWidth(c.text, METRICS.table.fontSize) > columnWidth));
  return (
    <div className="ra-table-scroll">
      <table className="ra-comparison">
        <thead>
          <tr>
            <th scope="col" />
            {model.entities.map((e) => (
              <th key={e} scope="col" className="ra-align--right">
                {e}
              </th>
            ))}
            {showDelta ? <th className="ra-align--right">{uiStrings(context.locale).change}</th> : null}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {r.cells.map((c, i) => (
                <td key={i} className="ra-align--right" title={compact ? c.text : undefined}>
                  {compact ? c.compactText : c.text}
                </td>
              ))}
              {showDelta ? <td className={`ra-align--right${r.delta ? ` ra-delta ra-delta--${r.delta.sentiment}` : ""}`}>{r.delta ? `${ARROW[r.delta.sentiment]} ${r.delta.text}` : ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const DEFAULT_BLOCKS: { [T in BlockType]: ComponentType<BlockProps<T>> } = {
  text: TextBody,
  callout: CalloutBody,
  list: ListBody,
  kpi: KpiBody,
  chart: ChartBody,
  table: TableBody,
  comparison: ComparisonBody,
};
