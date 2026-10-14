import type { Row, Scalar } from "../spec.js";
import { closest, compareScalars, parseDate, toNumber } from "./values.js";

/** Expression syntax/compile error with the 0-based character position it refers to. */
export class ExprError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = "ExprError";
    this.position = position;
  }
}

export interface CompiledExpr {
  (row: Row): Scalar;
  /** Field names referenced by the expression (deduplicated, first-seen order). */
  readonly fields: readonly string[];
}

type Node = (row: Row) => Scalar;

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "ident"; value: string; pos: number; quoted: boolean }
  | { kind: "op"; value: string; pos: number }
  | { kind: "eof"; pos: number };

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", ">", "<", "!", "(", ")", ",", "="];
const IDENT_START = /[A-Za-z_$\u00C0-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u00C0-\uFFFF]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (IDENT_START.test(src[i] ?? "")) throw new ExprError(`unexpected '${src[i]}' after number`, i);
      tokens.push({ kind: "num", value: Number(m[0]), pos: start });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = "";
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        value += src[i];
        i++;
      }
      if (i >= src.length) throw new ExprError("unterminated string", start);
      i++;
      tokens.push({ kind: "str", value, pos: start });
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) throw new ExprError("unterminated `field name`", start);
      const value = src.slice(i + 1, end);
      if (value === "") throw new ExprError("empty `field name`", start);
      i = end + 1;
      tokens.push({ kind: "ident", value, pos: start, quoted: true });
      continue;
    }
    if (IDENT_START.test(ch)) {
      i++;
      // Dots join identifier segments (customer.name) when followed by another identifier character.
      while (i < src.length && (IDENT_PART.test(src[i]!) || (src[i] === "." && IDENT_PART.test(src[i + 1] ?? "")))) i++;
      tokens.push({ kind: "ident", value: src.slice(start, i), pos: start, quoted: false });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character '${ch}'`, i);
    i += op.length;
    tokens.push({ kind: "op", value: op === "=" ? "==" : op, pos: start });
  }
  tokens.push({ kind: "eof", pos: src.length });
  return tokens;
}

/** Truthiness used by filters and boolean operators: null, false, 0, NaN and "" are false. */
export function isTruthy(v: Scalar | undefined): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !Number.isNaN(v);
}

function looseEquals(a: Scalar, b: Scalar): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an === bn;
  return a === b;
}

function arithmetic(op: string, a: Scalar, b: Scalar): Scalar {
  if (a === null || b === null) return null;
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null || y === null) {
    if (op === "+" && (typeof a === "string" || typeof b === "string")) return String(a) + String(b);
    return null;
  }
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    default:
      return y === 0 ? null : x % y;
  }
}

function datePart(v: Scalar, part: (d: Date) => number): Scalar {
  const t = typeof v === "string" ? parseDate(v, true) : null;
  return t === null ? null : part(new Date(t));
}

function numeric1(f: (x: number) => number): (args: Scalar[]) => Scalar {
  return ([a]) => {
    const x = toNumber(a);
    if (x === null) return null;
    const r = f(x);
    return Number.isFinite(r) ? r : null;
  };
}

interface FnDef {
  min: number;
  max: number;
  call: (args: Scalar[]) => Scalar;
}

const FUNCTIONS: Record<string, FnDef> = {
  abs: { min: 1, max: 1, call: numeric1(Math.abs) },
  floor: { min: 1, max: 1, call: numeric1(Math.floor) },
  ceil: { min: 1, max: 1, call: numeric1(Math.ceil) },
  sqrt: { min: 1, max: 1, call: numeric1((x) => (x < 0 ? Number.NaN : Math.sqrt(x))) },
  round: {
    min: 1,
    max: 2,
    call: ([a, d]) => {
      const x = toNumber(a);
      if (x === null) return null;
      const digits = d === undefined ? 0 : toNumber(d);
      if (digits === null) return null;
      const k = 10 ** Math.trunc(digits);
      return Math.round(x * k) / k;
    },
  },
  log: {
    min: 1,
    max: 2,
    call: ([a, base]) => {
      const x = toNumber(a);
      const b = base === undefined ? Math.E : toNumber(base);
      if (x === null || b === null || x <= 0 || b <= 0 || b === 1) return null;
      return Math.log(x) / Math.log(b);
    },
  },
  pow: {
    min: 2,
    max: 2,
    call: ([a, b]) => {
      const x = toNumber(a);
      const y = toNumber(b);
      if (x === null || y === null) return null;
      const r = x ** y;
      return Number.isFinite(r) ? r : null;
    },
  },
  min: {
    min: 1,
    max: Infinity,
    call: (args) => {
      const nums = args.map((a) => toNumber(a)).filter((n): n is number => n !== null);
      return nums.length ? Math.min(...nums) : null;
    },
  },
  max: {
    min: 1,
    max: Infinity,
    call: (args) => {
      const nums = args.map((a) => toNumber(a)).filter((n): n is number => n !== null);
      return nums.length ? Math.max(...nums) : null;
    },
  },
  coalesce: { min: 1, max: Infinity, call: (args) => args.find((a) => a !== null) ?? null },
  // `if` is evaluated lazily in the parser; this entry exists for arity checks and name lookup.
  if: { min: 3, max: 3, call: ([c, a, b]) => (isTruthy(c) ? (a ?? null) : (b ?? null)) },
  year: { min: 1, max: 1, call: ([v]) => datePart(v ?? null, (d) => d.getUTCFullYear()) },
  quarter: { min: 1, max: 1, call: ([v]) => datePart(v ?? null, (d) => Math.floor(d.getUTCMonth() / 3) + 1) },
  month: { min: 1, max: 1, call: ([v]) => datePart(v ?? null, (d) => d.getUTCMonth() + 1) },
  day: { min: 1, max: 1, call: ([v]) => datePart(v ?? null, (d) => d.getUTCDate()) },
  lower: { min: 1, max: 1, call: ([v]) => (v === null || v === undefined ? null : String(v).toLowerCase()) },
  upper: { min: 1, max: 1, call: ([v]) => (v === null || v === undefined ? null : String(v).toUpperCase()) },
  concat: { min: 1, max: Infinity, call: (args) => args.map((a) => (a === null ? "" : String(a))).join("") },
  len: { min: 1, max: 1, call: ([v]) => (v === null || v === undefined ? null : String(v).length) },
  contains: {
    min: 2,
    max: 2,
    call: ([s, sub]) => (s === null || s === undefined || sub === null || sub === undefined ? null : String(s).includes(String(sub))),
  },
};

const KEYWORDS: Record<string, Scalar> = { true: true, false: false, null: null };
const WORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!" };

// Binding powers for binary operators.
const BINARY: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 4,
  "!=": 4,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
const NOT_POWER = 3;
const NEG_POWER = 7;

class Parser {
  private i = 0;
  readonly fields: string[] = [];
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  /** Operator value of the current token, mapping word operators (and/or/not). */
  private opOf(t: Token): string | undefined {
    if (t.kind === "op") return t.value;
    if (t.kind === "ident" && !t.quoted) return WORD_OPS[t.value.toLowerCase()];
    return undefined;
  }

  private expect(op: string): void {
    const t = this.peek();
    if (this.opOf(t) !== op) throw new ExprError(`expected '${op}' but found ${describe(t)}`, t.pos);
    this.i++;
  }

  parseAll(): Node {
    const node = this.parse(0);
    const t = this.peek();
    if (t.kind !== "eof") throw new ExprError(`unexpected ${describe(t)}`, t.pos);
    return node;
  }

  parse(minPower: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const op = this.opOf(t);
      const power = op === undefined ? undefined : BINARY[op];
      if (op === undefined || power === undefined || power <= minPower) return left;
      this.i++;
      const right = this.parse(power);
      left = binary(op, left, right);
    }
  }

  private prefix(): Node {
    const t = this.peek();
    this.i++;
    const op = this.opOf(t);
    if (op === "!") {
      const operand = this.parse(NOT_POWER);
      return (row) => !isTruthy(operand(row));
    }
    if (op === "-") {
      const operand = this.parse(NEG_POWER);
      return (row) => {
        const n = toNumber(operand(row));
        return n === null ? null : -n;
      };
    }
    if (op === "+") return this.parse(NEG_POWER);
    if (op === "(") {
      const inner = this.parse(0);
      this.expect(")");
      return inner;
    }
    switch (t.kind) {
      case "num":
      case "str": {
        const v = t.value;
        return () => v;
      }
      case "ident":
        return this.identifier(t);
      default:
        throw new ExprError(t.kind === "eof" ? "unexpected end of expression" : `unexpected ${describe(t)}`, t.pos);
    }
  }

  private identifier(t: Extract<Token, { kind: "ident" }>): Node {
    const next = this.peek();
    if (!t.quoted && next.kind === "op" && next.value === "(") return this.call(t);
    if (!t.quoted) {
      const lower = t.value.toLowerCase();
      if (lower in KEYWORDS) {
        const v = KEYWORDS[lower]!;
        return () => v;
      }
      if (lower in WORD_OPS) throw new ExprError(`unexpected operator '${t.value}'`, t.pos);
    }
    const name = t.value;
    if (!this.fields.includes(name)) this.fields.push(name);
    return (row) => row[name] ?? null;
  }

  private call(t: Extract<Token, { kind: "ident" }>): Node {
    const name = t.value.toLowerCase();
    const def = FUNCTIONS[name];
    if (!def) {
      const guess = closest(name, Object.keys(FUNCTIONS));
      throw new ExprError(`unknown function '${t.value}'${guess ? ` (did you mean '${guess}'?)` : ""}`, t.pos);
    }
    this.expect("(");
    const args: Node[] = [];
    if (this.opOf(this.peek()) !== ")") {
      for (;;) {
        args.push(this.parse(0));
        if (this.opOf(this.peek()) !== ",") break;
        this.i++;
      }
    }
    this.expect(")");
    if (args.length < def.min || args.length > def.max) {
      const want = def.min === def.max ? `${def.min}` : def.max === Infinity ? `at least ${def.min}` : `${def.min}-${def.max}`;
      throw new ExprError(`${name}() takes ${want} argument(s), got ${args.length}`, t.pos);
    }
    if (name === "if") {
      const [c, a, b] = args as [Node, Node, Node];
      return (row) => (isTruthy(c(row)) ? a(row) : b(row));
    }
    return (row) => def.call(args.map((a) => a(row)));
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case "eof":
      return "end of expression";
    case "str":
      return `string '${t.value}'`;
    case "num":
      return `number ${t.value}`;
    default:
      return `'${t.value}'`;
  }
}

function binary(op: string, l: Node, r: Node): Node {
  switch (op) {
    case "||":
      return (row) => isTruthy(l(row)) || isTruthy(r(row));
    case "&&":
      return (row) => isTruthy(l(row)) && isTruthy(r(row));
    case "==":
      return (row) => looseEquals(l(row), r(row));
    case "!=":
      return (row) => !looseEquals(l(row), r(row));
    case ">":
    case ">=":
    case "<":
    case "<=":
      return (row) => {
        const a = l(row);
        const b = r(row);
        if (a === null || b === null) return null;
        const c = compareScalars(a, b);
        return op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
      };
    default:
      return (row) => arithmetic(op, l(row), r(row));
  }
}

/** Compile an expression into a row evaluator. Throws ExprError with the offending position. */
export function compileExpr(src: string): CompiledExpr {
  const parser = new Parser(tokenize(src));
  const node = parser.parseAll();
  return Object.assign((row: Row) => node(row), { fields: parser.fields });
}
