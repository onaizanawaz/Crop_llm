/**
 * The map: one component, two engines.
 *
 * 2D is MapLibre GL, 3D is a CesiumJS globe, and both draw the *same* Esri
 * raster basemaps from src/map/basemaps.ts -- switching viewpoint never
 * switches what you are looking at. The chrome (basemap switcher, 2D/3D
 * toggle, error and hint overlays) lives here rather than in either engine, so
 * the two modes are indistinguishable apart from the projection.
 *
 * Attribution is a licence condition, so it stays visible in both.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Geometry, Polygon } from "geojson";

import { onMapCommand } from "../ai/mapbus";
import { BASEMAPS, BASEMAP_KEYS, boundsOf, prefersDark } from "../map/basemaps";
import type { Basemap } from "../map/basemaps";
import { ringToPolygon } from "../map/types";
import type { MapMode, Ring } from "../map/types";

/**
 * Cesium is roughly 3 MB of engine plus its asset bundle. Loading it lazily
 * keeps it out of the initial bundle for anyone who never opens 3D -- which
 * includes every page load that only shows a small read-only map.
 */
const Map3D = lazy(() => import("../map/Map3D"));

/**
 * MapLibre is lazy for the same reason, if less dramatically so: it is most of
 * the main bundle, and the sign-in form, the workflow list and the node
 * catalog draw no map at all. Both engines now arrive only when one is asked
 * for.
 */
const Map2D = lazy(() => import("../map/Map2D"));

export type { Basemap, MapMode, Ring };

export interface MapViewProps {
  /** Existing AOI to display, as a GeoJSON Polygon geometry. */
  aoi?: Geometry | null;
  /** When true, clicking adds vertices. Finish or double-click closes the ring. */
  drawing?: boolean;
  onDrawChange?: (ring: Ring) => void;
  onDrawComplete?: (polygon: Polygon) => void;
  center?: [number, number];
  zoom?: number;
  height?: string;
  /** Hide the basemap switcher on small, read-only maps. */
  showBasemapSwitcher?: boolean;
  /** Hide the 2D/3D switch where the pane is too small to fly a globe in. */
  showModeSwitcher?: boolean;
  /** Which engine to start in. 3D is the app default. */
  defaultMode?: MapMode;
  /**
   * Basemap to open with, overriding the viewer's light/dark theme.
   *
   * A saved field wants "satellite": a crop boundary over a grey canvas shows
   * the viewer nothing about their land.
   */
  defaultBasemap?: Basemap;
  /**
   * Frame an existing AOI on arrival. On by default -- a map that opens on a
   * fixed centre shows an empty landscape whenever the field is elsewhere, and
   * a five-hectare field is a few pixels wide at the default zoom even when it
   * is not.
   */
  fitToAoi?: boolean;
  /** Renders the engine's internal state. For diagnosing a blank pane. */
  debug?: boolean;
}

const MODES: [MapMode, string][] = [["2d", "2D"], ["3d", "3D"]];

