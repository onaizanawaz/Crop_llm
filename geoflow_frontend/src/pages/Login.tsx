import { useState, type FormEvent } from "react";

import { useAuth } from "../auth/AuthContext";

export default function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "in") await signIn(email, password);
      else await signUp(email, password, orgName);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "in" | "up") {
    if (next === mode) return;
    setMode(next);
    setError(null);
  }

  return (
    <div className="login-page">
      <div className="login-card card">
        <header className="login-head">
          <p className="eyebrow">
            <span className="brand-mark" aria-hidden="true" />
            GeoFlow
          </p>
          <h1 className="title">
            {mode === "in" ? "Sign in" : "Create an organisation"}
          </h1>
          <p className="lede">
            {mode === "in"
              ? "Crop water-stress analysis for your fields."
              : "You'll be the owner and can invite others afterwards."}
          </p>
        </header>

        <div className="segmented" role="tablist" aria-label="Account mode">
          <span className="segmented-thumb" data-at={mode === "in" ? 0 : 1} aria-hidden="true" />
          <button type="button" role="tab" aria-selected={mode === "in"}
                  data-on={mode === "in"} onClick={() => switchMode("in")}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === "up"}
                  data-on={mode === "up"} onClick={() => switchMode("up")}>
            New organisation
          </button>
        </div>

        <form onSubmit={submit} className="login-form">
          {mode === "up" && (
            <div className="field">
              <label htmlFor="org">Organisation</label>
              <input id="org" value={orgName} required
                     onChange={(e) => setOrgName(e.target.value)} placeholder="BKK Farms" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} required
                   placeholder="you@example.com"
                   onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" value={password} required minLength={8}
                   placeholder="••••••••"
                   autoComplete={mode === "in" ? "current-password" : "new-password"}
                   onChange={(e) => setPassword(e.target.value)} />
            {mode === "up" && (
              <span className="hint">At least 8 characters, at most 72 bytes.</span>
            )}
          </div>

          {error && <div className="error">{error}</div>}

          <button className="btn block" type="submit" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Working…" : mode === "in" ? "Sign in" : "Create organisation"}
          </button>
        </form>

        <p className="login-foot">
          {mode === "in" ? "No account yet?" : "Already have an account?"}{" "}
          <button type="button" className="linkish"
                  onClick={() => switchMode(mode === "in" ? "up" : "in")}>
            {mode === "in" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}