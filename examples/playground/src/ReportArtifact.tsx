import { useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronDown, Copy, Download, FileChartColumn, Monitor, Printer } from "lucide-react";
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

const MODES: Array<{ mode: LayoutMode; label: string; Icon: typeof Monitor }> = [
  { mode: "web", label: "Web", Icon: Monitor },
  { mode: "print", label: "Print", Icon: Printer },
];

function Toolbar({ spec, mode, onMode }: { spec: ReportSpec; mode: LayoutMode; onMode(m: LayoutMode): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="artifact__tools">
      <div className="seg" role="group" aria-label="Layout">
        {MODES.map(({ mode: m, label, Icon }) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => onMode(m)}>
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={copied ? "Spec copied" : "Copy spec JSON"}
        title={copied ? "Copied" : "Copy spec JSON"}
        onClick={() => {
          void navigator.clipboard.writeText(JSON.stringify(spec, null, 2)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Download spec JSON" title="Download spec JSON" onClick={() => download(spec)}>
        <Download size={15} />
      </button>
    </div>
  );
}

function Frame({ spec, meta, building, children }: { spec: ReportSpec; meta: string; building?: boolean; children: (mode: LayoutMode) => ReactNode }) {
  const [mode, setMode] = useState<LayoutMode>("web");
  return (
    <section className={building ? "artifact artifact--building" : "artifact"} aria-label={`Report: ${spec.title}`} aria-busy={building}>
      <header className="artifact__head">
        <FileChartColumn size={16} className="artifact__icon" aria-hidden="true" />
        <span className="artifact__meta">{meta}</span>
        <Toolbar spec={spec} mode={mode} onMode={setMode} />
      </header>
      <div className={`artifact__body artifact__body--${mode}`}>{children(mode)}</div>
    </section>
  );
}

/** The report as it is now: re-renders on every op, including ops still streaming in. */
export function LiveReport({ session, building }: { session: ReportSession; building: boolean }) {
  const snap = useReportSnapshot(session);
  const errors = snap.issues.filter((i) => i.severity === "error").length;
  if (snap.spec.sections.length === 0) return null;
  const meta = building ? `Building · revision ${snap.revision}` : `Revision ${snap.revision}${errors ? ` · ${errors} errors` : ""}`;
  return (
    <Frame spec={snap.spec} meta={meta} building={building}>
      {(mode) => <Report session={session} mode={mode} />}
    </Frame>
  );
}

/** An earlier version kept in the thread, collapsed so only the latest report is expanded. */
export function FrozenReport({ spec, revision }: { spec: ReportSpec; revision: number }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <Frame spec={spec} meta={`Revision ${revision} · earlier version`}>
        {(mode) => <Report spec={spec} mode={mode} />}
      </Frame>
    );
  }
  return (
    <button type="button" className="version" onClick={() => setOpen(true)}>
      <FileChartColumn size={16} aria-hidden="true" />
      <span className="version__title">{spec.title}</span>
      <span className="version__meta">Revision {revision} · earlier version</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}
