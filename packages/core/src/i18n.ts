import type { Block } from "./spec.js";

/** Built-in UI words renderers print themselves (everything else comes from the spec). Keyed by language subtag. */
export interface UiStrings {
  total: string;
  noData: string;
  continued: string;
  /** Header of the first→last change column in comparisons. */
  change: string;
  showingRows: (shown: number, total: number) => string;
  /** Callout variant labels; the word carries the meaning, tone color only reinforces it. */
  variant: Record<"insight" | "recommendation" | "note" | "risk", string>;
  /** Web table pager; numbers arrive locale-formatted. */
  pager: { label: string; range: (from: string, to: string, total: string) => string; previous: string; next: string; page: (n: string) => string };
  /** Block type names: tab labels for untitled blocks in tabbed sections. */
  blockType: Record<Block["type"], string>;
  /** Slide deck viewer and carousel sections. */
  slides: { deck: string; carousel: string; previous: string; next: string; present: string; exitPresent: string; thumbnails: string; slide: (n: number, total: number) => string };
}

const STRINGS: Record<string, UiStrings> = {
  en: {
    total: "Total",
    noData: "No data to display",
    continued: "continued",
    change: "Change",
    showingRows: (n, m) => `Showing ${n} of ${m} rows`,
    variant: { insight: "Insight", recommendation: "Recommendation", note: "Note", risk: "Risk" },
    pager: { label: "Table pages", range: (a, b, m) => `Rows ${a}–${b} of ${m}`, previous: "Previous", next: "Next", page: (n) => `Page ${n}` },
    blockType: { text: "Text", kpi: "Key figures", stat: "Figure", chart: "Chart", table: "Table", callout: "Note", list: "List", comparison: "Comparison", diagram: "Diagram" },
    slides: {
      deck: "Slides",
      carousel: "Carousel",
      previous: "Previous slide",
      next: "Next slide",
      present: "Present",
      exitPresent: "Exit presentation",
      thumbnails: "All slides",
      slide: (n, total) => `Slide ${n} of ${total}`,
    },
  },
  ko: {
    total: "합계",
    noData: "표시할 데이터가 없습니다",
    continued: "계속",
    change: "변화",
    showingRows: (n, m) => `전체 ${m}행 중 ${n}행 표시`,
    variant: { insight: "인사이트", recommendation: "권고", note: "참고", risk: "리스크" },
    pager: { label: "표 페이지", range: (a, b, m) => `전체 ${m}행 중 ${a}–${b}행`, previous: "이전", next: "다음", page: (n) => `${n}페이지` },
    blockType: { text: "텍스트", kpi: "핵심 지표", stat: "수치", chart: "차트", table: "표", callout: "메모", list: "목록", comparison: "비교", diagram: "다이어그램" },
    slides: {
      deck: "슬라이드",
      carousel: "캐러셀",
      previous: "이전 슬라이드",
      next: "다음 슬라이드",
      present: "발표",
      exitPresent: "발표 종료",
      thumbnails: "전체 슬라이드",
      slide: (n, total) => `슬라이드 ${total}장 중 ${n}번째`,
    },
  },
  ja: {
    total: "合計",
    noData: "表示するデータがありません",
    continued: "続き",
    change: "変化",
    showingRows: (n, m) => `${m}行中${n}行を表示`,
    variant: { insight: "インサイト", recommendation: "推奨", note: "注記", risk: "リスク" },
    pager: { label: "表のページ", range: (a, b, m) => `${m}行中 ${a}–${b}行`, previous: "前へ", next: "次へ", page: (n) => `${n}ページ` },
    blockType: { text: "テキスト", kpi: "主要指標", stat: "数値", chart: "グラフ", table: "表", callout: "メモ", list: "リスト", comparison: "比較", diagram: "図" },
    slides: {
      deck: "スライド",
      carousel: "カルーセル",
      previous: "前のスライド",
      next: "次のスライド",
      present: "プレゼンテーション",
      exitPresent: "プレゼンテーションを終了",
      thumbnails: "すべてのスライド",
      slide: (n, total) => `スライド ${n} / ${total}`,
    },
  },
};

export function uiStrings(locale: string): UiStrings {
  return STRINGS[locale.split("-")[0]!.toLowerCase()] ?? STRINGS.en!;
}
