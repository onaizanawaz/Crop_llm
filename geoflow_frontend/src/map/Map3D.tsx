/**
 * The 3D surface: a CesiumJS globe over the same Esri raster tiles as 2D.
 *
 * Deliberately the same imagery as MapLibre (see basemaps.ts): the 2D/3D
 * switch is a change of viewpoint, not a change of data. Everything else here
 * is Cesium's own vocabulary for the three things the 2D map does -- show the
 * AOI, draw a new one, and follow the basemap choice.
 *
 * Terrain needs a Cesium Ion account. If VITE_CESIUM_ION_TOKEN is set we load
 * world terrain and the field gets real relief; without it the globe falls
 * back to a smooth ellipsoid, which still renders and still tilts. That is a
 * deliberate default: the app must not require an account to show a map.
 */

import { useEffect, useRef, useState } from "react";
import {
  Cartesian2, Cartesian3, CallbackProperty, Color, Credit, Entity,
  HeightReference, Ion, ImageryLayer, Math as CesiumMath, PolygonHierarchy,
  Rectangle, ScreenSpaceEventHandler, ScreenSpaceEventType, TaskProcessor,
  Terrain, UrlTemplateImageryProvider, Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { BASEMAPS, boundsOf, plainAttribution } from "./basemaps";
import { ringToPolygon, type MapSurfaceProps, type Ring } from "./types";
import type { Basemap } from "./basemaps";

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;

/**
 * Skip Cesium's one-time "can this browser transfer ArrayBuffers?" probe.
 *
 * The probe posts to a throwaway worker and waits -- with no timeout -- for
 * the reply, but keeps no reference to that worker. On a busy page (React,
 * MapLibre, a multi-MB chunk still parsing) Chrome can garbage-collect the
 * worker before it answers. The promise then never settles, every terrain
 * tile waits on it forever in TRANSFORMING, and the globe renders as a black
 * void with stars. Reproduced here: holding a reference to the worker made
 * the globe load; without one it never did.
 *
 * The probe exists for a 2013 Firefox bug (bugzilla 841904). Every browser
 * that can run Cesium's WebGL today transfers ArrayBuffers, so the answer is
 * known and we give it up front. `_canTransferArrayBuffer` is a private static
 * that has been stable since 2013; if a future Cesium renames it this line is
 * a harmless no-op and the probe simply runs again.
 */
(TaskProcessor as unknown as { _canTransferArrayBuffer?: boolean })._canTransferArrayBuffer = true;

/** Matches the 2D palette exactly -- accent for a saved AOI, moderate for a draft. */
const AOI_COLOR = Color.fromCssColorString("#0f6157");
const DRAFT_COLOR = Color.fromCssColorString("#c08322");

function imageryFor(variant: Basemap): ImageryLayer {
  const def = BASEMAPS[variant];
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: def.tiles,
      maximumLevel: def.maxzoom,
      credit: new Credit(plainAttribution(variant)),
    }),
  );
}

/** lng/lat pairs to Cesium positions, clamped to the ground by the graphics. */
function toPositions(ring: Ring): Cartesian3[] {
  return ring.map(([lng, lat]) => Cartesian3.fromDegrees(lng, lat));
}

