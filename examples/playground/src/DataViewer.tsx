import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { profileDataset } from "@report-anything/core";
import type { Dataset, ResolvedDataset, Scalar } from "@report-anything/core";

const MAX_ROWS = 200;
const MAX_SOURCE_CHARS = 200_000;

function sourceText(dataset: Dataset): { kind: string; text: string } {
  if (dataset.csv !== undefined) return { kind: "CSV", text: dataset.csv };
  if (dataset.json !== undefined) return { kind: "JSON", text: JSON.stringify(dataset.json, null, 2) };
  if (dataset.rows !== undefined) return { kind: "Rows (JSON)", text: JSON.stringify(dataset.rows, null, 2) };
  return { kind: "Derived", text: JSON.stringify({ from: dataset.from, transform: dataset.transform }, null, 2) };
}

const cell = (v: Scalar | undefined) => (v === null || v === undefined ? "" : String(v));

/**
 * Side sheet for an attached dataset: the table the engine actually sees (after CSV parsing / JSON
 * normalization and transforms) next to the raw source, plus each field's inferred type and role.
 */
export function DataViewer({ id, dataset, resolved, onClose }: { id: string; dataset: Dataset | undefined; resolved: ResolvedDataset | undefined; onClose(): void }) {
  const [tab, setTab] = useState<"table" | "source">("table");
  const profile = useMemo(() => (resolved ? profileDataset(resolved) : undefined), [resolved]);
  const source = useMemo(() => (dataset ? sourceText(dataset) : undefined), [dataset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={`Dataset ${id}`}>
        <header className="sheet__head">
          <div>
            <h2>{id}</h2>
            <p>
              {[dataset?.description, dataset?.source, resolved ? `${resolved.rows.length} rows · ${resolved.fields.length} fields` : "not resolved"].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {profile ? (
          <ul className="sheet__fields" aria-label="Fields">
            {profile.fields.map((f) => (
              <li key={f.name}>
                <strong>{f.name}</strong>
                <span>
                  {f.type} · {f.role}
                  {f.nulls ? ` · ${f.nulls} empty` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="seg sheet__tabs" role="tablist">
          <button type="button" role="tab" aria-pressed={tab === "table"} aria-selected={tab === "table"} onClick={() => setTab("table")}>
            Table
          </button>
          <button type="button" role="tab" aria-pressed={tab === "source"} aria-selected={tab === "source"} onClick={() => setTab("source")}>
            Source{source ? ` (${source.kind})` : ""}
          </button>
        </div>

        {tab === "table" ? (
          resolved ? (
            <div className="sheet__table">
              <table>
                <thead>
                  <tr>
                    {resolved.fields.map((f) => (
                      <th key={f.name} className={f.type === "number" ? "num" : undefined}>
                        {f.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resolved.rows.slice(0, MAX_ROWS).map((row, i) => (
                    <tr key={i}>
                      {resolved.fields.map((f) => (
                        <td key={f.name} className={f.type === "number" ? "num" : undefined}>
                          {cell(row[f.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {resolved.rows.length > MAX_ROWS ? (
                <p className="sheet__note">
                  First {MAX_ROWS} of {resolved.rows.length} rows.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="sheet__note">This dataset is no longer in the report.</p>
          )
        ) : source ? (
          <pre className="sheet__source">
            {source.text.length > MAX_SOURCE_CHARS ? `${source.text.slice(0, MAX_SOURCE_CHARS)}\n… (truncated)` : source.text}
          </pre>
        ) : (
          <p className="sheet__note">This dataset is no longer in the report.</p>
        )}
      </aside>
    </div>
  );
}
