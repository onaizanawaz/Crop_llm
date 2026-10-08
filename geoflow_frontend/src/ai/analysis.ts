/**
 * Reading a run's numbers, in words.
 *
 * This is deliberately deterministic and separate from the agent loop. The
 * agent decides *which* run to look at; what a stress_stats payload means is
 * not a judgement call, and an LLM paraphrasing percentages is exactly where
 * hallucinated numbers get into a report someone irrigates a field on. Every
 * figure below is read straight from the artifact, and every caveat is
 * triggered by a field in it -- never by inference.
 *
 * The LLM, when configured, is handed this output as source material rather
 * than being asked to compute it.
 */

import type { StressStats } from "../api/types";

export interface Finding {
  kind: "headline" | "class" | "band" | "caveat" | "recommendation";
  /** Severity drives the colour of the marker in the transcript. */
  tone: "good" | "warn" | "bad" | "neutral";
  text: string;
}

/** One classified band of the field, kept structured so a bar can be drawn. */
export interface ClassShare {
  key: string;
  label: string;
  areaHa: number;
  /** Share of vegetated area, 0-100. Derived here when the payload omits it. */
  pct: number;
  pixels: number;
  tone: Finding["tone"];
}

export interface StressReport {
  findings: Finding[];
  /** Markdown-ish plain text, for copying out or feeding to an LLM. */
  text: string;
  /** The same breakdown as the "class" findings, as numbers rather than prose. */
  classes: ClassShare[];
  totals: { vegetatedHa: number; severeHa: number; moderateHa: number; healthyHa: number };
}

/** The classifier's own class ids, in increasing severity. */
const ORDER = ["healthy", "mild", "moderate", "severe"] as const;

const TONE_OF: Record<string, Finding["tone"]> = {
  healthy: "good",
  mild: "good",
  moderate: "warn",
  severe: "bad",
};

/**
 * The payload is keyed by the backend's CLASS_LABELS *values*, which are
 * "healthy", "moderate_stress", "severe_stress" and "no_data_or_non_vegetated"
 * -- not the bare ids this module was matching on. Unrecognised keys therefore
 * scored as neutral with zero stressed area, so a field that was 38% stressed
 * reported "Largely healthy: 0.0 ha ... (0.0%)" with a grey, uncoloured bar.
 *
 * Both spellings are accepted: an artifact written by an older backend is
 * still readable, and a rename on either side degrades to "unknown class"
 * rather than to a confident wrong answer.
 */
const CANONICAL: Record<string, (typeof ORDER)[number]> = {
  healthy: "healthy", no_stress: "healthy", none: "healthy",
  mild: "mild", mild_stress: "mild", low: "mild",
  moderate: "moderate", moderate_stress: "moderate",
  severe: "severe", severe_stress: "severe",
};

/** Pixels that were never classified: real area, but not *vegetated* area. */
function isNonVegetated(key: string): boolean {
  return /no_data|non_vegetated|nodata|background|masked/i.test(key);
}

function canonicalKey(key: string): string {
  return CANONICAL[key.trim().toLowerCase()] ?? key;
}

