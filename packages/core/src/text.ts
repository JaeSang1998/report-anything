import { METRICS } from "./layout/metrics.js";

/** Hangul, CJK punctuation/ideographs, kana and fullwidth forms: 1em glyphs, breakable between any two. */
export const CJK_RANGES = "\\u1100-\\u11ff\\u2e80-\\u303f\\u3040-\\u30ff\\u3130-\\u318f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef";
const CJK = new RegExp(`[${CJK_RANGES}]`);

/**
 * Estimated advance width of a string in px (METRICS.glyph factors by script × font size).
 * The single text-measuring heuristic shared by the layout solver, chart label fitting and adapters.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += CJK.test(ch) ? METRICS.glyph.cjk : ch >= "0" && ch <= "9" ? METRICS.glyph.digit : METRICS.glyph.latin;
  return em * fontSize;
}
