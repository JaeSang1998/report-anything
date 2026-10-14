import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, DirectChatTransport, isStepCount, lastAssistantMessageIsCompleteWithToolCalls, ToolLoopAgent } from "ai";
import type { ChatTransport } from "ai";
import { z } from "zod";
import { createReportSession } from "@report-anything/core";
import type { ReportSession, ReportSpec } from "@report-anything/core";
import { useReportSnapshot } from "@report-anything/react";
import type { ModelChoice } from "../server/chat.js";
import { reportTools } from "../server/tools.js";
import type { ReportAgentMessage } from "../server/tools.js";
import { createToolRunner, summarize } from "./agent.js";
import { Chat } from "./Chat.js";
import { DataViewer } from "./DataViewer.js";
import { FrozenReport, LiveReport } from "./ReportArtifact.js";
import { attachmentFromFile, SAMPLE_DATA } from "./data.js";
import type { Attachment } from "./data.js";
import { createLocalReportModel } from "./local-agent.js";

const STARTERS = [
  { label: "Executive sales review", prompt: "Build an executive report for H1 2026: year-over-year growth, which regions and channels drove it, and what to do next.", sample: SAMPLE_DATA.sales },
  { label: "SaaS board update", prompt: "Write a board update on MRR: growth by plan, churn, and where expansion comes from.", sample: SAMPLE_DATA.saas },
  { label: "Acquisition channel review", prompt: "Which acquisition channels and devices convert best, and how did traffic trend over the last six months?", sample: SAMPLE_DATA.traffic },
  { label: "Support quarter in review", prompt: "Review support for Q3: ticket volume, resolution time by priority and category, and customer satisfaction.", sample: SAMPLE_DATA.tickets },
  { label: "Orders API deep dive", prompt: "Analyze this orders API response: what drives revenue and where do refunds come from?", sample: SAMPLE_DATA.orders },
];

const AgentShape = z.object({ provider: z.enum(["anthropic", "openai"]), modelId: z.string() }).nullable();

/** Hosted model through /api/chat when a key is configured; otherwise the keyless agent runs in the browser. */
function createTransport(agent: ModelChoice | null, getSession: () => ReportSession): ChatTransport<ReportAgentMessage> {
  if (agent) return new DefaultChatTransport({ api: "/api/chat", body: () => ({ report: summarize(getSession()) }) });
  const local = new ToolLoopAgent({ model: createLocalReportModel(getSession), tools: reportTools, stopWhen: isStepCount(1) });
  // DirectChatTransport is typed for UIMessage<unknown, never, InferUITools>; ours only adds typed tool outputs.
  const direct = new DirectChatTransport({ agent: local }) as unknown as ChatTransport<ReportAgentMessage>;
  return direct;
}

export function App() {
  // undefined = still asking the dev server which agent is configured.
  const [agent, setAgent] = useState<ModelChoice | null>();
  useEffect(() => {
    // The static build (GitHub Pages) has no server: it always runs the keyless local agent.
    if (!import.meta.env.DEV) return setAgent(null);
    fetch("/api/agent")
      .then((r) => r.json())
      .then((json: unknown) => setAgent(AgentShape.parse(json)))
      .catch(() => setAgent(null));
  }, []);
  return agent === undefined ? null : <Playground agent={agent} />;
}

