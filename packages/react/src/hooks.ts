import { useState, useSyncExternalStore } from "react";
import { createReportSession } from "@report-anything/core";
import type { ReportSession, ReportSnapshot } from "@report-anything/core";

/** Create a session once per component instance. Throws SpecError if `initial` is schema-invalid. */
export function useReportSession(initial?: unknown): ReportSession {
  const [session] = useState(() => createReportSession(initial));
  return session;
}

/** Subscribe to a session; re-renders on every accepted op. */
export function useReportSnapshot(session: ReportSession): ReportSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
