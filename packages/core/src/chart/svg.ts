import type { Axis, ChartModel, ColorRef, LegendItem, Mark } from "./types.js";
import { LEGEND_BAND, PAD, TICK_GAP } from "./axes.js";
import { DEFAULT_PALETTE } from "./build.js";
import { DEFAULT_FONT_SIZE, fitText } from "./text.js";
import { estimateTextWidth } from "../text.js";

type ColorRole = "fg" | "muted" | "grid" | "positive" | "negative" | "surface";

export interface SvgOptions {
  palette?: readonly string[];
  fontFamily?: string;
  colors?: Partial<Record<ColorRole, string>>;
}

const DEFAULT_COLORS: Record<ColorRole, string> = {
  fg: "#161616",
  muted: "#8a8a8a",
  grid: "#e2e2e2",
  positive: "#0f7a3d",
  negative: "#b42318",
  surface: "#ffffff",
};
const DEFAULT_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Lightest end of the sequential scale, as a mix fraction of the base color into the surface. */
const SCALE_FLOOR = 0.08;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function parseHex(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linear RGB blend of two hex colors; non-hex inputs fall back to the nearer endpoint. */
function lerpHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  return `#${ca.map((v, i) => Math.round(v + (cb[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

const BASELINES: Record<"auto" | "middle" | "hanging", string> = { auto: "", middle: ' dominant-baseline="central"', hanging: ' dominant-baseline="hanging"' };

/** Standalone SVG document for a chart model (xmlns, viewBox, a11y title/desc, xml-escaped text). */
export function chartToSvg(model: ChartModel, opts: SvgOptions = {}): string {
  const palette = opts.palette && opts.palette.length > 0 ? opts.palette : DEFAULT_PALETTE;
  const colors = { ...DEFAULT_COLORS, ...opts.colors };
  const fs = DEFAULT_FONT_SIZE;
  const { width: W, height: H } = model;
  const base = palette[0] ?? DEFAULT_PALETTE[0]!;
  const light = lerpHex(colors.surface, base, SCALE_FLOOR);
  const color = (ref: ColorRef): string => {
    if (typeof ref === "number") return palette[((ref % palette.length) + palette.length) % palette.length]!;
    if (typeof ref === "object") return lerpHex(light, base, Math.max(0, Math.min(1, ref.scale)));
    return colors[ref];
  };
  const tip = (label: string) => `<title>${esc(label)}</title>`;
  const out: string[] = [];
  const titleEnd = model.description.indexOf(" with ");
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(W)} ${num(H)}" width="${num(W)}" height="${num(H)}" role="img" font-family="${esc(opts.fontFamily ?? DEFAULT_FONT)}" font-size="${fs}">`,
    `<title>${esc(titleEnd > 0 ? model.description.slice(0, titleEnd) : model.description)}</title>`,
    `<desc>${esc(model.description)}</desc>`,
    `<rect width="${num(W)}" height="${num(H)}" fill="${color("surface")}"/>`,
  );
  if (model.empty) {
    out.push(`<text x="${num(W / 2)}" y="${num(H / 2)}" text-anchor="middle" dominant-baseline="central" fill="${color("muted")}">No data to display</text>`, "</svg>");
    return out.join("\n");
  }

  if (model.grid.length > 0) {
    out.push(`<g stroke="${color("grid")}" stroke-width="1">`);
    for (const g of model.grid) out.push(`<line x1="${num(g.x1)}" y1="${num(g.y1)}" x2="${num(g.x2)}" y2="${num(g.y2)}"/>`);
    out.push("</g>");
  }
  for (const axis of model.axes) out.push(axisSvg(axis, W, H, fs, color("grid"), color("muted")));

  for (const m of model.marks) out.push(markSvg(m, color, tip, fs));

  // The legend is drawn only when the model reserved the band above the plot (ChartBuildOptions.legend "top").
  if (model.legend.length > 0 && model.plot.y >= LEGEND_BAND) out.push(legendSvg(model.legend, W, fs, color));
  out.push("</svg>");
  return out.join("\n");
}

function axisSvg(axis: Axis, W: number, H: number, fs: number, stroke: string, fill: string): string {
  const { line: l } = axis;
  const parts = [`<g class="axis-${axis.position}" fill="${fill}">`, `<line x1="${num(l.x1)}" y1="${num(l.y1)}" x2="${num(l.x2)}" y2="${num(l.y2)}" stroke="${stroke}"/>`];
  for (const t of axis.ticks) {
    const label = esc(t.label);
    switch (axis.position) {
      case "bottom":
      case "top": {
        const y = axis.position === "bottom" ? l.y1 + TICK_GAP : l.y1 - TICK_GAP;
        const baseline = axis.position === "bottom" ? ' dominant-baseline="hanging"' : "";
        if (axis.labelAngle) {
          parts.push(`<text x="${num(t.offset)}" y="${num(y)}" text-anchor="end"${baseline} transform="rotate(${axis.labelAngle} ${num(t.offset)} ${num(y)})">${label}</text>`);
        } else {
          parts.push(`<text x="${num(t.offset)}" y="${num(y)}" text-anchor="middle"${baseline}>${label}</text>`);
        }
        break;
      }
      case "left":
        parts.push(`<text x="${num(l.x1 - TICK_GAP)}" y="${num(t.offset)}" text-anchor="end" dominant-baseline="central">${label}</text>`);
        break;
      case "right":
        parts.push(`<text x="${num(l.x1 + TICK_GAP)}" y="${num(t.offset)}" text-anchor="start" dominant-baseline="central">${label}</text>`);
        break;
    }
  }
  if (axis.title) {
    const title = esc(axis.title);
    const midX = (l.x1 + l.x2) / 2;
    const midY = (l.y1 + l.y2) / 2;
    if (axis.position === "bottom") parts.push(`<text x="${num(midX)}" y="${num(H - PAD)}" text-anchor="middle" font-weight="600">${title}</text>`);
    else if (axis.position === "top") parts.push(`<text x="${num(midX)}" y="${num(PAD + fs)}" text-anchor="middle" font-weight="600">${title}</text>`);
    else {
      const x = axis.position === "left" ? PAD + fs / 2 : W - PAD - fs / 2;
      const angle = axis.position === "left" ? -90 : 90;
      parts.push(`<text x="${num(x)}" y="${num(midY)}" text-anchor="middle" dominant-baseline="central" font-weight="600" transform="rotate(${angle} ${num(x)} ${num(midY)})">${title}</text>`);
    }
  }
  parts.push("</g>");
  return parts.join("\n");
}