export default function MapView({
  aoi, drawing = false, onDrawChange, onDrawComplete,
  center = [74.35, 31.52], zoom = 11, height = "100%",
  showBasemapSwitcher = true, showModeSwitcher = true,
  defaultMode = "3d", defaultBasemap, fitToAoi = true,
  debug: debugProp = false,
}: MapViewProps) {
  // ?mapdebug on any page turns on the engine's diagnostic panel, so a blank
  // or black pane can be answered from the browser without a code change.
  const debug = debugProp || new URLSearchParams(window.location.search).has("mapdebug");
  const [mode, setMode] = useState<MapMode>(defaultMode);
  const [mapError, setMapError] = useState<string | null>(null);
  /** Set when 3D gave up on its own and we moved the viewer to 2D. */
  const [fellBack, setFellBack] = useState(false);
  const [vertices, setVertices] = useState(0);
  /**
   * The ring being drawn, mirrored from the engine.
   *
   * Closing the boundary used to be possible only by double-clicking, which
   * nothing told the viewer about until the third vertex -- so a field clicked
   * out corner by corner simply never became an AOI. Holding the ring here lets
   * MapView offer a Finish button without either engine needing to know.
   */
  const ring = useRef<Ring>([]);
  const [focus, setFocus] = useState<[[number, number], [number, number]] | null>(null);
  const [basemap, setBasemap] = useState<Basemap>(
    () => defaultBasemap ?? (prefersDark() ? "dark" : "light"));
  // An explicit pick outranks the OS theme from then on: someone who chose
  // Satellite does not want it silently reverted at sunset. A caller-supplied
  // default counts as such a pick, or the theme watcher would undo it.
  const userPicked = useRef(Boolean(defaultBasemap));

  const handleDrawChange = useCallback((r: Ring) => {
    ring.current = r;
    onDrawChange?.(r);
  }, [onDrawChange]);

  // A ring from an abandoned attempt must not be finishable later.
  useEffect(() => { if (!drawing) ring.current = []; }, [drawing]);

  function finishDrawing() {
    if (ring.current.length < 3) return;
    onDrawComplete?.(ringToPolygon(ring.current));
  }

  // ---- follow the viewer's theme until they choose for themselves
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const swap = () => {
      if (userPicked.current) return;
      setBasemap(prefersDark() ? "dark" : "light");
    };
    mq.addEventListener("change", swap);
    return () => mq.removeEventListener("change", swap);
  }, []);

  // An engine's failure is about that engine, so it must not outlive a switch --
  // cleared where the switch happens rather than in an effect watching `mode`,
  // which would cost a second render on every change.
  function switchMode(next: MapMode) {
    setMapError(null);
    setFellBack(false);
    setMode(next);
  }

  /**
   * 3D started but never drew anything.
   *
   * Showing a black pane with working buttons is the worst outcome here: it
   * looks like the app is fine and the field simply is not there. 2D draws the
   * same imagery, so the map quietly becomes useful again and says what it did.
   */
  const handleStalled = () => {
    setMode("2d");
    setFellBack(true);
  };

  /**
   * Frame the field once per boundary.
   *
   * Keyed on the bounds rather than a boolean so a different field frames
   * again, while a re-render with the same one does not fight a viewer who has
   * since panned away.
   */
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!fitToAoi || drawing || !aoi) return;
    const b = boundsOf(aoi);
    if (!b) return;
    const key = JSON.stringify(b);
    if (framed.current === key) return;
    framed.current = key;
    setFocus([[...b[0]], [...b[1]]]);
  }, [aoi, drawing, fitToAoi]);

  // ---- the assistant drives the same controls a person would
  useEffect(() =>
    onMapCommand((cmd) => {
      if (cmd.type === "mode") switchMode(cmd.mode);
      if (cmd.type === "basemap") { userPicked.current = true; setBasemap(cmd.basemap); }
      // A fresh array identity each time, so asking twice flies twice.
      if (cmd.type === "flyTo") setFocus([[...cmd.bounds[0]], [...cmd.bounds[1]]]);
    }), []);

  /**
   * A stable props object for whichever engine is mounted.
   *
   * Rebuilding this on every render gave the engines new callback identities
   * each time, and their effects tore down and recreated real map objects in
   * response -- per-frame churn that visibly starved Cesium's tile loading.
   * `center` is spread into a fresh array by callers, so it is compared by
   * value here rather than by identity.
   */
  const [lng, lat] = center;
  const surface = useMemo(
    () => ({
      aoi, drawing, basemap, debug, focus,
      center: [lng, lat] as [number, number],
      zoom,
      onDrawChange: handleDrawChange,
      onDrawComplete,
      onError: setMapError,
      onVertices: setVertices,
      onStalled: handleStalled,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aoi, drawing, basemap, debug, focus, lng, lat, zoom, handleDrawChange, onDrawComplete],
  );

  return (
    <div className="map-wrap" style={{ height }}>
      <Suspense
        fallback={
          <div className="map-loading">
            <span className="spinner" aria-hidden="true" />
            <span>{mode === "3d" ? "Loading the 3D globe…" : "Loading the map…"}</span>
          </div>
        }
      >
        {mode === "2d" ? <Map2D {...surface} /> : <Map3D {...surface} />}
      </Suspense>

      {mapError && (
        <div className="map-overlay map-error" role="status">
          {mode === "3d" ? "3D globe" : "Basemap"}: {mapError}
          {mode === "3d" && (
            <button className="linkish" style={{ marginLeft: 8 }}
                    onClick={() => switchMode("2d")}>
              Switch to 2D
            </button>
          )}
        </div>
      )}

      {fellBack && !mapError && (
        <div className="map-overlay map-note" role="status">
          3D didn’t load, so this is the 2D map — same imagery.{" "}
          <button className="linkish" onClick={() => switchMode("3d")}>Try 3D again</button>
        </div>
      )}

      {/* One row, laid out by flex rather than hand-set offsets: the two
          switchers used to be positioned independently and the basemap one,
          being wider than its slot, sat on top of the 2D button. */}
      {(showModeSwitcher || showBasemapSwitcher) && (
        <div className="map-controls">
          {showModeSwitcher && (
            <div className="map-overlay mapmodes" role="group" aria-label="Map dimension">
              {MODES.map(([m, label]) => (
                <button key={m} onClick={() => switchMode(m)} aria-pressed={mode === m}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {showBasemapSwitcher && (
            <div className="map-overlay basemaps" role="group" aria-label="Basemap">
              {BASEMAP_KEYS.map((b) => (
                <button
                  key={b}
                  onClick={() => { userPicked.current = true; setBasemap(b); }}
                  aria-pressed={basemap === b}
                >
                  {BASEMAPS[b].label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {drawing && (
        <div className="map-overlay map-hint"
             style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {vertices < 3
              ? `Click the field corners — ${3 - vertices} more needed`
              : `${vertices} corners — finish when the field is enclosed`}
          </span>
          <button
            className="btn quiet"
            style={{ padding: "3px 10px", fontSize: 12.5 }}
            onClick={finishDrawing}
            disabled={vertices < 3}
            title={vertices < 3
              ? "A boundary needs at least three corners"
              : "Close the boundary"}
          >
            Finish
          </button>
        </div>
      )}
    </div>
  );
}