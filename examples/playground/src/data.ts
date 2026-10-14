import { ID_PATTERN } from "@report-anything/core";
import type { Dataset } from "@report-anything/core";
import { nestedApiPayload, salesRows } from "./samples.js";

export interface Attachment {
  id: string;
  label: string;
  dataset: Dataset;
}

/** Filename → dataset id that satisfies the spec's id rule and does not collide. */
export function datasetId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[^a-z]+/, "");
  if (!ID_PATTERN.test(base)) base = "data";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** CSV stays CSV and JSON stays JSON: the engine normalizes both, and the raw upload remains the source of truth. */
export async function attachmentFromFile(file: File, taken: ReadonlySet<string>): Promise<Attachment> {
  const text = await file.text();
  const id = datasetId(file.name, taken);
  if (file.name.toLowerCase().endsWith(".csv")) return { id, label: file.name, dataset: { csv: text, source: file.name } };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file.name} is neither CSV nor valid JSON`);
  }
  return { id, label: file.name, dataset: { json, source: file.name } };
}

export const SAMPLE_DATA: Record<"sales" | "orders", Attachment> = {
  sales: {
    id: "sales",
    label: "샘플: 지역·채널 월매출 (270행)",
    dataset: {
      rows: salesRows(),
      source: "sample: warehouse.sales_monthly",
      fields: [
        { name: "period", label: "월", format: "date:month" },
        { name: "region", label: "지역" },
        { name: "channel", label: "채널" },
        { name: "revenue", label: "매출", format: "currency:KRW" },
        { name: "cost", label: "원가", format: "currency:KRW" },
        { name: "orders", label: "주문 수", format: "integer" },
      ],
    },
  },
  orders: {
    id: "orders",
    label: "샘플: 주문 API 응답 (중첩 JSON)",
    dataset: { json: nestedApiPayload, source: "sample: GET /v1/orders" },
  },
};
