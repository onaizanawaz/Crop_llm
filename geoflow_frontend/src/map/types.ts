/** The contract both map engines implement, so MapView can swap them freely. */

import type { Geometry, Polygon } from "geojson";
import type { Basemap } from "./basemaps";

/** Which engine is on screen. Lives here so non-component code can name it. */
export type MapMode = "2d" | "3d";

/** An open (unclosed) list of lng/lat pairs -- the boundary being drawn. */
export type Ring = [number, number][];

export interface MapSurfaceProps {
  /** Existing AOI to display, as a GeoJSON Polygon geometry. */
  aoi?: Geometry | null;
  /** When true, clicking adds vertices. Double-click closes the ring. */
  drawing?: boolean;
  /** Which basemap to show. Owned by MapView so 2D and 3D stay in step. */
  basemap: Basemap;
  onDrawChange?: (ring: Ring) => void;
  onDrawComplete?: (polygon: Polygon) => void;
  center?: [number, number];
  zoom?: number;
  /** Bubbled up so MapView renders one error overlay for either engine. */
  onError?: (msg: string | null) => void;
  /** Reports the live vertex count, for the drawing hint. */
  onVertices?: (n: number) => void;
  /** A bounding box to fly to, set by the assistant. Re-set to re-fly. */
  focus?: [[number, number], [number, number]] | null;
  /**
   * Called when the engine has started but still has not drawn anything after
   * a generous wait. MapView uses it to fall back to the engine that works,
   * so a viewer never sits in front of an unexplained blank pane.
   */
  onStalled?: () => void;
  /** Renders the engine's internal state. For diagnosing a blank pane. */
  debug?: boolean;
}

/** GeoJSON requires the ring to close on its first coordinate. */
export function ringToPolygon(ring: Ring): Polygon {
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}