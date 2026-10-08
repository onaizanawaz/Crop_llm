import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api } from "../api/client";

/**
 * Recent work reads better relatively ("20 min ago" answers "is this the one I
 * just started?" immediately); anything older than a month gets a real date,
 * where the exact day matters more than the arithmetic.
 */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined,
    { day: "numeric", month: "short", year: "numeric" });
}

/** The full timestamp stays available on hover and to screen readers. */
function exact(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/**
 * Placeholder rows at the real row height, so the list does not jump.
 *
 * Shape is for the eye only -- a screen reader is told "Loading analyses"
 * once and spared three rows of meaningless boxes.
 */
function SkeletonRows() {
  return (
    <div className="card list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="row" style={{ pointerEvents: "none" }}>
          <div className="row-main">
            <div className="skeleton" style={{ height: 13, width: `${58 - i * 9}%` }} />
            <div className="skeleton" style={{ height: 10, width: 110, marginTop: 7 }} />
          </div>
          <div className="skeleton" style={{ height: 16, width: 54 }} />
        </div>
      ))}
    </div>
  );
}

export default function Workflows() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["workflows"],
    queryFn: api.listWorkflows,
  });

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Organisation</p>
          <h1 className="title">Workflows</h1>
          <p className="lede">
            Analyses for your organisation, newest first.
            {data && data.length > 0 && (
              <> <span className="mono num">{data.length}</span> in total.</>
            )}
          </p>
        </div>
        <Link to="/new" className="btn">New analysis</Link>
      </div>

      {isLoading && (
        <>
          <span className="sr-label" role="status">Loading analyses…</span>
          <SkeletonRows />
        </>
      )}
      {error && <div className="error" role="alert">{(error as Error).message}</div>}

      {data && data.length === 0 && (
        <div className="card empty">
          <p className="empty-title">No analyses yet</p>
          <p className="empty-text">
            Draw a field boundary, pick a season, and ask a question in plain
            language — GeoFlow plans the pipeline and reports what it finds.
          </p>
          <Link to="/new" className="btn">New analysis</Link>
        </div>
      )}

      {data && data.length > 0 && (
        <>
          <div className="card list">
            {data.map((w) => (
              <Link key={w.id} to={`/w/${w.id}`} className="row">
                <div className="row-main">
                  {/* Two lines, then ellipsis: a question is the row's identity,
                      and a single truncated line often cut it mid-clause. */}
                  <div className="row-title clamp-2">{w.query}</div>
                  <div className="row-sub">
                    <time dateTime={w.created_at} title={exact(w.created_at)}>
                      {when(w.created_at)}
                    </time>
                  </div>
                </div>
                <span className={`pill dot ${w.status}`}>{w.status}</span>
                <svg className="row-go" width="14" height="14" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}