export default function Map3D({
  aoi, drawing = false, basemap, onDrawChange, onDrawComplete,
  center = [74.35, 31.52], zoom = 11, onError, onVertices, onStalled, focus,
  debug = false,
}: MapSurfaceProps) {
  const holder = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const ring = useRef<Ring>([]);
  const drawingRef = useRef(drawing);
  const aoiEntities = useRef<Entity[]>([]);
  const draftEntities = useRef<Entity[]>([]);
  const [ready, setReady] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);

  drawingRef.current = drawing;

  /**
   * Callbacks live in a ref, and the effects below depend only on `ready`.
   *
   * Pages pass these as inline arrow functions, so they are a new identity on
   * every render. An effect that depended on them would destroy and rebuild
   * Cesium's ScreenSpaceEventHandler on every render -- the sort of per-frame
   * churn that starves the globe's tile loading.
   */
  const cb = useRef({ onDrawChange, onDrawComplete, onVertices, onError, onStalled });
  cb.current = { onDrawChange, onDrawComplete, onVertices, onError, onStalled };

  // ---- create the viewer once
  useEffect(() => {
    if (!holder.current || viewer.current) return;

    if (ION_TOKEN) Ion.defaultAccessToken = ION_TOKEN;

    let v: Viewer;
    try {
      v = new Viewer(holder.current, {
        baseLayer: imageryFor(basemap),
        // Terrain is the one thing that needs an account; without a token
        // Cesium keeps its default ellipsoid rather than failing to build.
        terrain: ION_TOKEN ? Terrain.fromWorldTerrain() : undefined,
        // Every widget here duplicates chrome the app already provides, or
        // needs an Ion account (baseLayerPicker, geocoder). The app's own
        // basemap switcher and 2D/3D toggle are the controls that stay.
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        scene3DOnly: true,
      });
    } catch (err: any) {
      // WebGL can be unavailable (software rendering, blocked context). Say so
      // rather than leaving an empty black rectangle.
      const msg = err?.message ?? "WebGL is unavailable, so the 3D globe cannot start.";
      console.error("[Map3D]", err);
      cb.current.onError?.(msg);
      return;
    }

    // Cesium's own credit line sits over our overlays; move it out of the way
    // and let the app's attribution styling apply.
    v.cesiumWidget.creditContainer.classList.add("cesium-credits");

    // The default double-click zooms to an entity, which fights the "double
    // click to close the ring" gesture. Ours replaces it.
    v.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // A modest starting tilt: straight-down would be indistinguishable from 2D,
    // which defeats the point of the mode.
    v.camera.setView({
      destination: Cartesian3.fromDegrees(center[0], center[1], zoomToHeight(zoom)),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(-55), roll: 0 },
    });

    v.scene.globe.depthTestAgainstTerrain = false;

    viewer.current = v;
    setReady(true);

    // Watchdog state. A globe whose tiles never load renders as a black void
    // with stars -- the controls still work, so it looks like the app is fine
    // while showing nothing. Rather than trust that it never happens, we time
    // it and hand the map back to 2D, which draws the same imagery.
    let everLoaded = false;

    /**
     * tileLoadProgressEvent fires on essentially every frame while tiles are in
     * flight. Rendering from it is a trap: a setState per frame re-renders this
     * component ~60x a second, and the work that causes -- React reconciliation
     * plus the effects below tearing down and rebuilding Cesium's event handler
     * -- saturates the main thread. Cesium's terrain meshes are built in a
     * worker, but their replies are handled on that same thread, so the globe
     * starves: measured 0-4 imagery tiles in 18 s where a quiet page loads 69,
     * which is what made the pane look permanently black.
     *
     * So: never setState from this event unless the diagnostic panel is open,
     * and throttle it even then. The watchdog below needs no state at all.
     */
    let lastDiag = 0;
    const report = () => {
      const loaded = v.scene.globe.tilesLoaded;
      if (loaded) everLoaded = true;
      if (!debug) return;
      const now = Date.now();
      if (now - lastDiag < 500) return;
      lastDiag = now;

      const c = v.scene.canvas;
      const carto = v.camera.positionCartographic;
      setDiag({
        engine: "cesium",
        canvas: `${c.width}x${c.height}`,
        terrain: ION_TOKEN ? "world" : "ellipsoid",
        center: `${CesiumMath.toDegrees(carto.longitude).toFixed(2)}, ${CesiumMath.toDegrees(carto.latitude).toFixed(2)}`,
        heightM: Math.round(carto.height),
        tilesLoaded: loaded,
      });
    };
    report();
    const off = v.scene.globe.tileLoadProgressEvent.addEventListener(report);

    // 20 s is well past a normal first draw, even on a slow connection. If the
    // globe has still drawn nothing by then, say so once and let MapView pick
    // the engine that works rather than leaving a black pane on screen.
    const watchdog = window.setTimeout(() => {
      if (v.isDestroyed() || everLoaded || v.scene.globe.tilesLoaded) return;
      cb.current.onStalled?.();
    }, 20_000);

    // Cesium resizes itself on window resize only. In a flex layout the pane
    // changes size without the window doing so -- the same failure the 2D map
    // has -- so watch the container instead.
    const ro = new ResizeObserver(() => v.resize());
    ro.observe(holder.current);

    return () => {
      window.clearTimeout(watchdog);
      off();
      ro.disconnect();
      if (!v.isDestroyed()) v.destroy();
      viewer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Follow the basemap choice -- but only once it actually changes.
   *
   * The Viewer is constructed with this basemap already applied, so running
   * this on mount swapped the layer for an identical one. That is not free:
   * touching imageryLayers makes Cesium invalidateAllTiles(), which frees the
   * level-zero tiles and orphans the terrain-mesh tasks already in flight.
   * Those tasks never settle, and each one permanently consumes one of the
   * five slots in Cesium's mesh-task throttle, so the globe could end up
   * unable to build any tile at all -- a black sphere of stars, with the app
   * reporting "tilesLoaded" because nothing was left queued.
   */
  const appliedBasemap = useRef(basemap);
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready || appliedBasemap.current === basemap) return;
    appliedBasemap.current = basemap;
    v.imageryLayers.removeAll();
    v.imageryLayers.add(imageryFor(basemap));
  }, [basemap, ready]);

  // ---- draw handlers
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready) return;

    const handler = new ScreenSpaceEventHandler(v.scene.canvas);

    handler.setInputAction((click: { position: Cartesian2 }) => {
      if (!drawingRef.current) return;
      const lngLat = pickLngLat(v, click.position);
      if (!lngLat) return;                     // clicked past the horizon
      ring.current = [...ring.current, lngLat];
      cb.current.onVertices?.(ring.current.length);
      cb.current.onDrawChange?.(ring.current);
      drawDraft(v, draftEntities, ring.current);
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(() => {
      if (!drawingRef.current || ring.current.length < 3) return;
      cb.current.onDrawComplete?.(ringToPolygon(ring.current));
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    return () => handler.destroy();
  }, [ready]);

  // ---- reset the draft when drawing stops
  useEffect(() => {
    if (drawing) return;
    ring.current = [];
    cb.current.onVertices?.(0);
    const v = viewer.current;
    if (v && ready) drawDraft(v, draftEntities, []);
  }, [drawing, ready]);

  // ---- render + fly to the supplied AOI
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready) return;

    aoiEntities.current.forEach((e) => v.entities.remove(e));
    aoiEntities.current = [];
    if (!aoi) return;

    const rings = polygonRings(aoi);
    rings.forEach((r) => {
      const positions = toPositions(r);
      aoiEntities.current.push(
        v.entities.add({
          polygon: {
            hierarchy: new PolygonHierarchy(positions),
            material: AOI_COLOR.withAlpha(0.18),
            // Drape over terrain instead of floating at a fixed height, so the
            // boundary follows the field rather than cutting through a slope.
            heightReference: HeightReference.CLAMP_TO_GROUND,
          },
        }),
        v.entities.add({
          polyline: {
            positions: [...positions, positions[0]],
            width: 2,
            material: AOI_COLOR,
            clampToGround: true,
          },
        }),
      );
    });

    const b = boundsOf(aoi);
    if (b) {
      v.camera.flyTo({
        destination: Rectangle.fromDegrees(b[0][0], b[0][1], b[1][0], b[1][1]),
        // Keep the oblique view on arrival; a top-down fit would silently undo
        // the reason for being in 3D.
        orientation: { heading: 0, pitch: CesiumMath.toRadians(-50), roll: 0 },
        duration: 1.2,
      });
    }
  }, [aoi, ready]);

  // ---- an externally requested camera move (the assistant's control_map)
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready || !focus) return;
    v.camera.flyTo({
      destination: Rectangle.fromDegrees(focus[0][0], focus[0][1], focus[1][0], focus[1][1]),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(-50), roll: 0 },
      duration: 1.5,
    });
  }, [focus, ready]);

  return (
    <>
      <div ref={holder} className="cesium-holder"
           style={{ position: "absolute", inset: 0 }} />
      {debug && diag && (
        <div className="map-overlay map-diag">
          {Object.entries(diag).map(([k, v]) => (
            <div key={k}>{k}: <b style={{ color: "var(--ink)" }}>{String(v)}</b></div>
          ))}
        </div>
      )}
      {!ION_TOKEN && (
        <div className="map-overlay map-note">
          Flat globe — set <code>VITE_CESIUM_ION_TOKEN</code> for terrain relief
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

/**
 * A web-mercator zoom level to a camera height, roughly. Cesium has no notion
 * of zoom, so the 2D `zoom` prop has to be translated or the two engines start
 * at wildly different scales.
 */
function zoomToHeight(zoom: number): number {
  return 40_000_000 / Math.pow(2, zoom - 1);
}

/**
 * Screen point to lng/lat.
 *
 * globe.pick follows terrain, which is what we want when a token is present;
 * it returns undefined when the ray misses the globe (past the horizon, or
 * over a tile that has not loaded), so the ellipsoid is the fallback.
 */
function pickLngLat(v: Viewer, position: Cartesian2): [number, number] | null {
  const ray = v.camera.getPickRay(position);
  const cartesian =
    (ray && v.scene.globe.pick(ray, v.scene)) ??
    v.camera.pickEllipsoid(position, v.scene.globe.ellipsoid);
  if (!cartesian) return null;
  const carto = v.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
  return [CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude)];
}

/** Every ring of a Polygon or MultiPolygon, ignoring holes' distinction. */
function polygonRings(g: any): Ring[] {
  if (g?.type === "Polygon") return g.coordinates as Ring[];
  if (g?.type === "MultiPolygon") return (g.coordinates as Ring[][]).flat();
  if (g?.geometry) return polygonRings(g.geometry);
  return [];
}

function drawDraft(
  v: Viewer,
  store: { current: Entity[] },
  ring: Ring,
) {
  store.current.forEach((e) => v.entities.remove(e));
  store.current = [];
  if (!ring.length) return;

  const positions = toPositions(ring);
  positions.forEach((p) =>
    store.current.push(
      v.entities.add({
        position: p,
        point: {
          pixelSize: 9,
          color: DRAFT_COLOR,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    ),
  );

  if (positions.length >= 2) {
    // A CallbackProperty keeps the line live while vertices are still being
    // added, without rebuilding the entity on every click.
    const line = ring.length >= 3 ? [...positions, positions[0]] : positions;
    store.current.push(
      v.entities.add({
        polyline: {
          positions: new CallbackProperty(() => line, false),
          width: 2,
          material: DRAFT_COLOR,
          clampToGround: true,
        },
      }),
    );
  }
}