/**
 * The assistant's brain: a command becomes a sequence of tool calls, and the
 * results become an answer.
 *
 * Two paths, same tools:
 *
 *  - If VITE_LLM_BASE is configured, an OpenAI-compatible chat endpoint drives
 *    the loop with function calling. That handles phrasing the rule-based path
 *    has never seen.
 *  - Otherwise a deterministic planner reads the intent from the text. It is
 *    not conversational, but it needs no key, no network beyond this app's own
 *    API, and it cannot invent a step.
 *
 * Either way the *numbers* come from analysis.ts, never from a model. The LLM
 * is allowed to choose actions and to write prose around findings; it is not
 * allowed to be the source of a hectare figure.
 */

import type { StressReport } from "./analysis";
import { TOOLS, TOOL_BY_NAME, toolSchemas, type ToolContext } from "./tools";

/* --------------------------------------------------------------- events */

export type TurnEvent =
  | { kind: "note"; text: string }
  | { kind: "tool"; id: string; name: string; args: unknown }
  | { kind: "tool-done"; id: string; summary: string }
  | { kind: "tool-failed"; id: string; error: string }
  | { kind: "report"; report: StressReport }
  | { kind: "answer"; text: string };

export type Emit = (e: TurnEvent) => void;

/* ------------------------------------------------------------ llm config */

const LLM_BASE = import.meta.env.VITE_LLM_BASE as string | undefined;
const LLM_MODEL = (import.meta.env.VITE_LLM_MODEL as string | undefined) ?? "gpt-4o-mini";
const LLM_KEY = import.meta.env.VITE_LLM_KEY as string | undefined;

export const llmConfigured = Boolean(LLM_BASE);

const SYSTEM = `You are the GeoFlow assistant, embedded in a precision-agriculture app.

The user draws a field boundary, an analysis is planned into a node graph by the
backend, runs on Google Earth Engine data (Sentinel-2 indices and WaPOR
evapotranspiration), and produces statistics artifacts.

What an analysis can answer, depending on the question asked:
  - water stress: which parts of the field are short of water, and by how much
  - irrigation: how many millimetres to apply, net of forecast rainfall
  - yield: expected harvest in tonnes per hectare, from seasonal water use
           and how much of the season was spent under stress
  - vegetation indices: NDVI, NDMI, or SAVI where the canopy is sparse
The backend plans the right graph from the question, so pass the user's
question through rather than deciding the pipeline yourself.

Rules:
- Use the tools to act. Never claim you did something you did not call a tool for.
- Never state a number that did not come out of a tool result. analyse_results
  returns the authoritative findings; quote them, do not recompute or round them.
- A full request like "analyse this field" means: create_analysis, wait_for_plan,
  run_analysis, wait_for_run, then analyse_results. Chain them without asking.
- Pick the first tool by what the user asked for, not by what sounds closest:
    status / progress / "kitna hua" / "chal raha hai?"  -> check_run
    run / execute / "chalao" / "chala do" (then report)  -> run_analysis, then
                                                            wait_for_run, then
                                                            analyse_results
    results / explain / "batao" / "saara analysis"       -> analyse_results
    outputs / files                                       -> list_artifacts
    3D / 2D / satellite / dark / light / fly to their field -> control_map
    zoom to a city, region or country                     -> fly_to_place
    how big / area / size / "kitna bara"                  -> measure_field
    weather / rain / forecast / "barish"                  -> get_weather
    save / export / download an output                    -> download_result
    yield / harvest / "kitni paidawar" / "what will I get" -> create_analysis
                                        with that question, then the usual chain
  get_workflow describes the plan; it does NOT say how a run is going.
- measure_field and get_weather work on a boundary just drawn, before any
  analysis exists. Do not ask the user to create one first.
- A yield or irrigation figure is an indicative estimate from uncalibrated
  coefficients. Quote it with that caveat; never present it as a forecast.
- If a tool fails, say plainly what failed and what the user can do about it.
- The user may write in English, Urdu/Hindi, or a mix. Answer in the language
  they used.
- Be concise. Lead with the finding, then the caveat, then the recommendation.`;

/* --------------------------------------------------------------- runner */

export async function runTurn(
  userText: string,
  ctx: ToolContext,
  emit: Emit,
  history: ChatMessage[] = [],
): Promise<ChatMessage[]> {
  if (llmConfigured) {
    try {
      return await runWithLLM(userText, ctx, emit, history);
    } catch (err: any) {
      // A dead model endpoint should degrade to something useful rather than
      // leaving the user with an error and no action taken.
      emit({
        kind: "note",
        text: `Model endpoint unavailable (${err?.message ?? "no reason"}) — falling back to direct commands.`,
      });
    }
  }
  await runDeterministic(userText, ctx, emit);
  return history;
}

