/**
 * The single place a request is made.
 *
 * Every route except /healthz and /catalog needs `Authorization: Bearer`, so
 * attaching it here means no component ever handles auth. A 401 clears the
 * session and notifies the app once, rather than each caller deciding what a
 * 401 means.
 */

import type {
  ArtifactOut, NodeCatalogOut, RunSummary, TokenOut, UserOut,
  WorkflowCreated, WorkflowDetail, WorkflowRunOut, WorkflowSummary,
} from "./types";

/** Vite proxies /api to the backend in dev; see vite.config.ts. */
const BASE = import.meta.env.VITE_API_BASE ?? "/api";

const TOKEN_KEY = "geoflow.token";

export const tokenStore = {
  get: (): string | null => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

/** Broadcast so AuthProvider can drop the session without a circular import. */
export const AUTH_EXPIRED = "geoflow:auth-expired";

export class ApiError extends Error {
  // Declared as fields rather than constructor parameter properties: the
  // project builds with erasableSyntaxOnly, which forbids the shorthand.
  status: number;
  detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** FastAPI puts a string in `detail` for HTTPException and a list for 422. */
function readDetail(body: any, fallback: string): string {
  if (!body) return fallback;
  const d = body.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((e: any) => (e.msg ? `${(e.loc ?? []).slice(1).join(".")}: ${e.msg}` : e.message))
      .filter(Boolean)
      .join("; ") || fallback;
  }
  return fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "Cannot reach the API. Is the backend running on port 8000?");
  }

  // A 401 from login/register means bad credentials, not an expired session,
  // so it falls through and shows the backend's own detail instead.
  const isCredentialCheck = path === "/auth/login" || path === "/auth/register";
  if (res.status === 401 && !isCredentialCheck) {
    tokenStore.clear();
    window.dispatchEvent(new Event(AUTH_EXPIRED));
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, readDetail(body, `Request failed (${res.status})`), body);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const api = {
  // ---- auth
  register: (email: string, password: string, org_name: string) =>
    post<TokenOut>("/auth/register", { email, password, org_name }),
  login: (email: string, password: string) =>
    post<TokenOut>("/auth/login", { email, password }),
  me: () => request<UserOut>("/auth/me"),
  invite: (email: string, password: string, role: "owner" | "member") =>
    post<UserOut>("/auth/invite", { email, password, role }),

  // ---- catalog
  catalog: () => request<NodeCatalogOut[]>("/catalog"),

  // ---- workflows
  listWorkflows: () => request<WorkflowSummary[]>("/workflows/"),
  createWorkflow: (query: string, aoi: unknown, date_range: { start: string; end: string }) =>
    // Returns as soon as the row exists. The graph is planned by a worker;
    // poll getWorkflow() until status leaves "planning".
    post<WorkflowCreated>("/workflows/", { query, aoi, date_range }),
  getWorkflow: (id: string) => request<WorkflowDetail>(`/workflows/${id}`),
  runWorkflow: (id: string) => post<WorkflowRunOut>(`/workflows/${id}/run`),
  status: (id: string) => request<WorkflowRunOut>(`/workflows/${id}/status`),
  runs: (id: string) => request<RunSummary[]>(`/workflows/${id}/runs`),

  // ---- artifacts
  artifacts: (runId: string) => request<ArtifactOut[]>(`/runs/${runId}/artifacts`),
  artifact: (id: string) => request<ArtifactOut>(`/artifacts/${id}`),

  /**
   * Artifact bytes as a blob URL.
   *
   * Map layers and <img> cannot send an Authorization header, so the fetch
   * happens here and the caller gets an object URL instead of a route.
   * Callers must revokeObjectURL when done.
   */
  artifactObjectUrl: async (id: string): Promise<string> => {
    const res = await fetch(`${BASE}/artifacts/${id}/download`, {
      headers: { Authorization: `Bearer ${tokenStore.get() ?? ""}` },
    });
    if (!res.ok) throw new ApiError(res.status, `Could not load artifact (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },

  artifactJson: async <T>(id: string): Promise<T> => {
    const res = await fetch(`${BASE}/artifacts/${id}/download`, {
      headers: { Authorization: `Bearer ${tokenStore.get() ?? ""}` },
    });
    if (!res.ok) throw new ApiError(res.status, `Could not load artifact (${res.status})`);
    return res.json() as Promise<T>;
  },
};