import { Suspense } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { AssistantProvider, useAssistant } from "../ai/AssistantContext";
import { useAuth } from "../auth/AuthContext";
import Assistant from "./Assistant";

/** path, full label, and the short label a phone-width topbar uses instead. */
const LINKS: [string, string, string][] = [
  ["/", "Workflows", "Runs"],
  ["/new", "New analysis", "New"],
  ["/catalog", "Nodes", "Nodes"],
];

/**
 * The assistant's one entry point.
 *
 * There used to be a floating button as well, which duplicated this control,
 * covered the map's attribution, and on a phone sat underneath the page so it
 * could not be tapped at all. One button, always in the same place, is both
 * calmer and more reliable.
 */
function AskButton() {
  const { open, setOpen } = useAssistant();
  return (
    <button
      className="btn ghost sm ask-btn"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      aria-keyshortcuts="Control+K"
      title="Assistant (Ctrl+K)"
    >
      <span className="assistant-spark" aria-hidden="true" />
      <span className="compact-hide">Assistant</span>
      <span className="sr-label">Assistant</span>
    </button>
  );
}

function Chrome() {
  const { user, signOut } = useAuth();
  const { open } = useAssistant();
  const initial = (user?.org_name ?? user?.email ?? "?").trim().charAt(0);

  return (
    // data-dock shifts the page instead of letting the assistant cover it,
    // so a wide screen can read a report and the pipeline at the same time.
    <div className="app" data-dock={open ? "open" : "closed"}>
      <a className="skip-link" href="#main">Skip to content</a>

      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          GeoFlow
        </Link>

        <nav className="nav" aria-label="Main">
          {LINKS.map(([to, label, short]) => (
            <NavLink key={to} to={to} end={to === "/"}
                     className={({ isActive }) => (isActive ? "active" : undefined)}>
              {/* The full label wrapped onto two lines and then clipped
                  mid-word at phone widths; the short one fits whole. */}
              <span className="compact-hide">{label}</span>
              <span className="compact-only">{short}</span>
            </NavLink>
          ))}
        </nav>

        <div className="topbar-end">
          <AskButton />
          <div className="who">
            <div className="who-org">{user?.org_name}</div>
            {/* Truncated by CSS, so the full address lives on the title. */}
            <div className="who-email" title={user?.email}>{user?.email}</div>
          </div>
          <span className="avatar" aria-hidden="true">{initial}</span>
          <button className="btn quiet sm signout" onClick={signOut}>
            <span className="compact-hide">Sign out</span>
            <svg className="signout-icon" width="15" height="15" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
            <span className="sr-label">Sign out</span>
          </button>
        </div>
      </header>

      {/* The boundary sits inside the chrome, not around it: while a route's
          chunk arrives the topbar stays put and only the content area waits,
          so navigation never blanks the whole window. */}
      <main className="app-body" id="main" tabIndex={-1}>
        <Suspense
          fallback={
            <div className="route-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span className="sr-label">Loading…</span>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <Assistant />
    </div>
  );
}

export default function Shell() {
  return (
    <AssistantProvider>
      <Chrome />
    </AssistantProvider>
  );
}