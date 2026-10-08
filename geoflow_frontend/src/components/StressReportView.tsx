/**
 * A run's findings, rendered.
 *
 * Shared by the assistant transcript and the analysis page so a result reads
 * identically wherever it is met -- the same headline, the same bar, the same
 * caveats in the same order.
 *
 * The breakdown leads with a proportional bar because the question people
 * actually ask is "how much of my field is in trouble", and a bar answers that
 * before any number is read. Severity is never carried by colour alone: every
 * band is also named, ordered worst-to-best in the legend, and quantified.
 */

import type { ClassShare, Finding, StressReport } from "../ai/analysis";

/** Fills come from the classifier's own triad; type uses the AA-safe twins. */
const FILL: Record<Finding["tone"], string> = {
  good: "var(--healthy)",
  warn: "var(--moderate)",
  bad: "var(--severe)",
  neutral: "var(--ink-3)",
};

const INK: Record<Finding["tone"], string> = {
  good: "var(--healthy-ink)",
  warn: "var(--moderate-ink)",
  bad: "var(--severe-ink)",
  neutral: "var(--ink-3)",
};

function StressBar({ classes }: { classes: ClassShare[] }) {
  const total = classes.reduce((sum, c) => sum + c.pct, 0);
  if (!classes.length || total <= 0) return null;

  // Worst first: the severe sliver is the thing worth finding, so it should
  // not be hidden at the tail of the bar.
  const ordered = [...classes].reverse();

  return (
    <div className="stress-bar-wrap">
      <div
        className="stress-bar"
        role="img"
        aria-label={ordered
          .map((c) => `${c.label} ${c.pct.toFixed(1)} percent`)
          .join(", ")}
      >
        {ordered.map((c) => (
          <span
            key={c.key}
            className="stress-seg"
            style={{ width: `${(c.pct / total) * 100}%`, background: FILL[c.tone] }}
            title={`${c.label} — ${c.pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="stress-legend">
        {ordered.map((c) => (
          <li key={c.key}>
            <span className="stress-dot" style={{ background: FILL[c.tone] }} aria-hidden="true" />
            <span className="stress-legend-label">{c.label}</span>
            <span className="stress-legend-num mono num" style={{ color: INK[c.tone] }}>
              {c.pct.toFixed(1)}%
            </span>
            <span className="stress-legend-area mono num">{c.areaHa.toFixed(1)} ha</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StressReportView({
  report, className = "",
}: {
  report: StressReport;
  className?: string;
}) {
  const by = (kind: Finding["kind"]) => report.findings.filter((f) => f.kind === kind);
  const headline = by("headline")[0];

  const groups: [string, Finding[]][] = [
    ["Indices", by("band")],
    ["Caveats", by("caveat")],
    ["What to do", by("recommendation")],
  ];

  return (
    <div className={`report ${className}`}>
      {headline && (
        <p className="report-headline" style={{ borderLeftColor: FILL[headline.tone] }}>
          {headline.text}
        </p>
      )}

      {report.classes.length > 0 && (
        <section className="report-group">
          <h4 className="report-label mono">Breakdown of vegetated area</h4>
          <StressBar classes={report.classes} />
        </section>
      )}

      {groups.map(([label, items]) =>
        items.length ? (
          <section key={label} className="report-group">
            <h4 className="report-label mono">{label}</h4>
            {items.map((f, i) => (
              <div key={i} className="report-line">
                <span className="report-mark" style={{ background: FILL[f.tone] }} aria-hidden="true" />
                <span>{f.text}</span>
              </div>
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}