/* ------------------------------------------------------------ llm path */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const MAX_STEPS = 10;

async function runWithLLM(
  userText: string,
  ctx: ToolContext,
  emit: Emit,
  history: ChatMessage[],
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM}\n\n${situation(ctx)}` },
    ...history,
    { role: "user", content: userText },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(`${LLM_BASE!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        tools: toolSchemas(),
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const body = await res.json();
    const msg = body?.choices?.[0]?.message;
    if (!msg) throw new Error("the model returned no message");

    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      const text = (msg.content ?? "").trim();
      if (text) emit({ kind: "answer", text });
      return messages.slice(1);        // drop the system prompt from history
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* model slipped */ }

      emit({ kind: "tool", id: call.id, name, args });
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        emit({ kind: "tool-failed", id: call.id, error: `no such tool: ${name}` });
        messages.push({ role: "tool", tool_call_id: call.id, content: `error: no tool named ${name}` });
        continue;
      }
      try {
        const out = await tool.run(args, ctx);
        emit({ kind: "tool-done", id: call.id, summary: out.summary });
        if (out.report) emit({ kind: "report", report: out.report });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(out.data).slice(0, 8000),
        });
      } catch (err: any) {
        const message = err?.message ?? "failed";
        emit({ kind: "tool-failed", id: call.id, error: message });
        messages.push({ role: "tool", tool_call_id: call.id, content: `error: ${message}` });
      }
    }
  }

  emit({ kind: "answer", text: "I stopped after ten steps without reaching an answer." });
  return messages.slice(1);
}

