/** Data-layer failure with a stable code and an actionable hint for agents. */
export class DataError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "DataError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}
