/**
 * What the assistant is allowed to do.
 *
 * Each tool is a thin, auditable wrapper over one API call the user could make
 * themselves through the UI -- nothing here reaches past the routes in
 * api/client.ts, and nothing deletes. The schemas are written in the shape an
 * OpenAI-compatible function-calling endpoint wants, so the same registry
 * serves both the LLM path and the deterministic parser.
 */

import type { NavigateFunction } from "react-router-dom";
import type { Geometry, Polygon } from "geojson";

import { api } from "../api/client";
import type { ArtifactOut, RunSummary, StressStats, WorkflowRunOut } from "../api/types";
import { boundsOf } from "../map/basemaps";
import { geocode } from "./geocode";
import { areaM2, centroid, perimeterM, weatherAt } from "./fieldfacts";
import { analyseStress, statsDigest, type StressReport } from "./analysis";
import { sendMapCommand } from "./mapbus";

/** Everything a tool may read about where the user currently is. */
export interface ToolContext {
  /** The boundary on screen, if the user has drawn or opened one. */
  aoi: Polygon | Geometry | null;
  /**
   * The workflow the user is looking at, if any. Tools default to it.
   *
   * Read on every access, never copied: create_analysis calls remember()
   * mid-turn, and the tools after it in the same plan have to see that id.
   */
  readonly workflowId: string | null;
  dateRange: { start: string; end: string };
  navigate: NavigateFunction;
  /** Lets a long-running tool stream progress into the transcript. */
  report: (line: string) => void;
  /** Remembers a workflow the assistant itself created, for later tools. */
  remember: (workflowId: string) => void;
}