function situation(ctx: ToolContext): string {
  return [
    "Current context:",
    `- boundary on screen: ${ctx.aoi ? "yes" : "no"}`,
    `- analysis open: ${ctx.workflowId ?? "none"}`,
    `- default date range: ${ctx.dateRange.start} to ${ctx.dateRange.end}`,
    `- today: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
}

/* --------------------------------------------------- deterministic path */

/**
 * Intent keywords, English and Roman Urdu/Hindi, because that is how this app
 * is actually spoken to. Order matters: the first intent whose words appear
 * wins, so the composite "do everything" intent is tested before "run".
 */
const INTENTS: { name: string; words: RegExp; plan: string[] }[] = [
  {
    name: "full",
    words: /\b(full analysis|end to end|analyse this field|analyze this field|do everything|sab kuch|saara|sara analysis|poora|pura analysis|complete analysis)\b/i,
    plan: ["create_analysis", "wait_for_plan", "run_analysis", "wait_for_run", "analyse_results"],
  },
  {
    name: "compare",
    words: /\b(compare|comparison|versus|vs\.?|difference between runs|farq)\b/i,
    plan: ["compare_runs"],
  },
  {
    name: "create",
    words: /\b(create|new analysis|start an analysis|banao|bana do|naya)\b/i,
    plan: ["create_analysis", "wait_for_plan"],
  },
  {
    name: "run",
    words: /\b(run|execute|start it|chalao|chala do|chalu)\b/i,
    plan: ["run_analysis", "wait_for_run", "analyse_results"],
  },
  {
    name: "analyse",
    words: /\b(analys|analyz|result|summar|interpret|explain|report|findings|stress|batao|bata do|samjhao|kya hai)\b/i,
    plan: ["analyse_results"],
  },
  {
    name: "status",
    words: /\b(status|progress|how far|kitna hua|chal raha)\b/i,
    plan: ["check_run"],
  },
  {
    name: "artifacts",
    words: /\b(artifact|output|files|downloads?)\b/i,
    plan: ["list_artifacts"],
  },
  {
    name: "list",
    words: /\b(list|show me|my analyses|workflows|dikhao|dikha do)\b/i,
    plan: ["list_workflows"],
  },
  {
    name: "nodes",
    words: /\b(nodes?|catalog|capabilit|what can you do|kya kar sakte)\b/i,
    plan: ["list_node_types"],
  },
];

const MAP_WORDS = /\b(3d|2d|globe|satellite|imagery|dark|light|fly to|zoom to|map)\b/i;

async function runDeterministic(text: string, ctx: ToolContext, emit: Emit) {
  const plan: { tool: string; args: any }[] = [];

  // Map commands compose with anything else, so they are checked separately
  // and run first -- "show it in 3d and analyse" does both.
  if (MAP_WORDS.test(text)) {
    const args: any = {};
    if (/\b3d|globe\b/i.test(text)) args.mode = "3d";
    else if (/\b2d\b/i.test(text)) args.mode = "2d";
    if (/satellite|imagery/i.test(text)) args.basemap = "satellite";
    else if (/\bdark\b/i.test(text)) args.basemap = "dark";
    else if (/\blight\b/i.test(text)) args.basemap = "light";
    if (/fly to|zoom to/i.test(text)) args.fly_to_workflow = ctx.workflowId ?? undefined;
    if (Object.keys(args).length) plan.push({ tool: "control_map", args });
  }

  const intent = INTENTS.find((i) => i.words.test(text));
  if (intent) {
    const dates = readDates(text);
    for (const tool of intent.plan) {
      plan.push({
        tool,
        args: tool === "create_analysis"
          ? { question: text.trim(), ...dates }
          : {},
      });
    }
  }

  if (!plan.length) {
    emit({ kind: "answer", text: helpText(ctx) });
    return;
  }

  // "run"/"analyse" against nothing selected is a common first message; say so
  // once, up front, instead of failing three tools deep.
  const needsTarget = plan.some((p) =>
    ["run_analysis", "analyse_results", "check_run", "list_artifacts", "compare_runs", "wait_for_run"].includes(p.tool),
  );
  const creating = plan.some((p) => p.tool === "create_analysis");
  if (needsTarget && !creating && !ctx.workflowId) {
    emit({
      kind: "answer",
      text: "Open an analysis first (Workflows → pick one), or draw a field boundary and ask me to run a full analysis on it.",
    });
    return;
  }

  const results: { tool: string; summary: string }[] = [];
  for (const step of plan) {
    const tool = TOOL_BY_NAME.get(step.tool)!;
    const id = `${step.tool}-${results.length}`;
    emit({ kind: "tool", id, name: step.tool, args: step.args });
    try {
      const out = await tool.run(step.args, ctx);
      emit({ kind: "tool-done", id, summary: out.summary });
      if (out.report) emit({ kind: "report", report: out.report });
      results.push({ tool: step.tool, summary: out.summary });
      if (out.report) {
        // The report is the answer; anything appended would be paraphrase.
        emit({ kind: "answer", text: closing(out.report) });
        return;
      }
      if (!out.report && step.tool === "list_workflows") {
        const rows = out.data as any[];
        emit({
          kind: "answer",
          text: rows.length
            ? `${rows.length} analyses. Newest: “${rows[0].query}” (${rows[0].status}). Ask me to open or analyse any of them.`
            : "No analyses yet. Draw a field on New analysis and ask me to run a full analysis.",
        });
        return;
      }
      if (step.tool === "list_node_types") {
        const rows = out.data as any[];
        emit({
          kind: "answer",
          text: `The planner can use ${rows.length} node types:\n` +
            rows.map((r) => `• ${r.type} — ${r.description}`).join("\n"),
        });
        return;
      }
    } catch (err: any) {
      emit({ kind: "tool-failed", id, error: err?.message ?? "failed" });
      emit({ kind: "answer", text: `Stopped at ${step.tool}: ${err?.message ?? "it failed"}` });
      return;
    }
  }

  emit({
    kind: "answer",
    text: results.map((r) => `${r.tool}: ${r.summary}`).join("\n"),
  });
}

/** Two ISO dates, or a bare year, taken as that year's growing season. */
function readDates(text: string): { start?: string; end?: string } {
  const iso = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (iso && iso.length >= 2) return { start: iso[0], end: iso[1] };
  const year = text.match(/\b(20[1-3]\d)\b/);
  if (year) return { start: `${year[1]}-06-01`, end: `${year[1]}-09-30` };
  return {};
}

function closing(report: StressReport): string {
  const head = report.findings.find((f) => f.kind === "headline");
  const rec = report.findings.find((f) => f.kind === "recommendation");
  return [head?.text, rec?.text].filter(Boolean).join(" ");
}

function helpText(ctx: ToolContext): string {
  return [
    "I can act on your data, not just talk about it. Try:",
    "• “run a full analysis on this field for 2024” — creates, plans, runs and interprets it",
    ctx.workflowId ? "• “analyse the results” — reads this run's stats and explains them" : "• “list my analyses”",
    "• “what's the status?” · “show the outputs” · “compare the last two runs”",
    "• “show it in 3D on satellite”",
    llmConfigured ? "" : "(Set VITE_LLM_BASE to let me handle free-form phrasing too.)",
  ].filter(Boolean).join("\n");
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);