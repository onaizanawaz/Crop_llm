import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

import { usePublishContext } from "../ai/AssistantContext";
import { analyseStress } from "../ai/analysis";
import { api } from "../api/client";
import type { ArtifactOut, NodeRunStatus, StressStats, WorkflowGraph } from "../api/types";
import MapView from "../components/MapView";
import StressReportView from "../components/StressReportView";
import type { Geometry } from "geojson";

/** Longest-path depth, mirroring the backend's waves(): a node waits for its
 *  slowest ancestor, so shortest-path columns would misrepresent the order. */
function columns(graph: WorkflowGraph): string[][] {
  const preds = new Map<string, string[]>();
  graph.nodes.forEach((n) => preds.set(n.id, []));
  graph.edges.forEach((e) => preds.get(e.target)?.push(e.source));

  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;                 // cycle guard; server rejects these
    seen.add(id);
    const p = preds.get(id) ?? [];
    const d = p.length ? 1 + Math.max(...p.map((x) => visit(x, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  graph.nodes.forEach((n) => visit(n.id, new Set()));

  const max = Math.max(0, ...depth.values());
  const cols: string[][] = Array.from({ length: max + 1 }, () => []);
  graph.nodes.forEach((n) => cols[depth.get(n.id) ?? 0].push(n.id));
  return cols;
}

const ACTIVE = new Set(["pending", "running"]);

/** "4 minutes ago" reads faster than a timestamp for anything recent. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function duration(startIso: string, endIso: string): string {
  const secs = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/** The graph is `{}` until the planner worker finishes, so presence of the
 *  node list -- not truthiness -- is what says a pipeline can be drawn. */
function isPlanned(g: WorkflowGraph | Record<string, never> | undefined): g is WorkflowGraph {
  return Array.isArray((g as WorkflowGraph | undefined)?.nodes);
}

export default function WorkflowDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [runError, setRunError] = useState<string | null>(null);

  const wf = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.getWorkflow(id),
    // The planner runs in a worker and answers on this same route, so the
    // page follows it until the graph lands and then stops asking.
    refetchInterval: (q) => (q.state.data?.status === "planning" ? 2500 : false),
  });

  const status = useQuery({
    queryKey: ["status", id],
    queryFn: () => api.status(id),
    retry: false,
    // Poll only while something is actually happening; a finished run is
    // immutable, so continuing to poll it just burns requests.
    refetchInterval: (q) =>
      q.state.data && ACTIVE.has(q.state.data.status) ? 2000 : false,
  });

  const run = useMutation({
    mutationFn: () => api.runWorkflow(id),
    onSuccess: () => {
      setRunError(null);
      qc.invalidateQueries({ queryKey: ["status", id] });
      qc.invalidateQueries({ queryKey: ["workflow", id] });
    },
    onError: (e: any) => setRunError(e?.message ?? "Could not start the run."),
  });

  // Publishes this analysis' boundary, so the assistant can fly to it or reuse
  // it for a follow-up run without the user redrawing anything.
  usePublishContext((wf.data?.aoi as Geometry) ?? null, wf.data?.date_range);

  /**
   * The results chain: newest run -> its artifacts -> the statistics payload.
   *
   * Until now this page could show a pipeline finishing and still never show
   * what it found; the numbers existed only behind the assistant. Each step is
   * a separate query so a missing artifact degrades to "no results yet"
   * instead of an error, and each waits on the previous one's data.
   */
  const runs = useQuery({
    queryKey: ["runs", id],
    queryFn: () => api.runs(id),
    retry: false,
    // Reads the status query rather than the `active` const below it, which is
    // declared further down this component.
    refetchInterval: () =>
      status.data && ACTIVE.has(status.data.status) ? 4000 : false,
  });

  const latestRun = useMemo(() => {
    const rows = runs.data ?? [];
    if (!rows.length) return null;
    return rows.toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0];
  }, [runs.data]);

  const artifacts = useQuery({
    queryKey: ["artifacts", latestRun?.id],
    queryFn: () => api.artifacts(latestRun!.id),
    enabled: !!latestRun,
    retry: false,
  });

  const statsArtifact = useMemo<ArtifactOut | null>(() => {
    const rows = artifacts.data ?? [];
    return (
      rows.find((a) => a.name === "stress_stats") ??
      rows.find((a) => a.kind === "json" && /stats/i.test(a.name)) ??
      rows.find((a) => a.kind === "json") ??
      null
    );
  }, [artifacts.data]);

  const stats = useQuery({
    queryKey: ["stats", statsArtifact?.id],
    queryFn: () => api.artifactJson<StressStats>(statsArtifact!.id),
    enabled: !!statsArtifact,
    retry: false,
    staleTime: Infinity,          // a finished run's artifact never changes
  });

  const report = useMemo(
    () => (stats.data ? analyseStress(stats.data) : null),
    [stats.data],
  );

  const graph = wf.data?.graph;
  const planned = isPlanned(graph);
  const cols = useMemo(() => (isPlanned(graph) ? columns(graph) : []), [graph]);

  const byNode = new Map<string, NodeRunStatus>();
  status.data?.nodes.forEach((n) => byNode.set(n.node_id, n));

  // The same shape for the specs. Drawing the waves used to call
  // graph.nodes.find() once per node, which is a quadratic scan of the graph
  // on every poll; built once, each lookup is constant.
  const specById = useMemo(() => {
    const m = new Map<string, WorkflowGraph["nodes"][number]>();
    if (isPlanned(graph)) graph.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph]);

  const active = status.data && ACTIVE.has(status.data.status);
  const stalled =
    status.data?.status === "pending" && (status.data?.nodes.length ?? 0) === 0;

  // Progress is derived from what the poll already returns -- no extra request.
  const total = planned ? graph.nodes.length : 0;
  const finished = status.data?.nodes.filter((n) => n.status === "done").length ?? 0;

  if (wf.isLoading) {
    return (
      <div className="page">
        <span className="sr-label" role="status">Loading this analysis…</span>
        <div className="skeleton" aria-hidden="true" style={{ height: 26, width: "46%" }} />
        <div className="skeleton" aria-hidden="true" style={{ height: 12, width: 210, marginTop: 10 }} />
        <div className="skeleton" aria-hidden="true" style={{ height: 260, marginTop: 26 }} />
      </div>
    );
  }
  if (wf.error) {
    return <div className="page"><div className="error" role="alert">{(wf.error as Error).message}</div></div>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Analysis</p>
          <h1 className="title compact">{wf.data!.query}</h1>
          <p className="meta">
            <span>{wf.data!.date_range.start} → {wf.data!.date_range.end}</span>
            {planned && (
              <>
                <span className="sep">·</span>
                <span>{total} nodes</span>
                {graph.planner === "llm" && graph.planner_detail ? (
                  <>
                    <span className="sep">·</span>
                    <span>planned by {graph.planner_detail}</span>
                  </>
                ) : null}
              </>
            )}
            <span className="sep">·</span>
            <span className={`pill dot ${status.data?.status ?? wf.data!.status}`}>
              {status.data?.status ?? wf.data!.status}
            </span>
          </p>
        </div>
        <button className="btn" onClick={() => run.mutate()}
                disabled={run.isPending || active || !planned}>
          {(active || run.isPending) && <span className="spinner" aria-hidden="true" />}
          {active ? "Running…" : run.isPending ? "Starting…" : "Run analysis"}
        </button>
      </div>

      {runError && <div className="error" role="alert" style={{ marginBottom: 18 }}>{runError}</div>}

      {planned && graph.planner === "static_fallback" && (
        <div className="card" role="status" style={{
          marginBottom: 18, padding: "13px 15px",
          borderLeft: "3px solid var(--moderate)",
        }}>
          <strong style={{ fontWeight: 500 }}>
            This was not planned from your question.
          </strong>
          <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--ink-2)" }}>
            The language model could not produce a usable workflow, so the
            standard water-stress analysis ran instead. The result is valid, but
            it does not answer what you asked.
            {graph.planner_detail ? (
              <> Reason: <code className="mono">{graph.planner_detail}</code></>
            ) : null}
          </p>
        </div>
      )}

      {stalled && (
        <div className="error" role="alert" style={{ marginBottom: 18 }}>
          The run was queued but no node has started. That usually means no Celery
          worker is consuming the queue — start one with{" "}
          <code className="mono">celery -A app.celery_app worker --pool=solo -l info</code>.
        </div>
      )}

      {active && total > 0 && (
        <div className="progress" style={{ marginBottom: 18 }}>
          {/* The bar is the picture; the role and values are what a screen
              reader reads out as nodes finish. */}
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={finished}
            aria-valuetext={`${finished} of ${total} nodes done`}
            aria-label="Run progress"
          >
            <span style={{ width: `${Math.round((finished / total) * 100)}%` }} />
          </div>
          <span className="progress-text mono num">{finished}/{total} done</span>
        </div>
      )}

      <div className="detail-grid">
        {/* A locator map: it answers "which field is this", nothing more.
            2D by default -- an oblique globe adds nothing at 240px, and this
            way the page does not pull in several MB of engine to show it.
            The 3D switch is still there for anyone who wants the terrain. */}
        <div className="card map-card">
          <MapView aoi={(wf.data!.aoi as Geometry) ?? null} height="100%"
                   defaultBasemap="satellite"
                   defaultMode="2d" showBasemapSwitcher={false} />
        </div>

        <div className="card run-facts">
          <h3 className="report-label mono">This run</h3>
          <dl className="facts">
            <div><dt>Season</dt><dd className="mono num">{wf.data!.date_range.start} → {wf.data!.date_range.end}</dd></div>
            <div><dt>Nodes</dt><dd className="mono num">{total || "—"}</dd></div>
            <div><dt>Runs</dt><dd className="mono num">{runs.data?.length ?? "—"}</dd></div>
            <div>
              <dt>Last run</dt>
              <dd className="mono">{latestRun ? relative(latestRun.created_at) : "never"}</dd>
            </div>
            {latestRun?.started_at && latestRun?.finished_at && (
              <div>
                <dt>Took</dt>
                <dd className="mono num">{duration(latestRun.started_at, latestRun.finished_at)}</dd>
              </div>
            )}
            {artifacts.data && artifacts.data.length > 0 && (
              <div>
                <dt>Outputs</dt>
                <dd className="mono num">{artifacts.data.length}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Results come before the pipeline: the pipeline is how it was done,
          the results are what was asked. */}
      <section className="results-section">
        <h2 className="subhead">Results</h2>
        {report ? (
          <>
            <p className="lede" style={{ fontSize: 13.5, marginBottom: 14 }}>
              From <span className="mono">{statsArtifact?.name}</span>
              {latestRun ? <> · run {relative(latestRun.created_at)}</> : null}
            </p>
            <StressReportView report={report} className="card" />
          </>
        ) : stats.isLoading || artifacts.isLoading ? (
          <div className="card" style={{ padding: 18 }}>
            <div className="skeleton" style={{ height: 13, width: "60%" }} />
            <div className="skeleton" style={{ height: 30, width: "100%", marginTop: 14 }} />
            <div className="skeleton" style={{ height: 13, width: "40%", marginTop: 14 }} />
          </div>
        ) : (
          <div className="card empty">
            <p className="empty-title">
              {active ? "The run is still going" : latestRun ? "No statistics in this run" : "Not run yet"}
            </p>
            <p className="empty-text">
              {active
                ? "Findings appear here as soon as the classifier finishes."
                : latestRun
                  ? "This run produced no statistics artifact, so there is nothing to summarise. The pipeline below shows which node stopped."
                  : "Run the analysis and the stressed area, the indices behind it and what to do next will be summarised here."}
            </p>
          </div>
        )}
      </section>

      <section>
        <h2 className="subhead">Pipeline</h2>
        <p className="lede" style={{ fontSize: 13.5, marginBottom: 14 }}>
          Nodes in the same column have no dependency on each other.
        </p>

        {wf.data!.status === "plan_failed" && (
          <div className="error" role="alert">
            Planning failed. {wf.data!.plan_error}
          </div>
        )}

        {!planned && wf.data!.status !== "plan_failed" && (
          <div className="card empty">
            <span className="spinner" aria-hidden="true"
                  style={{ color: "var(--accent)", margin: "0 auto 12px" }} />
            <p className="empty-title">Planning the workflow</p>
            <p className="empty-text">
              A local model is turning your question into a pipeline. This runs on
              CPU and can take a minute — the page updates itself when it lands.
            </p>
            <button className="btn quiet sm" onClick={() => wf.refetch()}>
              Check now
            </button>
          </div>
        )}

        <div style={{ overflowX: "auto", paddingBottom: 6 }}>
          <div className="waves">
            {cols.map((col, i) => (
              <div key={i} className="wave">
                <div className="wave-label">Wave {i + 1}</div>
                {col.map((nodeId) => {
                  const spec = specById.get(nodeId)!;
                  const st = byNode.get(nodeId);
                  const state = st?.status ?? "pending";
                  return (
                    <div key={nodeId} className={`card node ${state}`}>
                      <div className="node-head">
                        <span className="node-id">{nodeId}</span>
                        <span className={`pill ${state}`}>{state}</span>
                      </div>
                      <div className="node-type">{spec.type}</div>
                      {st?.error && <div className="node-err">{st.error}</div>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}