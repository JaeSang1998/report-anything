import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { DataContext } from "@report-anything/core";
import { Markdown } from "@report-anything/react";
import type { ReportAgentMessage } from "../server/tools.js";
import type { Attachment } from "./data.js";

type Part = ReportAgentMessage["parts"][number];

export interface ChatProps {
  messages: ReportAgentMessage[];
  busy: boolean;
  error: Error | undefined;
  context: DataContext;
  attachments: Attachment[];
  samples: Attachment[];
  starters: Array<{ label: string; prompt: string; sample?: Attachment }>;
  onSend(text: string): void;
  onStop(): void;
  onAttachFiles(files: FileList): void;
  onAttachSample(sample: Attachment): void;
  onRemoveAttachment(id: string): void;
  /** Open the data viewer for a dataset id. */
  onOpenData(id: string): void;
  onStarter(starter: { prompt: string; sample?: Attachment }): void;
  /** Report rendered at the end of an assistant message (null when the message did not touch the report). */
  artifact(message: ReportAgentMessage): ReactNode;
}

const ATTACH_NOTE = /\n\n\(attached datasets: ([\s\S]*)\)$/;

/** User text without the attachment note the playground appends for the agent; the note becomes chips. */
function splitNote(text: string): { body: string; files: string[] } {
  const m = ATTACH_NOTE.exec(text);
  return m ? { body: text.slice(0, m.index), files: m[1]!.split(", ") } : { body: text, files: [] };
}

function ToolDetail({ line, detail }: { line: string; detail?: unknown }) {
  return (
    <div className="tool">
      {detail === undefined ? (
        <span className="tool__line">{line}</span>
      ) : (
        <details>
          <summary className="tool__line">{line}</summary>
          <pre className="tool__detail">{JSON.stringify(detail, null, 1)}</pre>
        </details>
      )}
    </div>
  );
}

function ToolLine({ part }: { part: Part }) {
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
        return <ToolDetail line={line} detail={{ ops: part.input.ops, result: out }} />;
      }
      if (part.state === "output-error") return <ToolDetail line={`Ops failed: ${part.errorText}`} />;
      return <ToolDetail line={part.state === "input-streaming" ? `Writing ops… ${n} so far` : `Applying ${n} ops…`} />;
    }
    case "tool-inspect_report":
      return part.state === "output-available" ? (
        <ToolDetail line={`Checked the ${part.input.mode} layout: ${part.output.pages} pages, ${part.output.issues.length} issues`} detail={part.output} />
      ) : (
        <ToolDetail line="Checking layout…" />
      );
    case "tool-profile_dataset":
      return part.state === "output-available" ? (
        <ToolDetail line={`Profiled dataset ${part.input.dataset}`} detail={part.output} />
      ) : (
        <ToolDetail line="Profiling data…" />
      );
    default:
      return null;
  }
}

export function Chat(props: ChatProps) {
  const { messages, busy, error, context } = props;
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

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

  const composer = (
    <div className="composer">
      {props.attachments.length ? (
        <ul className="chips" aria-label="Attached data">
          {props.attachments.map((a) => (
            <li key={a.id} className="chip">
              <button type="button" className="chip__open" title="View data" onClick={() => props.onOpenData(a.id)}>
                <span className="chip__id">{a.id}</span>
                <span className="chip__label">{a.label}</span>
              </button>
              <button type="button" className="chip__x" aria-label={`Remove ${a.id}`} onClick={() => props.onRemoveAttachment(a.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder={messages.length ? "Ask for a change — “turn the second chart into a table”" : "Attach data, then describe the report you need"}
      />
      <div className="composer__row">
        <button type="button" className="link" onClick={() => fileRef.current?.click()}>
          Attach CSV / JSON
        </button>
        {props.samples
          .filter((s) => !props.attachments.some((a) => a.id === s.id))
          .map((s) => (
            <button key={s.id} type="button" className="link link--muted" onClick={() => props.onAttachSample(s)}>
              + {s.label}
            </button>
          ))}
        <span className="composer__spacer" />
        {busy ? (
          <button type="button" className="send" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={!text.trim()}>
            Send
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

  return (
    <main className="thread" aria-label="Report agent chat">
      <div className="thread__scroll">
        <div className="thread__column">
          {messages.length === 0 ? (
            <div className="intro">
              <h1>What should the report answer?</h1>
              <p>Attach a CSV or JSON file, or use a sample, and ask in plain words. The report is written into the conversation and updates while the agent works.</p>
              <ul className="intro__starters">
                {props.starters.map((s) => (
                  <li key={s.label}>
                    <button type="button" onClick={() => props.onStarter(s)}>
                      <strong>{s.label}</strong>
                      <span>{s.prompt}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {messages.map((m) => {
            if (m.role === "user") {
              const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
              const { body, files } = splitNote(text);
              return (
                <article key={m.id} className="msg msg--user">
                  {files.length ? (
                    <ul className="chips chips--sent">
                      {files.map((f) => (
                        <li key={f} className="chip">
                          <button type="button" className="chip__open" title="View data" onClick={() => props.onOpenData(f.split(" — ")[0]!)}>
                            <span className="chip__label">{f}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="msg__text">{body}</p>
                </article>
              );
            }
            return (
              <article key={m.id} className="msg msg--assistant">
                {m.parts.map((part, i) =>
                  part.type === "text" ? <Markdown key={i} className="msg__text" text={part.text} context={context} /> : <ToolLine key={i} part={part} />,
                )}
                {props.artifact(m)}
              </article>
            );
          })}
          {busy ? <p className="thread__status">Working…</p> : null}
          {error ? (
            <p className="thread__error" role="alert">
              {error.message}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <div className="thread__dock">{composer}</div>
    </main>
  );
}
