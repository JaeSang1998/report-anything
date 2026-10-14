import { ID_PATTERN } from "@report-anything/core";
import type { Dataset } from "@report-anything/core";
import { ordersPayload, saasRows, salesRows, ticketRows, trafficCsv } from "./samples.js";

export interface Attachment {
  id: string;
  /** Short name for buttons and chips. */
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

/** Five deliberately different shapes: flat rows, a SaaS time series, CSV text, operational records and nested API JSON. */
export const SAMPLE_DATA: Record<"sales" | "saas" | "traffic" | "tickets" | "orders", Attachment> = {
  sales: {
    id: "sales",
    label: "Regional sales",
    dataset: {
      rows: salesRows(),
      source: "warehouse.sales_monthly",
      description: "Regional sales",
      fields: [
        { name: "month", format: "date:month" },
        { name: "revenue", format: "currency:0" },
        { name: "cost", format: "currency:0" },
        { name: "orders", format: "integer" },
      ],
    },
  },
  saas: {
    id: "saas",
    label: "SaaS MRR",
    dataset: {
      rows: saasRows(),
      source: "billing.mrr_by_plan",
      description: "Subscription revenue",
      fields: [
        { name: "month", format: "date:month" },
        { name: "mrr", label: "MRR", format: "currency:0" },
        { name: "new_mrr", label: "New MRR", format: "currency:0" },
        { name: "expansion_mrr", label: "Expansion MRR", format: "currency:0" },
        { name: "churned_mrr", label: "Churned MRR", format: "currency:0" },
        { name: "logo_churn_rate", label: "Logo churn", format: "percent:1" },
      ],
    },
  },
  traffic: {
    id: "traffic",
    label: "Web traffic CSV",
    dataset: { csv: trafficCsv(), source: "analytics_export.csv", description: "Acquisition and signups" },
  },
  tickets: {
    id: "tickets",
    label: "Support tickets",
    dataset: {
      rows: ticketRows(),
      source: "helpdesk.tickets",
      description: "Support operations",
      fields: [
        { name: "first_response_minutes", label: "First response (min)" },
        { name: "resolution_hours", label: "Resolution (h)" },
        { name: "csat", label: "CSAT" },
      ],
    },
  },
  orders: {
    id: "orders",
    label: "Orders API JSON",
    dataset: { json: ordersPayload(), source: "GET /v1/orders", description: "Orders" },
  },
};