function markSvg(m: Mark, color: (ref: ColorRef) => string, tip: (label: string) => string, fs: number): string {
  switch (m.type) {
    case "rect":
      return `<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(m.width)}" height="${num(m.height)}"${m.rx ? ` rx="${m.rx}"` : ""} fill="${color(m.fill)}">${tip(m.datum.label)}</rect>`;
    case "path": {
      const dash = m.dash ? ' stroke-dasharray="5 4"' : "";
      if (m.variant === "area") {
        return `<path d="${esc(m.d)}" fill="${m.fill !== undefined ? color(m.fill) : "none"}" fill-opacity="${m.opacity ?? 1}" stroke="none"/>`;
      }
      const opacity = m.opacity !== undefined ? ` stroke-opacity="${m.opacity}"` : "";
      return `<path d="${esc(m.d)}" fill="none" stroke="${m.stroke !== undefined ? color(m.stroke) : "none"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${opacity}${dash}/>`;
    }
    case "circle": {
      const opacity = m.opacity !== undefined ? ` fill-opacity="${m.opacity}"` : "";
      return `<circle cx="${num(m.cx)}" cy="${num(m.cy)}" r="${num(m.r)}" fill="${color(m.fill)}"${opacity} stroke="${color("surface")}" stroke-width="1">${tip(m.datum.label)}</circle>`;
    }
    case "arc":
      return `<path d="${esc(m.d)}" fill="${color(m.fill)}" stroke="${color("surface")}" stroke-width="1">${tip(m.datum.label)}</path>`;
    case "text": {
      const size = m.role === "center-value" ? ` font-size="${fs * 2}" font-weight="700"` : m.role === "center-label" ? "" : ' font-size="10"';
      return `<text x="${num(m.x)}" y="${num(m.y)}" text-anchor="${m.anchor}"${BASELINES[m.baseline]}${size} fill="${color(m.fill)}">${esc(m.text)}</text>`;
    }
    case "line": {
      const parts = [`<line x1="${num(m.x1)}" y1="${num(m.y1)}" x2="${num(m.x2)}" y2="${num(m.y2)}" stroke="${color(m.stroke)}" stroke-width="1.5"${m.dash ? ' stroke-dasharray="4 3"' : ""}/>`];
      if (m.label) {
        const vertical = m.x1 === m.x2;
        const x = vertical ? m.x1 + 4 : Math.max(m.x1, m.x2) - 2;
        const y = vertical ? Math.min(m.y1, m.y2) + 2 : m.y1 - 4;
        const halo = ` stroke="${color("surface")}" stroke-width="3" paint-order="stroke"`;
        parts.push(`<text x="${num(x)}" y="${num(y)}" text-anchor="${vertical ? "start" : "end"}"${vertical ? ' dominant-baseline="hanging"' : ""} font-size="10" fill="${color(m.stroke)}"${halo}>${esc(m.label)}</text>`);
      }
      return parts.join("");
    }
  }
}

function legendSvg(items: readonly LegendItem[], W: number, fs: number, color: (ref: ColorRef) => string): string {
  const parts = ['<g class="legend">'];
  const cy = LEGEND_BAND / 2;
  let x = PAD;
  for (const item of items) {
    const swatch = item.shape === "line" ? 14 : 10;
    const room = W - PAD - x - swatch - 4;
    if (room < fs * 2) break;
    const label = fitText(item.label, room, fs);
    const fill = color(item.color);
    if (item.shape === "line") parts.push(`<line x1="${num(x)}" y1="${cy}" x2="${num(x + swatch)}" y2="${cy}" stroke="${fill}" stroke-width="2.5" stroke-linecap="round"/>`);
    else if (item.shape === "circle") parts.push(`<circle cx="${num(x + 5)}" cy="${cy}" r="5" fill="${fill}"/>`);
    else parts.push(`<rect x="${num(x)}" y="${cy - 5}" width="10" height="10" rx="2" fill="${fill}"/>`);
    parts.push(`<text x="${num(x + swatch + 4)}" y="${cy}" dominant-baseline="central" fill="${color("fg")}">${esc(label)}</text>`);
    x += swatch + 4 + estimateTextWidth(label, fs) + 14;
    if (label !== item.label) break;
  }
  parts.push("</g>");
  return parts.join("\n");
}
