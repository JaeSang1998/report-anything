#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyOps,
  autoReport,
  buildChart,
  chartToSvg,
  chartPlotHeight,
  createDataContext,
  createOpParser,
  inspectReport,
  normalizeJson,
  opJsonSchema,
  parseCsv,
  profileDataset,
  reportJsonSchema,
  ReportSpec,
  resolveDatasets,
  suggestCharts,
  validateReport,
} from "@report-anything/core";
import type { Issue, LayoutMode, Row } from "@report-anything/core";
import { Report } from "@report-anything/react";

const HELP = `report-anything — headless report engine CLI

Usage:
  report-anything schema [report|op]                     JSON Schema for LLM tools
  report-anything validate <spec.json>                   schema + data/field checks (exit 1 on errors)
  report-anything inspect  <spec.json> [--mode print]    outline, spans, pages, layout diagnostics
  report-anything profile  <data.json|csv> [--path a.b]  field roles/stats + chart suggestions
  report-anything auto     <data.json|csv> [--title T] [--locale ko-KR] [--currency KRW] [-o spec.json]
  report-anything apply    <spec.json> <ops.jsonl|-> [-o out.json]
  report-anything render   <spec.json> [-o report.html] [--mode web|print]
  report-anything chart    <spec.json> <blockId> [-o chart.svg] [--width 640]

'-' reads stdin. Output is JSON on stdout unless -o is given.`;

async function readInput(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(path: string): Promise<unknown> {
  const text = await readInput(path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** JSON, or CSV when the file ends in .csv or does not parse as JSON. */
async function readData(path: string): Promise<unknown> {
  const text = await readInput(path);
  if (path.endsWith(".csv")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class UsageError extends Error {}

async function emit(value: unknown, out: string | undefined): Promise<void> {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  if (out) {
    await writeFile(out, text);
    process.stderr.write(`wrote ${out}\n`);
  } else process.stdout.write(text);
}

async function loadSpec(path: string): Promise<ReportSpec> {
  const result = validateReport(await readJson(path));
  if (!result.spec) {
    await emit({ ok: false, issues: result.issues }, undefined);
    process.exit(1);
  }
  return result.spec;
}

async function renderHtml(spec: ReportSpec, mode: LayoutMode): Promise<string> {
  const cssPath = fileURLToPath(import.meta.resolve("@report-anything/react/styles.css"));
  const css = await readFile(cssPath, "utf8");
  const body = renderToStaticMarkup(<Report spec={spec} mode={mode} />);
  const lang = spec.meta?.locale ?? "en";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>${css}</style>
</head>
<body class="ra-body ra-body--${mode}">
${body}
</body>
</html>
`;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      mode: { type: "string" },
      path: { type: "string" },
      title: { type: "string" },
      locale: { type: "string" },
      currency: { type: "string" },
      width: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 1;
  }
  const mode = (values.mode ?? (command === "render" ? "web" : "print")) as LayoutMode;
  if (mode !== "web" && mode !== "print") throw new UsageError("--mode must be web or print");
  const need = (n: number) => {
    if (args.length < n) throw new UsageError(`'${command}' needs ${n} argument(s)\n\n${HELP}`);
  };

  switch (command) {
    case "schema": {
      const which = args[0] ?? "report";
      await emit(which === "op" ? opJsonSchema() : reportJsonSchema(), values.out);
      return 0;
    }
    case "validate": {
      need(1);
      const result = validateReport(await readJson(args[0]!));
      await emit({ ok: result.ok, issues: result.issues }, values.out);
      return result.ok ? 0 : 1;
    }
    case "inspect": {
      need(1);
      const result = validateReport(await readJson(args[0]!));
      if (!result.spec || !result.context) {
        await emit({ ok: false, issues: result.issues }, values.out);
        return 1;
      }
      const inspection = inspectReport({ spec: result.spec, context: result.context, issues: result.issues }, { mode });
      await emit(inspection, values.out);
      return inspection.valid ? 0 : 1;
    }
    case "profile": {
      need(1);
      const raw = await readData(args[0]!);
      const rows: Row[] = typeof raw === "string" ? parseCsv(raw) : normalizeJson(raw, values.path ? { path: values.path } : {});
      const { datasets } = resolveDatasets({ data: { rows } });
      const ds = datasets.get("data")!;
      const profile = profileDataset(ds);
      await emit({ profile, suggestions: suggestCharts(ds, profile).slice(0, 6) }, values.out);
      return 0;
    }
    case "auto": {
      need(1);
      const raw = await readData(args[0]!);
      const draft = autoReport(raw, {
        ...(values.title ? { title: values.title } : {}),
        ...(values.locale ? { locale: values.locale } : {}),
        ...(values.currency ? { currency: values.currency } : {}),
      });
      await emit(draft, values.out);
      return 0;
    }
    case "apply": {
      need(2);
      const spec = await loadSpec(args[0]!);
      const parser = createOpParser();
      const first = parser.push(await readInput(args[1]!));
      const rest = parser.flush();
      const parseErrors = [...first.errors, ...rest.errors];
      if (parseErrors.length) {
        await emit({ ok: false, issues: parseErrors }, undefined);
        return 1;
      }
      const result = applyOps(spec, [...first.ops, ...rest.ops]);
      if (!result.ok) {
        await emit({ ok: false, issues: result.issues }, undefined);
        return 1;
      }
      const check = validateReport(result.spec);
      if (values.out) {
        await emit(result.spec, values.out);
        process.stdout.write(`${JSON.stringify({ ok: check.ok, issues: check.issues }, null, 2)}\n`);
      } else await emit(result.spec, undefined);
      return check.ok ? 0 : 1;
    }
    case "render": {
      need(1);
      const spec = await loadSpec(args[0]!);
      await emit(await renderHtml(spec, mode), values.out);
      return 0;
    }
    case "chart": {
      need(2);
      const spec = await loadSpec(args[0]!);
      const block = spec.sections.flatMap((s) => s.blocks).find((b) => b.id === args[1]);
      if (!block || block.type !== "chart") throw new UsageError(`no chart block '${args[1]}'`);
      const { context, issues } = createDataContext(spec);
      if (issues.some((i) => i.severity === "error")) {
        await emit({ ok: false, issues }, undefined);
        return 1;
      }
      const width = values.width ? Number(values.width) : 640;
      const model = buildChart(block.chart, context, { width, height: chartPlotHeight(block) });
      await emit(chartToSvg(model, spec.theme?.palette ? { palette: spec.theme.palette } : {}), values.out);
      return 0;
    }
    default:
      throw new UsageError(`unknown command '${command}'\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof UsageError ? err.message : (err as Error).stack ?? String(err)}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  },
);
