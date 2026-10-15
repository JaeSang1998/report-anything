import type { ReportSpec } from "@report-anything/core";
import type { ReportAgentMessage } from "../server/tools.js";
import type { Attachment } from "./data.js";

/** Report version produced by one apply_ops call, so earlier messages keep showing what they built. */
export interface ReportVersion {
  spec: ReportSpec;
  revision: number;
}

/** Everything needed to reopen a conversation: the thread, the report it built and the data attached to it. */
export interface StoredChat {
  id: string;
  title: string;
  updatedAt: number;
  messages: ReportAgentMessage[];
  /** Latest report and its revision; undefined until the first op. */
  spec?: ReportSpec;
  revision?: number;
  versions: Record<string, ReportVersion>;
  attachments: Attachment[];
  /** Dataset ids already announced to the agent in a user message. */
  announced: string[];
}

const KEY = "report-anything.playground.chats";
const MAX_CHATS = 20;

export function newChat(): StoredChat {
  return { id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now(), messages: [], versions: {}, attachments: [], announced: [] };
}

/** Stored by this app only, so a light structural check is enough; a shape change between versions starts over. */
function isStoredChat(x: unknown): x is StoredChat {
  if (typeof x !== "object" || x === null) return false;
  const c: Partial<Record<keyof StoredChat, unknown>> = x;
  return typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.messages) && Array.isArray(c.attachments) && typeof c.versions === "object";
}

export function loadChats(): StoredChat[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isStoredChat) : [];
  } catch {
    return [];
  }
}

/** Saves the newest chats that fit; datasets make chats large, so the oldest are dropped when storage is full. */
export function saveChats(chats: StoredChat[]): void {
  let list = chats.filter((c) => c.messages.length > 0).slice(0, MAX_CHATS);
  while (list.length > 0) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, -1);
    }
  }
  localStorage.removeItem(KEY);
}

/** Sidebar title: the first user message, without the attachment note and code blocks. */
export function titleFrom(messages: ReportAgentMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
  const line = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\n\n\(attached datasets:[\s\S]*\)$/, "")
    .trim()
    .split("\n")[0];
  return line ? (line.length > 60 ? `${line.slice(0, 57)}…` : line) : "New chat";
}

/** Sidebar groups by recency, like every chat app. */
export function groupByDay(chats: StoredChat[], now = Date.now()): Array<{ label: string; chats: StoredChat[] }> {
  const day = 86_400_000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const groups: Array<{ label: string; test: (t: number) => boolean; chats: StoredChat[] }> = [
    { label: "Today", test: (t) => t >= startOfToday, chats: [] },
    { label: "Yesterday", test: (t) => t >= startOfToday - day, chats: [] },
    { label: "Previous 7 days", test: (t) => t >= startOfToday - 7 * day, chats: [] },
    { label: "Older", test: () => true, chats: [] },
  ];
  for (const c of chats) groups.find((g) => g.test(c.updatedAt))!.chats.push(c);
  return groups.filter((g) => g.chats.length > 0).map(({ label, chats }) => ({ label, chats }));
}
