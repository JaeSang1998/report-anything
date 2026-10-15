import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const KEY = "report-anything.playground.theme";
const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };

function stored(): ThemePreference {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

/**
 * Light / dark / system. index.html applies the stored choice before first paint; this keeps
 * `<html data-theme>` in sync afterwards, including when the system setting changes.
 */
export function useTheme(): { preference: ThemePreference; resolved: "light" | "dark"; cycle(): void } {
  const [preference, setPreference] = useState<ThemePreference>(stored);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return {
    preference,
    resolved,
    cycle() {
      const next = NEXT[preference];
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
      setPreference(next);
    },
  };
}
