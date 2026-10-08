/**
 * Mirrors the FastAPI schemas exactly. Regenerate by hand from
 * http://localhost:8000/openapi.json when the backend contract changes --
 * these names match the Python models one-for-one on purpose.
 */

import type { Geometry } from "geojson";

export interface TokenOut {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface UserOut {
  id: string;
  email: string;
  role: "owner" | "member";
  org_id: string;
  org_name: string;
}

export interface NodeSpec {
  id: string;
  type: string;
  params: Record<string, unknown>;
  inputs: string[];
  outputs: string[];
}

export interface Edge {
  source: string;
  target: string;
  source_output: string | null;
  target_input: string | null;
}

export interface WorkflowGraph {
  workflow_id: string;
  nodes: NodeSpec[];
  edges: Edge[];
  /** "llm" | "static" | "static_fallback" | "dummy" -- which planner ran. */
  planner?: string;
  /** Model name for "llm"; the failure reason for "static_fallback". */
  planner_detail?: string | null;
}

/** The five states a node can be in. "skipped" means an upstream node failed. */
export type NodeStatus =
  | "pending" | "queued" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface NodeRunStatus {
  node_id: string;
  node_type: string;
  status: NodeStatus;
  output_ref: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface WorkflowRunOut {
  id: string;
  workflow_id: string;
  status: RunStatus;
  error: string | null;
  nodes: NodeRunStatus[];
}

export interface WorkflowSummary {
  id: string;
  query: string;
  status: string;
  created_at: string;
}

/** POST /workflows/ answers before the graph exists; planning runs in a worker. */
export interface WorkflowCreated {
  workflow_id: string;
  status: string;
}

export interface WorkflowDetail {
  id: string;
  query: string;
  aoi: Geometry | Record<string, unknown>;
  date_range: { start: string; end: string };
  /** Empty object until planning finishes. */
  graph: WorkflowGraph | Record<string, never>;
  status: string;
  /** Set only when status is "plan_failed". */
  plan_error: string | null;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface ArtifactOut {
  id: string;
  node_id: string;
  name: string;
  kind: "raster" | "json" | "scalar" | "vector" | "table" | "ee_object";
  uri: string;
  meta: Record<string, any>;
}

export interface NodeCatalogOut {
  type_name: string;
  description: string;
  input_schema: Record<string, string>;
  output_schema: Record<string, string>;
  param_schema: Record<string, string>;
}

/** The JSON payload of the stress_stats artifact. */
export interface StressStats {
  mode_requested: string;
  mode_used: "combined" | "ndmi";
  class_labels: Record<string, string>;
  classes: Record<string, { pixels: number; area_ha: number; pct_of_vegetated: number | null }>;
  thresholds: Record<string, number>;
  bands: Record<string, Record<string, number>>;
  grid: {
    analysis_scale_m: number;
    pixel_area_m2: number;
    et_native_scale_m: number | null;
    ndmi_native_scale_m: number | null;
  };
  sources: { aeti_collection: string | null; ret_collection: string | null; has_ret: boolean };
}