/** "moderate_stress" -> "Moderate stress". Machine ids never reach the UI. */
function humanLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ha(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function pct(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;
}

/** Mean of a band's stat block, whatever the backend chose to call it. */
function meanOf(bands: StressStats["bands"], band: string): number | null {
  const b = bands?.[band];
  if (!b) return null;
  const v = b.mean ?? b.avg ?? b.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function analyseStress(s: StressStats): StressReport {
  const findings: Finding[] = [];

  // ---- areas, in the classifier's own class ids
  const classes = s.classes ?? {};

  /** Raw payload key -> canonical id, for every class that is vegetation. */
  const vegetated = new Map<string, string>();
  for (const raw of Object.keys(classes)) {
    if (isNonVegetated(raw)) continue;      // counted nowhere: see below
    vegetated.set(raw, canonicalKey(raw));
  }

  // Canonical order first so the breakdown always reads healthy -> severe,
  // then anything the registry has added since.
  const byCanon = (c: string) => [...vegetated].find(([, v]) => v === c)?.[0];
  const present = ORDER.map(byCanon).filter((k): k is string => !!k);
  const extras = [...vegetated.keys()].filter((k) => !present.includes(k));
  const keys = [...present, ...extras];

  const areaOf = (canon: string) => {
    const raw = byCanon(canon);
    return raw ? classes[raw]?.area_ha ?? 0 : 0;
  };
  const severeHa = areaOf("severe");
  const moderateHa = areaOf("moderate");
  const healthyHa = areaOf("healthy") + areaOf("mild");
  // Vegetated means vegetated: the no-data bucket is excluded, or the
  // denominator silently grew and every share was reported too small.
  const vegetatedHa = keys.reduce((sum, k) => sum + (classes[k]?.area_ha ?? 0), 0);

  const stressedHa = severeHa + moderateHa;
  const stressedPct = vegetatedHa > 0 ? (stressedHa / vegetatedHa) * 100 : null;

  // ---- headline: the one sentence someone reads if they read nothing else
  const headlineTone: Finding["tone"] =
    stressedPct == null ? "neutral"
      : stressedPct >= 40 ? "bad"
      : stressedPct >= 15 ? "warn"
      : "good";

  const headline =
    stressedPct == null
      ? "The run produced no vegetated area to classify — check the season and the boundary."
      : stressedPct >= 40
        ? `Widespread stress: ${ha(stressedHa)} ha of ${ha(vegetatedHa)} ha (${pct(stressedPct)} of vegetated area) is moderately or severely stressed.`
        : stressedPct >= 15
          ? `Localised stress: ${ha(stressedHa)} ha of ${ha(vegetatedHa)} ha (${pct(stressedPct)}) shows moderate or severe stress.`
          : `Largely healthy: only ${ha(stressedHa)} ha of ${ha(vegetatedHa)} ha (${pct(stressedPct)}) is stressed.`;

  findings.push({ kind: "headline", tone: headlineTone, text: headline });

  // ---- per-class breakdown
  const shares: ClassShare[] = [];
  for (const k of keys) {
    const c = classes[k];
    if (!c) continue;
    const canon = vegetated.get(k) ?? k;
    const label = humanLabel(k);
    const tone = TONE_OF[canon] ?? "neutral";
    const share =
      c.pct_of_vegetated ?? (vegetatedHa > 0 ? (c.area_ha / vegetatedHa) * 100 : 0);
    shares.push({
      key: k,
      label,
      areaHa: c.area_ha,
      // pct_of_vegetated is null when the backend could not compute it; the
      // areas are always present, so fall back to deriving the share.
      pct: share,
      pixels: c.pixels,
      tone,
    });
    findings.push({
      kind: "class",
      tone,
      text: `${label}: ${ha(c.area_ha)} ha · ${pct(share)} of vegetated · ${c.pixels.toLocaleString()} px`,
    });
  }

  // ---- the indices behind the classification
  const ndmi = meanOf(s.bands, "NDMI") ?? meanOf(s.bands, "ndmi");
  const ndvi = meanOf(s.bands, "NDVI") ?? meanOf(s.bands, "ndvi");
  const etRatio =
    meanOf(s.bands, "et_ratio") ?? meanOf(s.bands, "ETa_over_RET") ?? meanOf(s.bands, "eta_ret");

  if (ndvi != null) {
    findings.push({
      kind: "band",
      tone: ndvi < 0.3 ? "warn" : "neutral",
      text: `Mean NDVI ${ndvi.toFixed(3)} — ${ndvi < 0.2 ? "little green cover; the field may be bare or between crops" : ndvi < 0.4 ? "sparse or early-stage canopy" : "an established canopy"}.`,
    });
  }
  if (ndmi != null) {
    findings.push({
      kind: "band",
      tone: ndmi < 0.1 ? "bad" : ndmi < 0.2 ? "warn" : "good",
      text: `Mean NDMI ${ndmi.toFixed(3)} — canopy moisture is ${ndmi < 0.1 ? "low" : ndmi < 0.2 ? "moderate" : "adequate"} across the field.`,
    });
  }
  if (etRatio != null) {
    findings.push({
      kind: "band",
      tone: etRatio < 0.5 ? "bad" : etRatio < 0.75 ? "warn" : "good",
      text: `Mean ETa/RET ${etRatio.toFixed(2)} — the crop is meeting ${(etRatio * 100).toFixed(0)}% of reference demand${etRatio < 0.75 ? ", i.e. transpiration is being limited" : ""}.`,
    });
  }

  // ---- caveats, each triggered by a field rather than by inference
  if (s.mode_used === "ndmi" && s.mode_requested !== "ndmi") {
    findings.push({
      kind: "caveat",
      tone: "warn",
      text: `Requested "${s.mode_requested}" but fell back to NDMI alone: no usable evapotranspiration data for this area and season. The classes describe canopy moisture, not a water balance.`,
    });
  }
  if (s.sources && s.sources.has_ret === false) {
    findings.push({
      kind: "caveat",
      tone: "warn",
      text: "No reference evapotranspiration (RET) source was available, so ETa could not be normalised against demand.",
    });
  }
  const scale = s.grid?.analysis_scale_m;
  if (scale) {
    const et = s.grid.et_native_scale_m;
    findings.push({
      kind: "caveat",
      tone: "neutral",
      text: et && et > scale
        ? `Analysed at ${scale} m, but evapotranspiration is native to ${et} m — ET-driven classes are resampled and cannot resolve patches smaller than about ${et} m.`
        : `Analysed on a ${scale} m grid (${s.grid.pixel_area_m2} m² per pixel).`,
    });
  }
  if (vegetatedHa > 0 && vegetatedHa < 1) {
    findings.push({
      kind: "caveat",
      tone: "warn",
      text: `Only ${ha(vegetatedHa)} ha classified — that is a handful of pixels, so the percentages are volatile.`,
    });
  }

  // ---- what to do about it
  if (severeHa > 0) {
    findings.push({
      kind: "recommendation",
      tone: "bad",
      text: `Inspect the ${ha(severeHa)} ha in the severe class first — at this level the deficit is usually visible on the ground.`,
    });
  }
  if (stressedPct != null && stressedPct >= 15 && stressedPct < 40) {
    findings.push({
      kind: "recommendation",
      tone: "warn",
      text: "Stress is patchy rather than field-wide, which points at irrigation uniformity — check emitter/furrow coverage over the affected patches before changing the whole schedule.",
    });
  }
  if (stressedPct != null && stressedPct >= 40) {
    findings.push({
      kind: "recommendation",
      tone: "bad",
      text: "Stress covers most of the field, which points at the schedule or supply rather than uniformity — review irrigation depth and interval for this growth stage.",
    });
  }
  if (stressedPct != null && stressedPct < 15) {
    findings.push({
      kind: "recommendation",
      tone: "good",
      text: "No action indicated from this run. Re-run against a later window to catch stress as it develops.",
    });
  }

  return {
    findings,
    text: findings.map((f) => `- ${f.text}`).join("\n"),
    classes: shares,
    totals: { vegetatedHa, severeHa, moderateHa, healthyHa },
  };
}

/** A compact preamble the LLM gets alongside the findings, for context. */
export function statsDigest(s: StressStats): string {
  return [
    `mode_used=${s.mode_used} (requested ${s.mode_requested})`,
    `thresholds=${JSON.stringify(s.thresholds)}`,
    `grid=${s.grid?.analysis_scale_m}m`,
    `aeti=${s.sources?.aeti_collection ?? "none"}`,
    `ret=${s.sources?.ret_collection ?? "none"}`,
  ].join(" · ");
}