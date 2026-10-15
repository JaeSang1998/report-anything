import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, DirectChatTransport, isStepCount, lastAssistantMessageIsCompleteWithToolCalls, ToolLoopAgent } from "ai";
import type { ChatTransport } from "ai";
import { z } from "zod";
import { ArrowLeftRight, ChartColumnDecreasing, ChartLine, ChartPie, FileText, LayoutPanelTop, Workflow } from "lucide-react";
import { createReportSession } from "@report-anything/core";
import type { ReportSession } from "@report-anything/core";
import { useReportSnapshot } from "@report-anything/react";
import type { ModelChoice } from "../server/chat.js";
import { reportTools } from "../server/tools.js";
import type { ReportAgentMessage } from "../server/tools.js";
import { createToolRunner, summarize } from "./agent.js";
import { Chat } from "./Chat.js";
import type { Starter } from "./Chat.js";
import { DataViewer } from "./DataViewer.js";
import { FrozenReport, LiveReport } from "./ReportArtifact.js";
import { Header, Sidebar } from "./Shell.js";
import { attachmentFromFile, SAMPLE_DATA } from "./data.js";
import type { Attachment } from "./data.js";
import { loadChats, newChat, saveChats, titleFrom } from "./history.js";
import type { ReportVersion, StoredChat } from "./history.js";
import { createLocalReportModel } from "./local-agent.js";
import { useTheme } from "./theme.js";

/** One starter per report shape, so the same engine visibly produces different structures. */
const STARTERS: Starter[] = [
  { label: "Why did revenue change?", prompt: "Why did revenue change between H1 2025 and H1 2026? Show which regions drove it.", sample: SAMPLE_DATA.sales, icon: ChartColumnDecreasing },
  { label: "One-page MRR brief", prompt: "Give me a one-page brief on MRR for the board.", sample: SAMPLE_DATA.saas, icon: FileText },
  { label: "Traffic and conversion trend", prompt: "How have traffic and conversion trended over the last six months?", sample: SAMPLE_DATA.traffic, icon: ChartLine },
  { label: "Where is the support load?", prompt: "Break down support tickets by category and priority — where is the load?", sample: SAMPLE_DATA.tickets, icon: ChartPie },
  { label: "Compare order periods", prompt: "Compare this month's orders with last month.", sample: SAMPLE_DATA.orders, icon: ArrowLeftRight },
  { label: "Full overview", prompt: "Build an overview report of this sales data.", sample: SAMPLE_DATA.sales, icon: LayoutPanelTop },
  {
    label: "Paste a Mermaid diagram",
    prompt: "Ticket escalation flow\n\n```mermaid\nflowchart LR\n  A[New ticket] --> B{Priority?}\n  B -- P1 --> C[Page on-call]\n  B -- P2/P3 --> D[Queue by category]\n  B -- P4 --> E[Backlog]\n  C --> F[Incident channel]\n  D --> G{Resolved in SLA?}\n  G -- no --> C\n  G -- yes --> H[Close and survey]\n```",
    icon: Workflow,
  },
];

const AgentShape = z.object({ provider: z.enum(["anthropic", "openai"]), modelId: z.string() }).nullable();
const WIDE = "(min-width: 900px)";

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
  return agent === undefined ? null : <Workspace agent={agent} />;
}

