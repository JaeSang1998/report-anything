import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { z } from "zod";
import { autoReport, humanize, ReportSpec } from "@report-anything/core";
import type { Block, Dataset, FieldDef, ReportSession } from "@report-anything/core";

/**
 * Keyless report agent. It speaks the AI SDK language-model protocol, so the playground runs the exact same
 * chat → tool call → live report loop as with a hosted model, but its "reasoning" is deterministic:
 * - build: `autoReport` over the attached data (it can read the rows; a hosted model only sees schemas),
 * - edit: a fixed set of intents (chart kind, chart → table, horizontal, stacked, remove, rename).
 * Anything else gets an honest answer listing what it can do.
 */

type Lang = "ko" | "en";
type Op = Record<string, unknown>;

interface Plan {
  intro: string;
  batches: Op[][];
  /** Final message once every batch has been applied; receives the last apply_ops result. */
  done(result: ApplyResultLike | undefined): string;
}

interface ApplyResultLike {
  applied?: number;
  rejected?: unknown[];
  revision?: number;
  pages?: number;
  issues?: Array<{ severity: string }>;
}

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

const t = (lang: Lang, ko: string, en: string) => (lang === "ko" ? ko : en);

// ─── Prompt reading ─────────────────────────────────────────────────────────

/** Text of the last user message (without the playground's attachment note) and the tool results after it. */
function readTurn(prompt: LanguageModelV4Prompt): { text: string; turn: number; results: unknown[] } {
  let lastUser = -1;
  prompt.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const user = prompt[lastUser];
  const text =
    user?.role === "user"
      ? user.content
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n")
          .replace(/\n\n\(attached datasets:[\s\S]*\)$/, "")
      : "";
  const results: unknown[] = [];
  for (const m of prompt.slice(lastUser + 1)) {
    if (m.role !== "tool") continue;
    for (const part of m.content) if (part.type === "tool-result" && part.output.type === "json") results.push(part.output.value);
  }
  return { text, turn: prompt.filter((m) => m.role === "user").length, results };
}

const ApplyResultShape = z.object({
  applied: z.number().optional(),
  rejected: z.array(z.unknown()).optional(),
  revision: z.number().optional(),
  pages: z.number().optional(),
  issues: z.array(z.object({ severity: z.string() })).optional(),
});

