/**
 * The 2D surface: MapLibre GL over Esri raster tiles.
 *
 * This is the original MapView renderer, narrowed to one job. The basemap is
 * now a prop rather than local state -- MapView owns the choice so that
 * switching 2D/3D does not change what you are looking at.
 */

import { useEffect, useRef, useState } from "react";
import {
  AttributionControl, GeoJSONSource, Map as MLMap, MapMouseEvent,
  NavigationControl, ScaleControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, Geometry } from "geojson";

import { basemapStyle, boundsOf } from "./basemaps";
import { ringToPolygon, type MapSurfaceProps, type Ring } from "./types";

const AOI_SRC = "aoi";
const DRAFT_SRC = "aoi-draft";

function emptyFC(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export default function Map2D({
  aoi, drawing = false, basemap, onDrawChange, onDrawComplete,
  center = [74.35, 31.52], zoom = 11, onError, onVertices, focus, debug = false,
}: MapSurfaceProps) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ring = useRef<Ring>([]);
  const drawingRef = useRef(drawing);
  const [ready, setReady] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);

  drawingRef.current = drawing;

  /** Callbacks by ref, so a parent's inline arrow never re-runs an effect. */
  const cb = useRef({ onDrawChange, onDrawComplete, onVertices, onError });
  cb.current = { onDrawChange, onDrawComplete, onVertices, onError };

  // ---- create the map once
  useEffect(() => {
    if (!holder.current || map.current) return;

    const m = new MLMap({
      container: holder.current,
      style: basemapStyle(basemap),
      center,
      zoom,
      attributionControl: false,
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
    m.addControl(
      new AttributionControl({ compact: true, customAttribution: "Powered by Esri" }),
      "bottom-right",
    );

    m.on("load", () => {
      addLayers(m);
      setReady(true);
    });

    // Report what the map actually thinks its state is, so a blank pane is
    // answerable without reading DevTools. Gated on `debug` and throttled:
    // sourcedata fires per tile, and a setState per tile re-renders the page
    // while the map is still loading.
    let lastDiag = 0;
    const report = () => {
      if (!debug) return;
      const now = Date.now();
      if (now - lastDiag < 500) return;
      lastDiag = now;
      const c = m.getCanvas();
      setDiag({
        engine: "maplibre",
        canvas: `${c.width}x${c.height}`,
        css: `${Math.round(c.clientWidth)}x${Math.round(c.clientHeight)}`,
        styleLoaded: m.isStyleLoaded(),
        center: m.getCenter().toArray().map((n) => n.toFixed(2)).join(", "),
        zoom: m.getZoom().toFixed(1),
        sources: Object.keys(m.getStyle()?.sources ?? {}).join(",") || "none",
        layers: (m.getStyle()?.layers ?? []).length,
        loaded: m.areTilesLoaded(),
      });
    };
    m.on("load", report);
    m.on("idle", report);
    m.on("sourcedata", report);

    // A blank map with no explanation is the worst failure mode here: the
    // controls still render, so it looks like the app works. Surface it.
    m.on("error", (e) => {
      const msg = (e as any)?.error?.message ?? "Basemap failed to load.";
      console.error("[Map2D]", msg, e);
      cb.current.onError?.(msg);
    });

    // MapLibre measures the container once, at construction. Inside a flex
    // layout the sidebar has not been laid out yet at that moment, so the
    // canvas gets the full window width and the map ends up rendered off to
    // the right -- controls visible, tiles not. Re-measure whenever the
    // container actually changes size.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(holder.current);

    map.current = m;

    return () => { ro.disconnect(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply the chosen basemap -- only when it actually changes.
   *
   * This used to run on mount too, re-setting the style the map was built
   * with. setStyle tears down every source and layer, and the AOI layers were
   * put back on the first `styledata` event, which fires *during* the swap --
   * so they were discarded again when it finished. The result was a locator
   * map that never drew the field it exists to locate (measured: zero
   * accent-coloured pixels on the canvas).
   *
   * Now the constructor's style stands, and a real change waits for
   * isStyleLoaded() before restoring the AOI.
   */
  const appliedBasemap = useRef(basemap);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || appliedBasemap.current === basemap) return;
    appliedBasemap.current = basemap;
    m.setStyle(basemapStyle(basemap));

    const readd = () => {
      if (!m.isStyleLoaded()) return;
      m.off("styledata", readd);
      addLayers(m);
      paint(m, aoi, ring.current);
    };
    m.on("styledata", readd);
    return () => { m.off("styledata", readd); };
  }, [basemap, ready, aoi]);

  // ---- draw handlers
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const onClick = (e: MapMouseEvent) => {
      if (!drawingRef.current) return;
      ring.current = [...ring.current, [e.lngLat.lng, e.lngLat.lat]];
      cb.current.onVertices?.(ring.current.length);
      cb.current.onDrawChange?.(ring.current);
      paint(m, aoi, ring.current);
    };

    const onDbl = (e: MapMouseEvent) => {
      if (!drawingRef.current || ring.current.length < 3) return;
      e.preventDefault();
      cb.current.onDrawComplete?.(ringToPolygon(ring.current));
    };

    m.on("click", onClick);
    m.on("dblclick", onDbl);
    return () => { m.off("click", onClick); m.off("dblclick", onDbl); };
  }, [ready, aoi]);

  // ---- reset the draft when drawing stops
  useEffect(() => {
    if (drawing) return;
    ring.current = [];
    cb.current.onVertices?.(0);
    const m = map.current;
    if (m && ready) paint(m, aoi, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, ready, aoi]);

  // ---- render + fit the supplied AOI
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    paint(m, aoi, ring.current);
    if (aoi) {
      const b = boundsOf(aoi);
      if (b) m.fitBounds(b, { padding: 48, duration: 400, maxZoom: 16 });
    }
  }, [aoi, ready]);

  // ---- an externally requested camera move (the assistant's control_map)
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !focus) return;
    m.fitBounds(focus, { padding: 48, duration: 800, maxZoom: 16 });
  }, [focus, ready]);

  return (
    <>
      <div ref={holder} style={{ position: "absolute", inset: 0 }} />
      {debug && diag && (
        <div className="map-overlay map-diag">
          {Object.entries(diag).map(([k, v]) => (
            <div key={k}>{k}: <b style={{ color: "var(--ink)" }}>{String(v)}</b></div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

function addLayers(m: MLMap) {
  if (!m.getSource(AOI_SRC)) {
    m.addSource(AOI_SRC, { type: "geojson", data: emptyFC() });
    m.addLayer({
      id: "aoi-fill", type: "fill", source: AOI_SRC,
      paint: { "fill-color": "#0f6157", "fill-opacity": 0.08 },
    });
    m.addLayer({
      id: "aoi-line", type: "line", source: AOI_SRC,
      paint: { "line-color": "#0f6157", "line-width": 2 },
    });
  }
  if (!m.getSource(DRAFT_SRC)) {
    m.addSource(DRAFT_SRC, { type: "geojson", data: emptyFC() });
    m.addLayer({
      id: "draft-line", type: "line", source: DRAFT_SRC,
      paint: { "line-color": "#c08322", "line-width": 2, "line-dasharray": [2, 1.5] },
    });
    m.addLayer({
      id: "draft-pt", type: "circle", source: DRAFT_SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4.5, "circle-color": "#c08322",
        "circle-stroke-width": 2, "circle-stroke-color": "#fff",
      },
    });
  }
}

function paint(m: MLMap, aoi: Geometry | null | undefined, ring: Ring) {
  const aoiSrc = m.getSource(AOI_SRC) as GeoJSONSource | undefined;
  aoiSrc?.setData(
    aoi ? { type: "Feature", geometry: aoi as Geometry, properties: {} } : emptyFC(),
  );

  const draftSrc = m.getSource(DRAFT_SRC) as GeoJSONSource | undefined;
  if (!draftSrc) return;
  if (ring.length === 0) { draftSrc.setData(emptyFC()); return; }

  const features: Feature[] = ring.map((c) => ({
    type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {},
  }));
  if (ring.length >= 2) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: ring.length >= 3 ? [...ring, ring[0]] : ring,
      },
      properties: {},
    });
  }
  draftSrc.setData({ type: "FeatureCollection", features });
}