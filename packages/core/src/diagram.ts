/**
 * First keyword of a Mermaid source — the diagram type (`flowchart`, `sequenceDiagram`, …) — skipping
 * YAML front matter (`---` … `---`) and `%%` comment/directive lines. Undefined for an empty source.
 */
export function mermaidKind(source: string): string | undefined {
  const lines = source.split(/\r?\n/).map((l) => l.trim());
  let i = 0;
  if (lines[0] === "---") {
    i = lines.indexOf("---", 1);
    i = i === -1 ? lines.length : i + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "" || line.startsWith("%%")) continue;
    return line.split(/\s+/)[0];
  }
  return undefined;
}