function asApplyResult(value: unknown): ApplyResultLike | undefined {
  const parsed = ApplyResultShape.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// ─── Build ──────────────────────────────────────────────────────────────────

/** Datasets holding user data (not derived): the most recently attached one is the default subject. */
function rawDatasets(spec: ReportSpec): Array<[string, Dataset]> {
  return Object.entries(spec.datasets).filter(([, d]) => d.rows !== undefined || d.json !== undefined || d.csv !== undefined);
}

function withLabels(dataset: Dataset, labels: readonly FieldDef[]): Dataset {
  if (!labels.length) return dataset;
  const own = dataset.fields ?? [];
  const merged = [...own, ...labels.filter((l) => !own.some((o) => o.name === l.name))];
  return { ...dataset, fields: merged };
}

function buildPlan(text: string, lang: Lang, session: ReportSession): Plan {
  const { spec, context } = session.getSnapshot();
  const raw = rawDatasets(spec);
  if (raw.length === 0) {
    return {
      intro: t(lang, "먼저 데이터가 필요해요. CSV/JSON 파일을 첨부하거나 샘플 데이터를 눌러 주세요.", "I need data first. Attach a CSV/JSON file or pick a sample dataset."),
      batches: [],
      done: () => "",
    };
  }
  const named = raw.find(([id]) => text.includes(id));
  const [sourceId, source] = named ?? raw[raw.length - 1]!;
  const input = source.rows ?? source.json ?? source.csv;
  const resolved = context.datasets.get(sourceId);
  const title = t(lang, `${sourceId} 데이터 리포트`, `${humanize(sourceId)} report`);
  const draft = ReportSpec.parse(
    autoReport(input, { title, ...(lang === "ko" ? { locale: "ko-KR", currency: spec.meta?.currency ?? "KRW" } : { locale: "en-US" }) }),
  );

  // The draft's primary table is the attached data itself: alias it instead of copying rows.
  const labels = source.fields ?? [];
  const datasetOps: Op[] = [];
  let aliased = false;
  const references = JSON.stringify({ sections: draft.sections, derived: Object.values(draft.datasets).filter((d) => d.rows === undefined) });
  const referenced = new Set(Object.keys(draft.datasets).filter((id) => references.includes(`"${id}"`) || references.includes(`(${id}.`) || references.includes(`(${id})`)));
  for (const [id, ds] of Object.entries(draft.datasets)) {
    const isPrimary = !aliased && ds.rows !== undefined && resolved !== undefined && ds.rows.length === resolved.rows.length;
    if (isPrimary) {
      aliased = true;
      if (id !== sourceId) datasetOps.push({ op: "setDataset", id, dataset: withLabels({ from: sourceId }, labels) });
      continue;
    }
    // Copied-row datasets (e.g. exploded child tables) only ship when something in the draft reads them.
    if (ds.rows !== undefined && !referenced.has(id)) continue;
    datasetOps.push({ op: "setDataset", id, dataset: withLabels(ds, labels) });
  }

  const [first, ...rest] = draft.sections;
  const reset: Op[] = spec.sections.map((s) => ({ op: "removeSection", id: s.id }));
  const head: Op[] = [
    ...reset,
    { op: "setReport", patch: { title: draft.title, subtitle: draft.subtitle ?? null, summary: draft.summary ?? null, meta: draft.meta ?? null } },
    ...datasetOps,
    ...(first ? [{ op: "addSection", section: first }] : []),
  ];
  const charts = draft.sections.flatMap((s) => s.blocks).filter((b) => b.type === "chart").length;
  return {
    intro: t(lang, `${sourceId} 데이터를 프로파일링해서 초안을 만들게요. 요약부터 올립니다.`, `Profiling ${sourceId} and drafting the report, starting with the summary.`),
    batches: rest.length ? [head, rest.map((section) => ({ op: "addSection", section }))] : [head],
    done: (r) =>
      t(
        lang,
        `초안을 만들었습니다: 섹션 ${draft.sections.length}개, 차트 ${charts}개, A4 ${r?.pages ?? "?"}쪽${errorsNote(r, lang)}. 차트 종류 변경, 차트를 표로, 블록 삭제, 제목 변경은 이 로컬 에이전트로도 할 수 있어요.`,
        `Drafted ${draft.sections.length} sections with ${charts} charts, ${r?.pages ?? "?"} A4 pages${errorsNote(r, lang)}. This local agent can also change chart types, turn a chart into a table, remove blocks and rename the report.`,
      ),
  };
}

function errorsNote(r: ApplyResultLike | undefined, lang: Lang): string {
  const errors = (r?.issues ?? []).filter((i) => i.severity === "error").length + (r?.rejected?.length ?? 0);
  return errors ? t(lang, `, 오류 ${errors}개`, `, ${errors} errors`) : t(lang, ", 오류 없음", ", no errors");
}

// ─── Edits ──────────────────────────────────────────────────────────────────

const ORDINALS: Record<string, number> = { 첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const KINDS: Array<[RegExp, string]> = [
  [/(선|라인|꺾은선|line)/i, "line"],
  [/(막대|바\s*차트|bar)/i, "bar"],
  [/(영역|area)/i, "area"],
  [/(도넛|donut)/i, "donut"],
  [/(파이|원형|pie)/i, "pie"],
  [/(산점|scatter)/i, "scatter"],
];

type Target = { block: Block; ordinal: string };

const NOUNS: Record<string, Block["type"] | undefined> = { 차트: "chart", 그래프: "chart", chart: "chart", graph: "chart", 표: "table", 테이블: "table", table: "table", 블록: undefined, block: undefined };

/** "두 번째 차트", "second table", "마지막 차트"; without an ordinal, the last chart. */
function findTarget(text: string, spec: ReportSpec, lang: Lang): Target | undefined {
  const ko = /(첫|두|세|네|다섯|마지막)\s*(?:번\s*)?(?:째)?\s*(차트|그래프|표|테이블|블록)/.exec(text);
  const en = /\b(first|second|third|fourth|fifth|last)\s+(chart|graph|table|block)/i.exec(text);
  const [, ord, noun] = ko ?? en ?? [];
  const type = noun === undefined ? "chart" : NOUNS[noun.toLowerCase()];
  const blocks = spec.sections.flatMap((s) => s.blocks).filter((b) => type === undefined || b.type === type);
  const n = ord === undefined || /^(마지막|last)$/i.test(ord) ? blocks.length : ORDINALS[ord.toLowerCase()];
  const block = n === undefined ? undefined : blocks[n - 1];
  if (!block) return undefined;
  const label = block.title ? `“${block.title}”` : block.id;
  return { block, ordinal: t(lang, `${label} 블록`, `the ${label} block`) };
}

function editPlan(text: string, lang: Lang, session: ReportSession): Plan | undefined {
  const { spec } = session.getSnapshot();
  const reply = (ko: string, en: string): Plan["done"] => (r) => `${t(lang, ko, en)} (revision ${r?.revision ?? "?"}${errorsNote(r, lang)})`;

  const titleMatch = /(?:제목|title)[^"“'‘]*["“'‘](.+?)["”'’]/i.exec(text);
  if (titleMatch) {
    return { intro: "", batches: [[{ op: "setReport", patch: { title: titleMatch[1] } }]], done: reply(`제목을 “${titleMatch[1]}”로 바꿨습니다.`, `Renamed the report to “${titleMatch[1]}”.`) };
  }

  const target = findTarget(text, spec, lang);
  if (!target) return undefined;
  const { block, ordinal } = target;

  if (/(삭제|지워|빼\s*줘|없애|remove|delete|drop)/i.test(text)) {
    return { intro: "", batches: [[{ op: "removeBlock", id: block.id }]], done: reply(`${ordinal}을 삭제했습니다.`, `Removed ${ordinal}.`) };
  }
  if (block.type !== "chart") return undefined;
  const chart = block.chart;

  if (/(표|테이블)\s*(로|으로)|\b(into|to|as)\s+a?\s*table/i.test(text)) {
    const ys = Array.isArray(chart.y) ? chart.y : [chart.y];
    const columns = [chart.x, ...(chart.series ? [chart.series] : []), ...ys].map((field) => ({ field }));
    const table = { id: block.id, type: "table", title: block.title, data: chart.data, columns, maxRows: 20 };
    return { intro: "", batches: [[{ op: "replaceBlock", id: block.id, block: table }]], done: reply(`${ordinal}을 표로 바꿨습니다.`, `Turned ${ordinal} into a table.`) };
  }
  if (/(가로|horizontal)/i.test(text)) {
    return { intro: "", batches: [[{ op: "updateBlock", id: block.id, patch: { chart: { kind: "bar", horizontal: true } } }]], done: reply(`${ordinal}을 가로 막대로 바꿨습니다.`, `Made ${ordinal} a horizontal bar chart.`) };
  }
  if (/(누적|stack)/i.test(text)) {
    return { intro: "", batches: [[{ op: "updateBlock", id: block.id, patch: { chart: { stack: true } } }]], done: reply(`${ordinal}을 누적 차트로 바꿨습니다.`, `Stacked ${ordinal}.`) };
  }
  const kind = KINDS.find(([re]) => re.test(text.replace(/(차트|그래프|chart|graph)/gi, "")))?.[1];
  if (kind && kind !== chart.kind) {
    return {
      intro: "",
      batches: [[{ op: "updateBlock", id: block.id, patch: { chart: { kind, ...(kind === "bar" ? {} : { horizontal: null }) } } }]],
      done: reply(`${ordinal}을 ${kind} 차트로 바꿨습니다.`, `Changed ${ordinal} to a ${kind} chart.`),
    };
  }
  return undefined;
}

const BUILD_WORDS = /(리포트|보고서|분석|만들|작성|초안|다시|report|build|draft|analy[sz]e|create|make)/i;

function plan(text: string, session: ReportSession): Plan {
  const lang: Lang = /[가-힣]/.test(text) ? "ko" : "en";
  const hasReport = session.getSnapshot().spec.sections.length > 0;
  const edit = hasReport ? editPlan(text, lang, session) : undefined;
  if (edit) return edit;
  if (!hasReport || BUILD_WORDS.test(text)) return buildPlan(text, lang, session);
  return {
    intro: t(
      lang,
      "API 키 없이 동작하는 로컬 에이전트라서 정해진 요청만 처리해요: 리포트 만들기/다시 만들기, “두 번째 차트를 표로 바꿔줘”, “첫 번째 차트를 선 차트로”, “마지막 차트 삭제”, “가로 막대로”, “누적으로”, 제목을 \"…\"로 바꾸기. 자유로운 요청은 .env.local에 API 키를 넣으면 LLM 에이전트가 처리합니다.",
      'This keyless local agent handles a fixed set of requests: build or rebuild the report, "turn the second chart into a table", "make the first chart a line chart", "remove the last chart", "horizontal", "stacked", and title "…". Put an API key in .env.local for free-form requests.',
    ),
    batches: [],
    done: () => "",
  };
}

// ─── Model protocol ─────────────────────────────────────────────────────────

/** Largest ops payload streamed in ~40 pieces so the report visibly builds up. */
function deltas(input: string): string[] {
  const size = Math.max(120, Math.ceil(input.length / 40));
  const out: string[] = [];
  for (let i = 0; i < input.length; i += size) out.push(input.slice(i, i + size));
  return out;
}

export function createLocalReportModel(getSession: () => ReportSession): LanguageModelV4 {
  const plans = new Map<number, Plan>();

  const step = (options: LanguageModelV4CallOptions): { parts: LanguageModelV4StreamPart[]; content: LanguageModelV4Content[] } => {
    const { text, turn, results } = readTurn(options.prompt);
    let current = plans.get(turn);
    if (!current || results.length === 0) {
      current = plan(text, getSession());
      plans.set(turn, current);
    }
    const index = results.length;
    const batch = current.batches[index];
    // Answer-only plans (no ops) speak their intro; otherwise intro before the first batch, summary after the last.
    const message = current.batches.length === 0 ? current.intro : batch ? (index === 0 ? current.intro : "") : current.done(asApplyResult(results[results.length - 1]));
    const parts: LanguageModelV4StreamPart[] = [];
    const content: LanguageModelV4Content[] = [];
    if (message) {
      const id = `text-${turn}-${index}`;
      parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: message }, { type: "text-end", id });
      content.push({ type: "text", text: message });
    }
    if (batch) {
      const id = `local-${turn}-${index}-${Date.now().toString(36)}`;
      const input = JSON.stringify({ ops: batch });
      parts.push({ type: "tool-input-start", id, toolName: "apply_ops" });
      for (const delta of deltas(input)) parts.push({ type: "tool-input-delta", id, delta });
      parts.push({ type: "tool-input-end", id }, { type: "tool-call", toolCallId: id, toolName: "apply_ops", input });
      content.push({ type: "tool-call", toolCallId: id, toolName: "apply_ops", input });
    }
    const finishReason = { unified: batch ? ("tool-calls" as const) : ("stop" as const), raw: undefined };
    parts.push({ type: "finish", finishReason, usage: USAGE });
    return { parts, content };
  };

  return {
    specificationVersion: "v4",
    provider: "report-anything",
    modelId: "local-report-agent",
    supportedUrls: {},
    async doGenerate(options) {
      const { content, parts } = step(options);
      const finish = parts[parts.length - 1];
      return {
        content,
        finishReason: finish?.type === "finish" ? finish.finishReason : { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      const { parts } = step(options);
      return { stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 150, chunkDelayInMs: 45 }) };
    },
  };
}
