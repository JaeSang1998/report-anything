import { BookOpen, Monitor, Moon, PanelLeft, PanelLeftClose, SquarePen, Sun, Trash2, Wand2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ModelChoice } from "../server/chat.js";
import { groupByDay } from "./history.js";
import type { StoredChat } from "./history.js";
import type { ThemePreference } from "./theme.js";

const REPO = "https://github.com/JaeSang1998/report-anything";

/** The mark is the engine's own "feature" composition: a lead block beside two stacked ones. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="1" width="11" height="18" rx="2.5" fill="currentColor" />
      <rect x="14" y="1" width="5" height="8" rx="2" fill="currentColor" opacity="0.55" />
      <rect x="14" y="11" width="5" height="8" rx="2" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

/** GitHub's mark (lucide ships no brand icons). */
function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const THEME_ICON: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL: Record<ThemePreference, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

export function Sidebar(props: {
  chats: StoredChat[];
  activeId: string;
  onNew(): void;
  onOpen(chat: StoredChat): void;
  onDelete(id: string): void;
  onClose(): void;
}) {
  const groups = groupByDay(props.chats);
  return (
    <>
      <nav className="sidebar" aria-label="Chats">
        <div className="sidebar__top">
          <a className="brand" href={REPO} target="_blank" rel="noreferrer">
            <BrandMark />
            <span>report-anything</span>
          </a>
          <button type="button" className="icon-btn" aria-label="Close sidebar" title="Close sidebar" onClick={props.onClose}>
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button type="button" className="sidebar__new" onClick={props.onNew}>
          <SquarePen size={16} />
          New chat
        </button>
        <div className="sidebar__history">
          {groups.length === 0 ? <p className="sidebar__empty">Your chats appear here. They stay in this browser.</p> : null}
          {groups.map((g) => (
            <section key={g.label} className="sidebar__group">
              <h2>{g.label}</h2>
              <ul>
                {g.chats.map((c) => (
                  <li key={c.id} className="history-item" aria-current={c.id === props.activeId ? "page" : undefined}>
                    <button type="button" className="history-item__open" onClick={() => props.onOpen(c)}>
                      {c.title}
                    </button>
                    <button type="button" className="history-item__delete" aria-label={`Delete “${c.title}”`} title="Delete chat" onClick={() => props.onDelete(c.id)}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="sidebar__foot">
          <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">
            <BookOpen size={16} />
            Documentation
          </a>
          <a href={`${REPO}/blob/main/skills/report-anything/SKILL.md`} target="_blank" rel="noreferrer">
            <Wand2 size={16} />
            Agent skill
          </a>
        </div>
      </nav>
      <button type="button" className="scrim" aria-label="Close sidebar" tabIndex={-1} onClick={props.onClose} />
    </>
  );
}

export function Header(props: {
  agent: ModelChoice | null;
  sidebarOpen: boolean;
  theme: ThemePreference;
  onToggleSidebar(): void;
  onNew(): void;
  onCycleTheme(): void;
}) {
  const ThemeIcon = THEME_ICON[props.theme];
  return (
    <header className="header">
      {props.sidebarOpen ? null : (
        <>
          <button type="button" className="icon-btn" aria-label="Open sidebar" title="Open sidebar" onClick={props.onToggleSidebar}>
            <PanelLeft size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="New chat" title="New chat" onClick={props.onNew}>
            <SquarePen size={18} />
          </button>
        </>
      )}
      <div className="header__agent" title={props.agent ? `${props.agent.provider} via the dev server` : "Deterministic agent running in this browser"}>
        <span className="header__agent-name">{props.agent ? props.agent.modelId : "Local agent"}</span>
        <span className="header__agent-note">{props.agent ? props.agent.provider : "no API key"}</span>
      </div>
      <span className="header__spacer" />
      <button type="button" className="icon-btn" aria-label={THEME_LABEL[props.theme]} title={THEME_LABEL[props.theme]} onClick={props.onCycleTheme}>
        <ThemeIcon size={18} />
      </button>
      <a className="icon-btn" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub repository" title="GitHub repository">
        <GitHubMark />
      </a>
    </header>
  );
}
