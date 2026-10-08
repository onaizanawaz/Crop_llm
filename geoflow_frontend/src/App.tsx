import { lazy } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "./auth/AuthContext";
import Shell from "./components/Shell";
import Login from "./pages/Login";

/**
 * One route, one chunk.
 *
 * Statically imported, these four pages pulled MapLibre and every screen into
 * a single 1.2 MB bundle -- so someone sitting on the sign-in form downloaded
 * the map engine and the node catalog before they had an account. Login stays
 * eager: it is the first paint for anyone signed out, and deferring it would
 * only add a round trip.
 */
const Workflows = lazy(() => import("./pages/Workflows"));
const NewAnalysis = lazy(() => import("./pages/NewAnalysis"));
const Catalog = lazy(() => import("./pages/Catalog"));
const WorkflowDetail = lazy(() => import("./pages/WorkflowDetail"));

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is terminal -- the client already signed us out, so retrying
      // just produces more 401s.
      retry: (count, err: any) => err?.status !== 401 && count < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

function Gate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="splash" role="status">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          GeoFlow
        </span>
        <span className="mono" style={{ fontSize: 11.5, letterSpacing: "0.12em" }}>
          RESTORING SESSION…
        </span>
      </div>
    );
  }
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Workflows />} />
        <Route path="new" element={<NewAnalysis />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="w/:id" element={<WorkflowDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}