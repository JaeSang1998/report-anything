import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ArrowUp, Check, ChevronRight, CircleAlert, Copy, Database, FileSpreadsheet, LoaderCircle, Paperclip, Square, Upload, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DataContext } from "@report-anything/core";
import { Markdown } from "@report-anything/react";
import type { ReportAgentMessage } from "../server/tools.js";
import type { Attachment } from "./data.js";
import { BrandMark } from "./Shell.js";

type Part = ReportAgentMessage["parts"][number];

export interface Starter {
  label: string;
  prompt: string;
  sample?: Attachment;
  icon: LucideIcon;
}

export interface ChatProps {
  messages: ReportAgentMessage[];
  busy: boolean;
  error: Error | undefined;
  context: DataContext;
  /** Hosted model id, or null for the keyless local agent. */
  agentLabel: string | null;
  attachments: Attachment[];
  samples: Attachment[];
  starters: Starter[];
  onSend(text: string): void;
  onStop(): void;
  onAttachFiles(files: FileList): void;
  onAttachSample(sample: Attachment): void;
  onRemoveAttachment(id: string): void;
  /** Open the data viewer for a dataset id. */
  onOpenData(id: string): void;
  onStarter(starter: Starter): void;
  /** Report rendered at the end of an assistant message (null when the message did not touch the report). */
  artifact(message: ReportAgentMessage): ReactNode;
}

const ATTACH_NOTE = /\n\n\(attached datasets: ([\s\S]*)\)$/;

/** User text without the attachment note the playground appends for the agent; the note becomes file rows. */
function splitNote(text: string): { body: string; files: string[] } {
  const m = ATTACH_NOTE.exec(text);
  return m ? { body: text.slice(0, m.index), files: m[1]!.split(", ") } : { body: text, files: [] };
}

type StepState = "running" | "done" | "error";
const STEP_ICON: Record<StepState, LucideIcon> = { running: LoaderCircle, done: Check, error: CircleAlert };

/** One agent tool call: status, a one-line result, and the raw call on demand. */
function Step({ state, line, detail }: { state: StepState; line: string; detail?: unknown }) {
  const Icon = STEP_ICON[state];
  const head = (
    <>
      <Icon size={14} className={`step__icon step__icon--${state}`} aria-hidden="true" />
      <span className="step__line">{line}</span>
    </>
  );
  return (
    <div className="step">
      {detail === undefined ? (
        <div className="step__head">{head}</div>
      ) : (
        <details>
          <summary className="step__head">
            {head}
            <ChevronRight size={14} className="step__chevron" aria-hidden="true" />
          </summary>
          <pre className="step__detail">{JSON.stringify(detail, null, 1)}</pre>
        </details>
      )}
    </div>
  );
}

