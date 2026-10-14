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
}

const STRINGS: Record<string, UiStrings> = {
  en: {
    total: "Total",
    noData: "No data to display",
    continued: "continued",
    change: "Change",
    showingRows: (n, m) => `Showing ${n} of ${m} rows`,
    variant: { insight: "Insight", recommendation: "Recommendation", note: "Note", risk: "Risk" },
  },
  ko: {
    total: "합계",
    noData: "표시할 데이터가 없습니다",
    continued: "계속",
    change: "변화",
    showingRows: (n, m) => `전체 ${m}행 중 ${n}행 표시`,
    variant: { insight: "인사이트", recommendation: "권고", note: "참고", risk: "리스크" },
  },
  ja: {
    total: "合計",
    noData: "表示するデータがありません",
    continued: "続き",
    change: "変化",
    showingRows: (n, m) => `${m}行中${n}行を表示`,
    variant: { insight: "インサイト", recommendation: "推奨", note: "注記", risk: "リスク" },
  },
};

export function uiStrings(locale: string): UiStrings {
  return STRINGS[locale.split("-")[0]!.toLowerCase()] ?? STRINGS.en!;
}
