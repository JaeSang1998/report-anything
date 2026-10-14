import type { Row, Scalar } from "../spec.js";
import { toNumber } from "./values.js";

/** Split RFC 4180 text into records of raw cells. Handles quoted cells, escaped quotes and CRLF/LF/CR line ends. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(cell);
      out.push(record);
      record = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    out.push(record);
  }
  return out.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

function coerce(raw: string): Scalar {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  return toNumber(s) ?? raw;
}

/** Parse CSV with a header row into rows. Numeric strings → numbers, true/false → booleans, empty → null; dates stay strings. */
export function parseCsv(text: string): Row[] {
  const [header, ...body] = records(text);
  if (!header) return [];
  const names = header.map((h, i) => h.trim() || `column${i + 1}`);
  return body.map((cells) => {
    const row: Row = {};
    names.forEach((name, i) => {
      row[name] = coerce(cells[i] ?? "");
    });
    return row;
  });
}