function ToolStep({ part }: { part: Part }) {
  switch (part.type) {
    case "tool-apply_ops": {
      const n = part.input?.ops?.length ?? 0;
      if (part.state === "output-available") {
        const out = part.output;
        const errors = out.issues.filter((i) => i.severity === "error").length;
        const line = [
          `Applied ${out.applied} of ${n} ops`,
          `revision ${out.revision}`,
          `${out.pages} page${out.pages === 1 ? "" : "s"}`,
          out.rejected.length ? `${out.rejected.length} rejected` : "",
          errors ? `${errors} errors` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return <Step state={out.rejected.length || errors ? "error" : "done"} line={line} detail={{ ops: part.input.ops, result: out }} />;
      }
      if (part.state === "output-error") return <Step state="error" line={`Ops failed: ${part.errorText}`} />;
      return <Step state="running" line={part.state === "input-streaming" ? `Writing ops… ${n} so far` : `Applying ${n} ops…`} />;
    }
    case "tool-inspect_report":
      return part.state === "output-available" ? (
        <Step state="done" line={`Checked the ${part.input.mode} layout: ${part.output.pages} pages, ${part.output.issues.length} issues`} detail={part.output} />
      ) : (
        <Step state="running" line="Checking layout…" />
      );
    case "tool-profile_dataset":
      return part.state === "output-available" ? (
        <Step state="done" line={`Profiled ${part.input.dataset}`} detail={part.output} />
      ) : (
        <Step state="running" line="Profiling data…" />
      );
    default:
      return null;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={copied ? "Copied" : "Copy reply"}
      title={copied ? "Copied" : "Copy reply"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

const sourceKind = (a: Attachment) => (a.dataset.csv !== undefined ? "CSV" : a.dataset.json !== undefined ? "JSON" : "Rows");

function Composer(props: ChatProps & { large: boolean }) {
  const { busy } = props;
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Grow with the text up to a cap, like every chat input.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && menuRef.current?.contains(e.target))) setMenu(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    props.onSend(value);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const available = props.samples.filter((s) => !props.attachments.some((a) => a.id === s.id));

  return (
    <div className={props.large ? "composer composer--large" : "composer"}>
      {props.attachments.length ? (
        <ul className="files" aria-label="Attached data">
          {props.attachments.map((a) => (
            <li key={a.id} className="file">
              <button type="button" className="file__open" title="View data" onClick={() => props.onOpenData(a.id)}>
                <FileSpreadsheet size={16} aria-hidden="true" />
                <span className="file__name">{a.label}</span>
                <span className="file__meta">
                  {a.id} · {sourceKind(a)}
                </span>
              </button>
              <button type="button" className="file__remove" aria-label={`Remove ${a.label}`} title="Remove" onClick={() => props.onRemoveAttachment(a.id)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={areaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={props.large ? 3 : 1}
        aria-label="Message"
        placeholder={props.messages.length ? "Ask for a change" : "Attach data, then ask what the report should answer"}
      />
      <div className="composer__row">
        <div className="menu-anchor" ref={menuRef}>
          <button type="button" className="icon-btn" aria-label="Add data" title="Add data" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>
            <Paperclip size={18} />
          </button>
          {menu ? (
            <div className="menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  fileRef.current?.click();
                }}
              >
                <Upload size={16} aria-hidden="true" />
                <span>
                  Upload CSV or JSON
                  <small>Parsed in this browser</small>
                </span>
              </button>
              {available.length ? <p className="menu__label">Sample data</p> : null}
              {available.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    props.onAttachSample(s);
                  }}
                >
                  <Database size={16} aria-hidden="true" />
                  <span>
                    {s.label}
                    <small>
                      {s.id} · {sourceKind(s)}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="composer__spacer" />
        {busy ? (
          <button type="button" className="send" aria-label="Stop" title="Stop" onClick={props.onStop}>
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="send" aria-label="Send" title="Send (Enter)" onClick={submit} disabled={!text.trim()}>
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.json,application/json,text/csv"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) props.onAttachFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function Chat(props: ChatProps) {
  const { messages, busy, error, context } = props;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const footnote = props.agentLabel
    ? `${props.agentLabel} writes the spec; every number is computed from your data.`
    : "The local agent runs in this browser. Nothing is uploaded.";

  if (messages.length === 0) {
    return (
      <main className="thread thread--empty" aria-label="Report agent chat">
        <div className="welcome">
          <BrandMark size={32} />
          <h1>What should the report answer?</h1>
          <p>Attach a CSV or JSON file, or start from a sample. The report is written into the conversation and updates while the agent works.</p>
          <Composer {...props} large />
          <ul className="starters" aria-label="Examples">
            {props.starters.map((s) => (
              <li key={s.label}>
                <button type="button" onClick={() => props.onStarter(s)}>
                  <s.icon size={16} aria-hidden="true" />
                  <span className="starters__label">{s.label}</span>
                  <span className="starters__data">{s.sample ? s.sample.label : "Diagram"}</span>
                </button>
              </li>
            ))}
          </ul>
          {error ? (
            <p className="thread__error" role="alert">
              {error.message}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  const last = messages[messages.length - 1];
  return (
    <main className="thread" aria-label="Report agent chat">
      <div className="thread__scroll">
        <div className="thread__column">
          {messages.map((m) => {
            if (m.role === "user") {
              const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
              const { body, files } = splitNote(text);
              return (
                <article key={m.id} className="msg msg--user">
                  {files.length ? (
                    <ul className="files files--sent">
                      {files.map((f) => {
                        const [id, label] = f.split(" — ");
                        return (
                          <li key={f} className="file">
                            <button type="button" className="file__open" title="View data" onClick={() => props.onOpenData(id!)}>
                              <FileSpreadsheet size={16} aria-hidden="true" />
                              <span className="file__name">{label ?? id}</span>
                              <span className="file__meta">{id}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <p className="msg__bubble">{body}</p>
                </article>
              );
            }
            const reply = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n").trim();
            const live = busy && m === last;
            return (
              <article key={m.id} className="msg msg--assistant">
                <div className="msg__avatar" aria-hidden="true">
                  <BrandMark size={16} />
                </div>
                <div className="msg__body">
                  {m.parts.map((part, i) =>
                    part.type === "text" ? <Markdown key={i} className="msg__text" text={part.text} context={context} /> : <ToolStep key={i} part={part} />,
                  )}
                  {props.artifact(m)}
                  {reply && !live ? (
                    <div className="msg__actions">
                      <CopyButton text={reply} />
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
          {busy && last?.role === "user" ? (
            <article className="msg msg--assistant" aria-live="polite">
              <div className="msg__avatar" aria-hidden="true">
                <BrandMark size={16} />
              </div>
              <div className="msg__body">
                <p className="thinking">Reading the data</p>
              </div>
            </article>
          ) : null}
          {error ? (
            <p className="thread__error" role="alert">
              {error.message}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <div className="thread__dock">
        <Composer {...props} large={false} />
        <p className="thread__foot">{footnote}</p>
      </div>
    </main>
  );
}