export interface ToolResult {
  /** Fed back to the model. Keep it small and factual. */
  data: unknown;
  /** Rendered in the transcript when present. */
  report?: StressReport;
  /** One-line summary for the tool trace. */
  summary: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True for anything that starts compute or creates a row. */
  mutating?: boolean;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const NO_ARGS = { type: "object", properties: {}, required: [] as string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tools default to the workflow on screen, so "run it" needs no id.
 *
 * An id the model supplies is only trusted when it is a whole uuid. Small
 * models read the shortened ids this file prints for people ("created
 * 5fa469f4") and hand them back as if they were the real thing; the backend
 * answers a malformed id with a 404 that reads like the workflow is gone.
 * Falling back to what is on screen is both truer and less alarming.
 */
const EXT: Record<string, string> = {
  raster: ".tif", json: ".json", scalar: ".json",
  vector: ".geojson", table: ".csv", ee_object: ".json",
};

/**
 * The field a question is about: a saved analysis if one is open or named,
 * otherwise the boundary currently drawn on screen.
 *
 * Someone who has just drawn a field and asks how big it is should get an
 * answer. Requiring them to create an analysis first would be the tool's
 * bookkeeping leaking into the conversation.
 */
async function resolveAoi(
  args: any, ctx: ToolContext,
): Promise<{ aoi: any; source: string }> {
  const given = typeof args?.workflow_id === "string" ? args.workflow_id.trim() : "";
  const id = (UUID.test(given) ? given : null) ?? ctx.workflowId;

  if (id) {
    const wf = await api.getWorkflow(id);
    if (wf.aoi) return { aoi: wf.aoi, source: "analysis" };
  }
  if (ctx.aoi) return { aoi: ctx.aoi, source: "the boundary on screen" };

  throw new Error(
    "No field to measure. Draw a boundary on the map, or open an existing " +
    "analysis from Workflows.",
  );
}

function targetId(args: any, ctx: ToolContext): string {
  const given = typeof args?.workflow_id === "string" ? args.workflow_id.trim() : "";
  const id = (UUID.test(given) ? given : null) ?? ctx.workflowId;
  if (!id) {
    throw new Error(
      "No analysis is selected. Open one from Workflows, or ask me to create one.",
    );
  }
  return id;
}

/**
 * The boundary of the analysis on screen.
 *
 * A page publishes its AOI into the assistant's context, but a detail page can
 * only do that once its query has resolved -- and "analyse this field" asked a
 * moment too early would otherwise be refused while the field is plainly
 * visible. Only ever the workflow already open, so this cannot widen what the
 * assistant acts on.
 */
async function openWorkflowAoi(ctx: ToolContext): Promise<Geometry | null> {
  if (!ctx.workflowId) return null;
  try {
    const wf = await api.getWorkflow(ctx.workflowId);
    const aoi = wf.aoi as Geometry | null;
    return aoi && (aoi as any).type ? aoi : null;
  } catch {
    return null;   // fall through to the "draw one" message below
  }
}

/** The newest run of a workflow, which is what "the results" always means. */
async function latestRun(workflowId: string): Promise<RunSummary | null> {
  const runs = await api.runs(workflowId);
  if (!runs.length) return null;
  return runs.toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/** The stats artifact a stress run produces, whatever the node chose to call it. */
function findStatsArtifact(artifacts: ArtifactOut[]): ArtifactOut | null {
  return (
    artifacts.find((a) => a.name === "stress_stats") ??
    artifacts.find((a) => a.kind === "json" && /stats/i.test(a.name)) ??
    artifacts.find((a) => a.kind === "json") ??
    null
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TOOLS: Tool[] = [
  {
    name: "list_workflows",
    description:
      "List the organisation's analyses, newest first, with their id, question and status.",
    parameters: NO_ARGS,
    run: async () => {
      const rows = await api.listWorkflows();
      return {
        data: rows.slice(0, 25).map((w) => ({
          id: w.id, query: w.query, status: w.status, created_at: w.created_at,
        })),
        summary: `${rows.length} ${rows.length === 1 ? "analysis" : "analyses"}`,
      };
    },
  },

  {
    name: "get_workflow",
    description:
      "Fetch one analysis: its question, area of interest, date range, planning status and the planned node graph.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Defaults to the analysis on screen." },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const wf = await api.getWorkflow(targetId(args, ctx));
      const nodes = Array.isArray((wf.graph as any)?.nodes) ? (wf.graph as any).nodes : [];
      return {
        data: {
          id: wf.id, query: wf.query, status: wf.status,
          date_range: wf.date_range, plan_error: wf.plan_error,
          nodes: nodes.map((n: any) => ({ id: n.id, type: n.type })),
        },
        summary: `${wf.status}${nodes.length ? ` · ${nodes.length} nodes` : ""}`,
      };
    },
  },

  {
    name: "create_analysis",
    description:
      "Create a new analysis from a question over the boundary currently on screen. The backend plans it into a node graph; this returns as soon as the row exists.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question in plain language." },
        start: { type: "string", description: "Start date, YYYY-MM-DD." },
        end: { type: "string", description: "End date, YYYY-MM-DD." },
      },
      required: ["question"],
    },
    mutating: true,
    run: async (args, ctx) => {
      const aoi = ctx.aoi ?? await openWorkflowAoi(ctx);
      if (!aoi) {
        throw new Error(
          "There is no field boundary to analyse. Draw one on the map first (New analysis → Draw boundary).",
        );
      }
      const range = {
        start: args.start || ctx.dateRange.start,
        end: args.end || ctx.dateRange.end,
      };
      const created = await api.createWorkflow(
        args.question ?? "Water stress over this field", aoi, range,
      );
      ctx.remember(created.workflow_id);
      ctx.report(`Created analysis ${created.workflow_id.slice(0, 8)} · planning…`);
      return {
        data: { workflow_id: created.workflow_id, status: created.status, date_range: range },
        summary: `created ${created.workflow_id.slice(0, 8)}`,
      };
    },
  },

  {
    name: "wait_for_plan",
    description:
      "Wait until the backend has finished planning an analysis into a node graph. Call this after create_analysis and before run_analysis.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        timeout_s: { type: "number", description: "Give up after this long. Default 90." },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const deadline = Date.now() + (args.timeout_s ?? 90) * 1000;
      let announced = false;
      while (Date.now() < deadline) {
        const wf = await api.getWorkflow(id);
        if (wf.status === "plan_failed") {
          throw new Error(`Planning failed: ${wf.plan_error ?? "no reason given"}`);
        }
        if (Array.isArray((wf.graph as any)?.nodes)) {
          const n = (wf.graph as any).nodes.length;
          return { data: { status: wf.status, nodes: n }, summary: `planned · ${n} nodes` };
        }
        if (!announced) {
          ctx.report("Planning the analysis…");
          announced = true;
        }
        // A hosted model plans in a few seconds, so poll often enough that the
        // result appears promptly rather than up to 2.5s after it is ready.
        await sleep(1000);
      }
      // Overwhelmingly the cause is that nothing is consuming the queue, which
      // looks identical to "slow" from here. Say so rather than suggest waiting.
      throw new Error(
        "Planning did not finish. The most likely reason is that no Celery " +
        "worker is running, so nothing picked up the job — start one with " +
        "`celery -A app.celery_app worker --pool=solo -l info` and try again.",
      );
    },
  },

