/**
 * What the assistant knows about where the user is.
 *
 * The boundary being drawn lives in NewAnalysis' state and the open analysis
 * lives in the URL, so the assistant -- mounted once in the shell -- has no
 * way to read either. Pages publish into this context; the assistant reads it
 * when a turn starts, so a command like "analyse this field" resolves against
 * what is genuinely on screen at that moment.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Geometry, Polygon } from "geojson";

export interface AssistantState {
  aoi: Polygon | Geometry | null;
  setAoi: (a: Polygon | Geometry | null) => void;
  dateRange: { start: string; end: string };
  setDateRange: (r: { start: string; end: string }) => void;
  open: boolean;
  setOpen: (b: boolean) => void;
}

/** The composer's text. Separate on purpose -- see the note on DraftCtx. */
export interface AssistantDraft {
  /** Prefills the composer, so a page can offer "ask about this". */
  draft: string;
  setDraft: (s: string) => void;
}

const DEFAULT_RANGE = { start: "2024-06-01", end: "2024-09-30" };

const Ctx = createContext<AssistantState | null>(null);

/**
 * The composer text lives in its own context.
 *
 * It used to sit in the value above, which meant every keystroke produced a
 * new context value and re-rendered every consumer -- the topbar's Ask button,
 * and through usePublishContext both New analysis and the analysis page, map
 * component included. Typing a question re-rendered the page behind it. Two
 * contexts, one provider: what a page reads changes only when the page's own
 * situation changes.
 */
const DraftCtx = createContext<AssistantDraft | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [aoi, setAoi] = useState<Polygon | Geometry | null>(null);
  const [dateRange, setDateRange] = useState(DEFAULT_RANGE);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const value = useMemo<AssistantState>(
    () => ({ aoi, setAoi, dateRange, setDateRange, open, setOpen }),
    [aoi, dateRange, open],
  );

  const draftValue = useMemo<AssistantDraft>(() => ({ draft, setDraft }), [draft]);

  return (
    <Ctx.Provider value={value}>
      <DraftCtx.Provider value={draftValue}>{children}</DraftCtx.Provider>
    </Ctx.Provider>
  );
}

export function useAssistant(): AssistantState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistant must be used inside AssistantProvider");
  return v;
}

/** Only the composer should call this: it changes on every keystroke. */
export function useAssistantDraft(): AssistantDraft {
  const v = useContext(DraftCtx);
  if (!v) throw new Error("useAssistantDraft must be used inside AssistantProvider");
  return v;
}

/**
 * Publish a page's boundary and season for as long as the page is mounted, and
 * withdraw them on the way out -- a stale boundary from a page the user has
 * left is worse than none, because the assistant would silently analyse the
 * wrong field.
 */
export function usePublishContext(
  aoi: Polygon | Geometry | null,
  range?: { start: string; end: string },
) {
  const { setAoi, setDateRange } = useAssistant();
  useEffect(() => {
    setAoi(aoi);
    if (range) setDateRange(range);
    return () => setAoi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aoi, range?.start, range?.end]);
}