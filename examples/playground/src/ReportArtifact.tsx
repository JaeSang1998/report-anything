import { useState } from "react";
import type { ReactNode } from "react";
import type { LayoutMode, ReportSession, ReportSpec } from "@report-anything/core";
import { Report, useReportSnapshot } from "@report-anything/react";

function download(spec: ReportSpec): void {
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "report-spec.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function Frame({ spec, meta, open, onToggle, children }: { spec: ReportSpec; meta: string; open: boolean; onToggle?: () => void; children: (mode: LayoutMode) => ReactNode }) {
  const [mode, setMode] = useState<LayoutMode>("web");
  return (
    <section className={open ? "artifact" : "artifact artifact--closed"} aria-label={`Report: ${spec.title}`}>
      <header className="artifact__head">
        <div className="artifact__title">
          {/* Open: the report shows its own title right below, so the header only carries the version. */}
          {open ? null : <strong>{spec.title}</strong>}
          <span>{meta}</span>
        </div>
        {open ? (
          <>
            <div className="seg" role="group" aria-label="Layout">
              {(["web", "print"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === "web" ? "Web" : "Print"}
                </button>
              ))}
            </div>
            <button type="button" className="link" onClick={() => download(spec)}>
              Spec JSON
            </button>
          </>
        ) : null}
        {onToggle ? (
          <button type="button" className="link" onClick={onToggle}>
            {open ? "Collapse" : "Show this version"}
          </button>
        ) : null}
      </header>
      {open ? <div className={`artifact__body artifact__body--${mode}`}>{children(mode)}</div> : null}
    </section>
  );
}

/** The report as it is now: re-renders on every op, including ops still streaming in. */
export function LiveReport({ session }: { session: ReportSession }) {
  const snap = useReportSnapshot(session);
  const errors = snap.issues.filter((i) => i.severity === "error").length;
  if (snap.spec.sections.length === 0) return null;
  return (
    <Frame spec={snap.spec} meta={`revision ${snap.revision}${errors ? ` · ${errors} errors` : ""}`} open>
      {(mode) => <Report session={session} mode={mode} />}
    </Frame>
  );
}

/** An earlier version kept in the thread, collapsed so only the latest report is expanded. */
export function FrozenReport({ spec, revision }: { spec: ReportSpec; revision: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Frame spec={spec} meta={`revision ${revision} · earlier version`} open={open} onToggle={() => setOpen((o) => !o)}>
      {(mode) => <Report spec={spec} mode={mode} />}
    </Frame>
  );
}