  {
    name: "run_analysis",
    description: "Start a run of an already-planned analysis.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    mutating: true,
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const run: WorkflowRunOut = await api.runWorkflow(id);
      ctx.report(`Run started · ${run.nodes.length} nodes queued`);
      return {
        data: { run_id: run.id, status: run.status, nodes: run.nodes.length },
        summary: `run ${run.status}`,
      };
    },
  },

  {
    name: "check_run",
    description:
      "Current status of the newest run: overall state plus each node's state and error.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const st = await api.status(targetId(args, ctx));
      const done = st.nodes.filter((n) => n.status === "done").length;
      return {
        data: {
          status: st.status, error: st.error,
          progress: `${done}/${st.nodes.length}`,
          nodes: st.nodes.map((n) => ({
            id: n.node_id, type: n.node_type, status: n.status, error: n.error,
          })),
        },
        summary: `${st.status} · ${done}/${st.nodes.length}`,
      };
    },
  },

  {
    name: "wait_for_run",
    description:
      "Poll until the newest run finishes (done, failed or cancelled), reporting progress as it goes.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        timeout_s: { type: "number", description: "Give up after this long. Default 600." },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const deadline = Date.now() + (args.timeout_s ?? 600) * 1000;
      let last = "";
      while (Date.now() < deadline) {
        const st = await api.status(id);
        const done = st.nodes.filter((n) => n.status === "done").length;
        const line = `${st.status} · ${done}/${st.nodes.length} nodes`;
        if (line !== last) { ctx.report(line); last = line; }

        if (st.status === "done" || st.status === "failed" || st.status === "cancelled") {
          const failed = st.nodes.filter((n) => n.status === "failed");
          return {
            data: {
              status: st.status,
              error: st.error,
              failed_nodes: failed.map((n) => ({ id: n.node_id, type: n.node_type, error: n.error })),
            },
            summary: line,
          };
        }
        // A queued run with nothing started usually means no worker is consuming
        // the queue -- worth saying rather than spinning for ten minutes.
        if (st.status === "pending" && st.nodes.length === 0 && Date.now() > deadline - 570_000) {
          ctx.report("Still queued with no node started — is a Celery worker running?");
        }
        await sleep(2000);
      }
      throw new Error("The run is still going. I stopped waiting; ask me to check it again.");
    },
  },

  {
    name: "list_artifacts",
    description: "List the outputs the newest run produced: name, kind and node.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const run = await latestRun(id);
      if (!run) throw new Error("This analysis has not been run yet.");
      const arts = await api.artifacts(run.id);
      return {
        data: arts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, node: a.node_id })),
        summary: `${arts.length} artifacts`,
      };
    },
  },

  {
    name: "analyse_results",
    description:
      "Read the newest run's statistics and interpret them: stressed area, per-class breakdown, the indices behind the classification, caveats and what to do next. This is the main analysis tool.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const run = await latestRun(id);
      if (!run) throw new Error("This analysis has not been run yet — ask me to run it.");
      if (run.status === "failed") {
        const st = await api.status(id);
        const failed = st.nodes.filter((n) => n.status === "failed");
        throw new Error(
          `The run failed${failed.length ? `: ${failed[0].node_type} — ${failed[0].error}` : `: ${run.error ?? "no reason given"}`}`,
        );
      }

      const arts = await api.artifacts(run.id);
      const stats = findStatsArtifact(arts);
      if (!stats) {
        throw new Error(
          `The run produced ${arts.length} artifacts but no statistics JSON, so there is nothing to summarise. Outputs: ${arts.map((a) => a.name).join(", ") || "none"}.`,
        );
      }

      const payload = await api.artifactJson<StressStats>(stats.id);
      const report = analyseStress(payload);
      return {
        report,
        data: {
          artifact: stats.name,
          digest: statsDigest(payload),
          totals: report.totals,
          findings: report.findings.map((f) => f.text),
        },
        summary: `${report.totals.vegetatedHa.toFixed(1)} ha classified`,
      };
    },
  },

  {
    name: "compare_runs",
    description:
      "Compare the statistics of the two most recent completed runs of an analysis, to see whether stress grew or receded.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const runs = (await api.runs(id))
        .filter((r) => r.status === "done")
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (runs.length < 2) {
        throw new Error(`Only ${runs.length} completed run — there is nothing to compare against.`);
      }
      const read = async (r: RunSummary) => {
        const arts = await api.artifacts(r.id);
        const a = findStatsArtifact(arts);
        if (!a) throw new Error(`Run ${r.id.slice(0, 8)} has no statistics artifact.`);
        return analyseStress(await api.artifactJson<StressStats>(a.id));
      };
      const [now, before] = [await read(runs[0]), await read(runs[1])];
      const delta = now.totals.severeHa - before.totals.severeHa;
      return {
        data: {
          newest: { at: runs[0].created_at, ...now.totals },
          previous: { at: runs[1].created_at, ...before.totals },
          severe_change_ha: Number(delta.toFixed(2)),
          direction: delta > 0.1 ? "worsening" : delta < -0.1 ? "improving" : "unchanged",
        },
        summary: `severe ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} ha`,
      };
    },
  },

  {
    name: "list_node_types",
    description:
      "The catalogue of node types the planner can use, with their inputs and outputs. Use it to explain what the system can do.",
    parameters: NO_ARGS,
    run: async () => {
      const cat = await api.catalog();
      return {
        data: cat.map((n) => ({ type: n.type_name, description: n.description })),
        summary: `${cat.length} node types`,
      };
    },
  },

  {
    name: "control_map",
    description:
      "Change what the map shows: switch between the 2D map and the 3D globe, change the basemap, or fly to one of the user's own analysis areas. For a named place such as a city or region, use fly_to_place instead.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["2d", "3d"] },
        basemap: { type: "string", enum: ["light", "dark", "satellite"] },
        fly_to_workflow: {
          type: "string",
          description: "Workflow id whose area of interest the camera should fly to.",
        },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const did: string[] = [];
      if (args.mode) { sendMapCommand({ type: "mode", mode: args.mode }); did.push(args.mode.toUpperCase()); }
      if (args.basemap) { sendMapCommand({ type: "basemap", basemap: args.basemap }); did.push(args.basemap); }
      if (args.fly_to_workflow || (!args.mode && !args.basemap)) {
        const wf = await api.getWorkflow(args.fly_to_workflow ?? targetId(args, ctx));
        const b = boundsOf(wf.aoi);
        if (b) { sendMapCommand({ type: "flyTo", bounds: b }); did.push("flew to the field"); }
      }
      if (!did.length) throw new Error("Nothing to change — say 3D, satellite, or which field to fly to.");
      return { data: { applied: did }, summary: did.join(", ") };
    },
  },

  {
    name: "fly_to_place",
    description:
      "Move the map to a named place -- a city, district, region or country. "
      + "Use this for 'zoom to Konya', 'show me Punjab', 'go to Lahore': "
      + "anywhere that is not one of the user's own saved fields. Can also "
      + "switch the view mode or basemap in the same step.",
    parameters: {
      type: "object",
      properties: {
        place: {
          type: "string",
          description: "Place name, optionally with country, e.g. 'Konya, Turkey'.",
        },
        mode: { type: "string", enum: ["2d", "3d"] },
        basemap: { type: "string", enum: ["light", "dark", "satellite"] },
      },
      required: ["place"],
    },
    run: async (args) => {
      const place = await geocode(args.place);
      if (!place) {
        // A wrong guess would move the map somewhere plausible and silently
        // wrong, so an unknown name fails instead.
        throw new Error(
          `I could not find "${args.place}". Try adding the country, ` +
          `e.g. "Konya, Turkey".`,
        );
      }

      if (args.mode) sendMapCommand({ type: "mode", mode: args.mode });
      if (args.basemap) sendMapCommand({ type: "basemap", basemap: args.basemap });
      sendMapCommand({ type: "flyTo", bounds: place.bounds });

      return {
        data: {
          name: place.name,
          display_name: place.displayName,
          kind: place.kind,
          center: place.center,
          bounds: place.bounds,
        },
        summary: `flew to ${place.name}`,
      };
    },
  },

  {
    name: "measure_field",
    description:
      "Report the size of a field: area in hectares and acres, and perimeter. "
      + "Answers 'how big is this field?' without running any analysis. Works "
      + "on a boundary just drawn on the map as well as on a saved analysis.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const { aoi, source } = await resolveAoi(args, ctx);
      const m2 = areaM2(aoi);
      if (!m2) throw new Error("That boundary encloses no area.");

      const ha = m2 / 10_000;
      return {
        data: {
          area_hectares: Math.round(ha * 100) / 100,
          area_acres: Math.round(ha * 2.47105 * 100) / 100,
          area_m2: Math.round(m2),
          perimeter_m: Math.round(perimeterM(aoi)),
          measured: source,
        },
        summary: `${ha.toFixed(2)} ha`,
      };
    },
  },

  {
    name: "get_weather",
    description:
      "Current weather and a short forecast over a field or a named place, "
      + "including total forecast rainfall and reference evapotranspiration. "
      + "Answers 'what's the weather?', 'will it rain this week?', and is worth "
      + "checking before acting on an irrigation recommendation.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Use this analysis' field." },
        place: { type: "string", description: "Or a place name instead." },
        days: { type: "number", description: "Forecast length, 1-16. Default 7." },
      },
      required: [],
    },
    run: async (args, ctx) => {
      let lon: number, lat: number, where: string;

      if (args.place) {
        const p = await geocode(args.place);
        if (!p) throw new Error(`I could not find "${args.place}".`);
        [lon, lat] = p.center;
        where = p.name;
      } else {
        const { aoi } = await resolveAoi(args, ctx);
        const c = centroid(aoi);
        if (!c) throw new Error("That boundary has no usable coordinates.");
        [lon, lat] = c;
        where = "the field";
      }

      const days = Math.min(Math.max(Math.round(args.days ?? 7), 1), 16);
      const w = await weatherAt(lon, lat, days);

      return {
        data: { location: where, ...w },
        summary: `${w.temperature_c}°C · ${w.rain_total_mm} mm rain forecast over ${days} days`,
      };
    },
  },

  {
    name: "download_result",
    description:
      "Save an output of the latest run to the user's computer -- the stress "
      + "map, the statistics file, or any other artifact. Answers 'download "
      + "the results' or 'export the map'.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        name: {
          type: "string",
          description: "Artifact name, e.g. stress_class or stress_stats. "
            + "Omit to take the first output of the final node.",
        },
      },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      const runs = await api.runs(id);
      if (!runs.length) throw new Error("This analysis has not been run yet.");

      const artifacts = await api.artifacts(runs[0].id);
      if (!artifacts.length) throw new Error("That run produced no outputs.");

      const wanted = args.name
        ? artifacts.find((a) => a.name === args.name)
        : artifacts[artifacts.length - 1];
      if (!wanted) {
        throw new Error(
          `No output called "${args.name}". This run produced: ` +
          artifacts.map((a) => a.name).join(", "),
        );
      }

      // The download endpoint needs a bearer token, which an <a href> cannot
      // send -- so the bytes are fetched with auth and handed to the browser
      // as an object URL.
      const url = await api.artifactObjectUrl(wanted.id);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${wanted.name}${EXT[wanted.kind] ?? ""}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke late: revoking immediately can cancel the download in Firefox.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      return {
        data: { name: wanted.name, kind: wanted.kind },
        summary: `downloaded ${wanted.name}`,
      };
    },
  },

  {
    name: "open_analysis",
    description: "Navigate the app to an analysis' detail page.",
    parameters: {
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: [],
    },
    run: async (args, ctx) => {
      const id = targetId(args, ctx);
      ctx.navigate(`/w/${id}`);
      return { data: { opened: id }, summary: `opened ${id.slice(0, 8)}` };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The function-calling schema block, for an OpenAI-compatible endpoint. */
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}