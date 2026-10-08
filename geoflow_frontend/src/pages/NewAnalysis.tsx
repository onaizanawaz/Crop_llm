import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { usePublishContext } from "../ai/AssistantContext";
import { api } from "../api/client";
import MapView from "../components/MapView";
import type { Polygon } from "geojson";

/** A sensible season rather than today's date, which usually has no imagery yet. */
const DEFAULT_RANGE = { start: "2024-06-01", end: "2024-09-30" };

/** The sidebar reads as three ordered steps; the number is the only ornament. */
function Step({ n, label, done, children }: {
  n: number;
  label: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="step">
      <div className="step-head">
        {/* The numeral is wayfinding for the eye; "1" read aloud before every
            label is just noise, and "done" is said in words instead. */}
        <span className="step-n" data-done={!!done} aria-hidden="true">{done ? "✓" : n}</span>
        <span className="step-label">{label}</span>
        {done && <span className="sr-label">(done)</span>}
      </div>
      <div className="step-body">{children}</div>
    </section>
  );
}

export default function NewAnalysis() {
  const nav = useNavigate();
  const qc = useQueryClient();

  const [query, setQuery] = useState("Is my field under water stress this season?");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [aoi, setAoi] = useState<Polygon | null>(null);
  const [drawing, setDrawing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The assistant needs the boundary and season to act on "this field".
  usePublishContext(aoi, range);

  async function submit() {
    if (!aoi) { setError("Draw a field boundary first."); return; }
    setError(null);
    setBusy(true);
    try {
      const created = await api.createWorkflow(query, aoi, range);
      await qc.invalidateQueries({ queryKey: ["workflows"] });
      nav(`/w/${created.workflow_id}`);
    } catch (err: any) {
      setError(err?.message ?? "Could not create the analysis.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="split">
      <aside className="side">
        <div className="side-head">
          <p className="eyebrow">Set up</p>
          <h1 className="title compact">New analysis</h1>
          <p className="lede" style={{ fontSize: 13.5 }}>
            Draw the field, choose the season, then review the plan before running.
          </p>
        </div>

        <div className="side-scroll">
          <Step n={1} label="Question">
            <div className="field">
              <label htmlFor="q" className="sr-label">Question</label>
              <textarea id="q" value={query} onChange={(e) => setQuery(e.target.value)} />
              <span className="hint">
                Your question is planned into a workflow by a local model
                (<code className="mono">PLANNER_MODE=llm</code>). Planning runs on
                CPU and can take a minute before the analysis appears.
              </span>
            </div>
          </Step>

          <Step n={2} label="Season">
            <div className="date-row">
              <div className="field">
                <label htmlFor="from">From</label>
                <input id="from" type="date" value={range.start}
                       onChange={(e) => setRange({ ...range, start: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="to">To</label>
                <input id="to" type="date" value={range.end}
                       onChange={(e) => setRange({ ...range, end: e.target.value })} />
              </div>
            </div>
            <span className="hint" style={{ display: "block", marginTop: 8 }}>
              WaPOR evapotranspiration starts 1 Jan 2018 and is dekadal, so ranges
              shorter than about ten days can return nothing.
            </span>
          </Step>

          <Step n={3} label="Field boundary" done={!!aoi}>
            {aoi ? (
              <div className="aoi-ok">
                <span className="aoi-tick" aria-hidden="true">✓</span>
                <span style={{ flex: 1 }}>
                  Boundary set · {aoi.coordinates[0].length - 1} corners
                </span>
                <button className="btn quiet sm"
                        onClick={() => { setAoi(null); setDrawing(true); }}>
                  Redraw
                </button>
              </div>
            ) : (
              <button className="btn ghost block" onClick={() => setDrawing(true)}
                      disabled={drawing}>
                {drawing ? "Click corners on the map…" : "Draw boundary"}
              </button>
            )}
          </Step>
        </div>

        <div className="side-foot">
          {error && <div className="error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn block" onClick={submit} disabled={busy || !aoi}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Planning…" : "Create analysis"}
          </button>
        </div>
      </aside>

      <div className="split-main">
        <MapView
          aoi={aoi}
          drawing={drawing}
          onDrawComplete={(poly) => { setAoi(poly); setDrawing(false); }}
        />
      </div>
    </div>
  );
}