function Playground({ agent }: { agent: ModelChoice | null }) {
  const [session, setSession] = useState<ReportSession>(() => createReportSession());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string>();
  const [viewing, setViewing] = useState<string>();
  const snapshot = useReportSnapshot(session);
  const runner = useMemo(() => createToolRunner(session), [session]);

  // The transport is created once; refs give it the live session.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  /** Report version produced by each apply_ops call, so earlier messages keep showing what they built. */
  const versions = useRef(new Map<string, { spec: ReportSpec; revision: number }>());

  const [transport] = useState(() => createTransport(agent, () => sessionRef.current));
  const { messages, sendMessage, addToolOutput, status, error, stop, setMessages, clearError } = useChat<ReportAgentMessage>({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      const r = runnerRef.current;
      switch (toolCall.toolName) {
        case "apply_ops":
          addToolOutput({ tool: "apply_ops", toolCallId: toolCall.toolCallId, output: r.applyOps(toolCall.toolCallId, toolCall.input.ops) });
          versions.current.set(toolCall.toolCallId, { spec: sessionRef.current.getSnapshot().spec, revision: sessionRef.current.getSnapshot().revision });
          return;
        case "inspect_report":
          addToolOutput({ tool: "inspect_report", toolCallId: toolCall.toolCallId, output: r.inspect(toolCall.input.mode) });
          return;
        case "profile_dataset":
          addToolOutput({ tool: "profile_dataset", toolCallId: toolCall.toolCallId, output: r.profile(toolCall.input.dataset) });
          return;
      }
    },
  });

  // Apply ops while the model is still streaming them, so the report builds up live.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return;
    for (const part of last.parts) {
      if (part.type === "tool-apply_ops" && part.state === "input-streaming" && Array.isArray(part.input?.ops)) {
        runner.streamOps(part.toolCallId, part.input.ops);
      }
    }
  }, [messages, runner]);

  // Between a tool result and the automatic resubmit the status is briefly "ready"; the turn is not over yet.
  const busy = status === "submitted" || status === "streaming" || lastAssistantMessageIsCompleteWithToolCalls({ messages });

  const attach = (a: Attachment) => {
    // Attached data goes into the report immediately; the agent sees its schema, never its rows.
    const result = session.apply({ op: "setDataset", id: a.id, dataset: a.dataset });
    if (!result.ok) return setAttachError(result.issues.map((i) => i.message).join("; "));
    setAttachError(undefined);
    setAttachments((list) => [...list.filter((x) => x.id !== a.id), a]);
  };

  const attachFiles = async (files: FileList) => {
    for (const file of files) {
      try {
        attach(await attachmentFromFile(file, new Set(Object.keys(session.getSnapshot().spec.datasets))));
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const sentAttachments = useRef(new Set<string>());
  const send = (text: string, extra: Attachment[] = []) => {
    const fresh = [...attachments, ...extra].filter((a) => !sentAttachments.current.has(a.id));
    fresh.forEach((a) => sentAttachments.current.add(a.id));
    const note = fresh.length ? `\n\n(attached datasets: ${fresh.map((a) => `${a.id} — ${a.label}`).join(", ")})` : "";
    void sendMessage({ text: `${text}${note}` });
  };

  const reset = () => {
    stop();
    setMessages([]);
    clearError();
    setAttachments([]);
    setAttachError(undefined);
    sentAttachments.current.clear();
    versions.current.clear();
    setSession(createReportSession());
  };

  // The newest assistant message that edited the report shows it live; earlier ones keep the version they produced.
  const reportMessages = messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.type === "tool-apply_ops"));
  const latestReport = reportMessages[reportMessages.length - 1]?.id;
  const artifact = (m: ReportAgentMessage) => {
    if (m.id === latestReport) return <LiveReport session={session} />;
    const lastCall = m.parts.findLast((p) => p.type === "tool-apply_ops");
    const version = lastCall && "toolCallId" in lastCall ? versions.current.get(lastCall.toolCallId) : undefined;
    return version ? <FrozenReport spec={version.spec} revision={version.revision} /> : null;
  };

  return (
    <div className="app">
      <header className="bar">
        <strong className="bar__name">report-anything</strong>
        <span className="bar__meta">{agent ? agent.modelId : "local agent · no API key"}</span>
        <span className="bar__spacer" />
        <button type="button" className="link" onClick={reset}>
          New chat
        </button>
      </header>
      <Chat
        messages={messages}
        busy={busy}
        error={error ?? (attachError ? new Error(attachError) : undefined)}
        context={snapshot.context}
        attachments={attachments}
        samples={Object.values(SAMPLE_DATA)}
        starters={STARTERS}
        artifact={artifact}
        onSend={send}
        onStop={stop}
        onAttachFiles={(files) => void attachFiles(files)}
        onAttachSample={attach}
        onRemoveAttachment={(id) => {
          session.apply({ op: "removeDataset", id });
          setAttachments((list) => list.filter((a) => a.id !== id));
        }}
        onOpenData={setViewing}
        onStarter={(s) => {
          const extra = s.sample && !attachments.some((a) => a.id === s.sample!.id) ? [s.sample] : [];
          extra.forEach(attach);
          send(s.prompt, extra);
        }}
      />
      {viewing ? (
        <DataViewer
          id={viewing}
          dataset={snapshot.spec.datasets[viewing]}
          resolved={snapshot.context.datasets.get(viewing)}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
    </div>
  );
}
