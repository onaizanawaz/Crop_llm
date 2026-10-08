/**
 * The assistant dock.
 *
 * Every action it takes is shown as it happens: a command produces a visible
 * trace of tool calls with their outcomes, then the findings, then a sentence.
 * That ordering is deliberate -- an agent that acts on someone's field data
 * has to be auditable, so the trace is part of the answer rather than a debug
 * affordance hidden behind a toggle.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { runTurn, llmConfigured, type ChatMessage, type TurnEvent } from "../ai/agent";
import { useAssistant, useAssistantDraft } from "../ai/AssistantContext";
import type { StressReport } from "../ai/analysis";
import type { ToolContext } from "../ai/tools";
import StressReportView from "./StressReportView";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "note"; text: string }
  | { kind: "report"; report: StressReport }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      status: "running" | "ok" | "error";
      detail?: string;
    };

const SUGGESTIONS = [
  "Run a full analysis on this field for 2024",
  "Analyse the results and explain them",
  "What's the status?",
  "Show it in 3D on satellite",
  "Compare the last two runs",
];

export default function Assistant() {
  const { open, setOpen, aoi, dateRange } = useAssistant();
  const nav = useNavigate();
  const loc = useLocation();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const history = useRef<ChatMessage[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // A workflow the assistant created this session outlives the page it was
  // created from, so "run it" still resolves after navigation.
  const created = useRef<string | null>(null);

  /** The analysis on screen, read from the route rather than duplicated in state. */
  const routeWorkflow = loc.pathname.match(/^\/w\/([^/]+)/)?.[1] ?? null;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [entries, busy]);

  // Opening a command bar should leave you able to type into it.
  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open]);

  // Cmd/Ctrl+K opens the dock from anywhere, the way a command bar should.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  function push(e: Entry) { setEntries((prev) => [...prev, e]); }

  function apply(ev: TurnEvent) {
    setEntries((prev) => {
      switch (ev.kind) {
        case "tool":
          return [...prev, { kind: "tool", id: ev.id, name: ev.name, args: ev.args, status: "running" }];
        case "tool-done":
          return prev.map((e) =>
            e.kind === "tool" && e.id === ev.id
              ? { ...e, status: "ok", detail: ev.summary } : e);
        case "tool-failed":
          return prev.map((e) =>
            e.kind === "tool" && e.id === ev.id
              ? { ...e, status: "error", detail: ev.error } : e);
        case "report":
          return [...prev, { kind: "report", report: ev.report }];
        case "note":
          return [...prev, { kind: "note", text: ev.text }];
        case "answer":
          return [...prev, { kind: "answer", text: ev.text }];
        default:
          return prev;
      }
    });
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    push({ kind: "user", text: message });
    setBusy(true);

    const ctx: ToolContext = {
      aoi,
      // A getter, not a copy: remember() fires part-way through a turn, and
      // every later tool in that same plan must target what it created.
      get workflowId() { return routeWorkflow ?? created.current; },
      dateRange,
      navigate: nav,
      report: (line) => apply({ kind: "note", text: line }),
      remember: (id) => { created.current = id; },
    };

    try {
      history.current = await runTurn(message, ctx, apply, history.current);
    } catch (err: any) {
      apply({ kind: "answer", text: `Something went wrong: ${err?.message ?? err}` });
    } finally {
      setBusy(false);
    }
  }

  // Closed: nothing on screen. The topbar's Assistant button is the way in,
  // so the map keeps its corners and the page keeps its attribution visible.
  if (!open) return null;

  return (
    <aside className="assistant" aria-label="Analysis assistant">
      <header className="assistant-head">
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>Assistant</p>
          <div className="assistant-sub mono">
            {llmConfigured ? "model + tools" : "direct commands"}
            {routeWorkflow && ` · ${routeWorkflow.slice(0, 8)}`}
            {aoi && " · boundary ready"}
          </div>
        </div>
        <button className="btn quiet sm" onClick={() => setOpen(false)}>Close</button>
      </header>

      <div className="assistant-scroll" ref={scroller} role="log" aria-live="polite" aria-busy={busy}>
        {entries.length === 0 && (
          <div className="assistant-intro">
            <p>
              I can act on your data: create an analysis over the field on screen,
              run it, follow it to completion, then read the statistics and tell you
              what they mean.
            </p>
            <div className="assistant-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {entries.map((e, i) => <EntryView key={i} entry={e} />)}

        {busy && (
          <div className="assistant-busy">
            <span className="spinner" aria-hidden="true" />
            <span>Working…</span>
          </div>
        )}
      </div>

      <Composer busy={busy} onSend={send} inputRef={composer} />
    </aside>
  );
}

/* ---------------------------------------------------------------- pieces */

/**
 * The composer, and the only subscriber to the draft context.
 *
 * Kept apart from the transcript above it: the draft changes on every
 * keystroke, and if the dock read it directly then every character retyped
 * the whole conversation, tool trace and report included.
 */
function Composer({ busy, onSend, inputRef }: {
  busy: boolean;
  onSend: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { draft, setDraft } = useAssistantDraft();

  function submit() {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
  }

  return (
    <form className="assistant-composer" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
      <textarea
        ref={inputRef}
        aria-label="Ask the assistant"
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          // Enter sends; Shift+Enter is a newline. A command bar that needs a
          // mouse to submit is not a command bar.
          if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); }
        }}
        placeholder="Tell me what to do with this field…"
        rows={2}
      />
      <button className="btn" type="submit" disabled={busy || !draft.trim()}>
        {busy ? <span className="spinner" aria-hidden="true" /> : "Send"}
      </button>
    </form>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === "user") {
    return <div className="msg user">{entry.text}</div>;
  }
  if (entry.kind === "answer") {
    return <div className="msg answer">{entry.text}</div>;
  }
  if (entry.kind === "note") {
    return <div className="msg note mono">{entry.text}</div>;
  }
  if (entry.kind === "tool") {
    return (
      <div className={`tool-call ${entry.status}`}>
        <span className="tool-dot" aria-hidden="true">
          {entry.status === "running" ? <span className="spinner" /> :
           entry.status === "ok" ? "✓" : "✕"}
        </span>
        <span className="tool-name mono">{entry.name}</span>
        {entry.detail && <span className="tool-detail">{entry.detail}</span>}
      </div>
    );
  }

  // The report is the whole point of the feature, so it is a shared component:
  // identical here and on the analysis page.
  return <StressReportView report={entry.report} className="card" />;
}