/** Sidebar with the chat history, header, and the open conversation. */
function Workspace({ agent }: { agent: ModelChoice | null }) {
  const theme = useTheme();
  const [chats, setChats] = useState<StoredChat[]>(loadChats);
  const [active, setActive] = useState<StoredChat>(newChat);
  const [sidebar, setSidebar] = useState(() => matchMedia(WIDE).matches);

  const save = useCallback((chat: StoredChat) => {
    setChats((list) => {
      const next = [chat, ...list.filter((c) => c.id !== chat.id)];
      saveChats(next);
      return next;
    });
  }, []);

  // Crossing the breakpoint resets the sidebar: docked open on wide screens, a closed drawer on narrow ones.
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const onChange = () => setSidebar(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const closeOnNarrow = () => {
    if (!matchMedia(WIDE).matches) setSidebar(false);
  };
  const startNew = () => {
    setActive(newChat());
    closeOnNarrow();
  };

  return (
    <div className="app" data-sidebar={sidebar ? "open" : "closed"}>
      <Sidebar
        chats={chats}
        activeId={active.id}
        onNew={startNew}
        onOpen={(chat) => {
          setActive(chat);
          closeOnNarrow();
        }}
        onDelete={(id) => {
          setChats((list) => {
            const next = list.filter((c) => c.id !== id);
            saveChats(next);
            return next;
          });
          if (id === active.id) setActive(newChat());
        }}
        onClose={() => setSidebar(false)}
      />
      <div className="main">
        <Header
          agent={agent}
          sidebarOpen={sidebar}
          theme={theme.preference}
          onToggleSidebar={() => setSidebar((s) => !s)}
          onNew={startNew}
          onCycleTheme={theme.cycle}
        />
        <Playground key={active.id} agent={agent} initial={active} onSave={save} />
      </div>
    </div>
  );
}

function Playground({ agent, initial, onSave }: { agent: ModelChoice | null; initial: StoredChat; onSave(chat: StoredChat): void }) {
  const [session] = useState<ReportSession>(() => createReportSession(initial.spec, { revision: initial.revision }));
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments);
  const [attachError, setAttachError] = useState<string>();
  const [viewing, setViewing] = useState<string>();
  const snapshot = useReportSnapshot(session);
  const runner = useMemo(() => createToolRunner(session), [session]);

  // The transport is created once; refs give it the live state.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  /** Report version produced by each apply_ops call, so earlier messages keep showing what they built. */
  const versions = useRef(new Map<string, ReportVersion>(Object.entries(initial.versions)));
  const announced = useRef(new Set(initial.announced));

  const [transport] = useState(() => createTransport(agent, () => session));
  const { messages, sendMessage, addToolOutput, status, error, stop, clearError } = useChat<ReportAgentMessage>({
    id: initial.id,
    messages: initial.messages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      const r = runnerRef.current;
      switch (toolCall.toolName) {
        case "apply_ops":
          addToolOutput({ tool: "apply_ops", toolCallId: toolCall.toolCallId, output: r.applyOps(toolCall.toolCallId, toolCall.input.ops) });
          versions.current.set(toolCall.toolCallId, { spec: session.getSnapshot().spec, revision: session.getSnapshot().revision });
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

  // Save finished turns to the history (not every streamed token).
  useEffect(() => {
    if (busy || messages.length === 0) return;
    onSave({
      id: initial.id,
      title: titleFrom(messages),
      updatedAt: Date.now(),
      messages,
      spec: session.getSnapshot().spec,
      revision: session.getSnapshot().revision,
      versions: Object.fromEntries(versions.current),
      attachments,
      announced: [...announced.current],
    });
  }, [busy, messages, attachments, initial.id, session, onSave]);

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

  const send = (text: string, extra: Attachment[] = []) => {
    clearError();
    const fresh = [...attachments, ...extra].filter((a) => !announced.current.has(a.id));
    fresh.forEach((a) => announced.current.add(a.id));
    const note = fresh.length ? `\n\n(attached datasets: ${fresh.map((a) => `${a.id} — ${a.label}`).join(", ")})` : "";
    void sendMessage({ text: `${text}${note}` });
  };

  // The newest assistant message that edited the report shows it live; earlier ones keep the version they produced.
  const reportMessages = messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.type === "tool-apply_ops"));
  const latestReport = reportMessages[reportMessages.length - 1]?.id;
  const artifact = (m: ReportAgentMessage) => {
    if (m.id === latestReport) return <LiveReport session={session} building={busy} />;
    const lastCall = m.parts.findLast((p) => p.type === "tool-apply_ops");
    const version = lastCall && "toolCallId" in lastCall ? versions.current.get(lastCall.toolCallId) : undefined;
    return version ? <FrozenReport spec={version.spec} revision={version.revision} /> : null;
  };

  return (
    <>
      <Chat
        messages={messages}
        busy={busy}
        error={error ?? (attachError ? new Error(attachError) : undefined)}
        context={snapshot.context}
        agentLabel={agent ? agent.modelId : null}
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
    </>
  );
}
