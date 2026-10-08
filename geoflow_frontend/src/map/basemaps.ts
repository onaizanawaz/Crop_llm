/**
 * The basemap catalogue, owned in one place because two engines consume it.
 *
 * MapLibre (2D) wants a StyleSpecification; Cesium (3D) wants a URL template
 * plus a maximumLevel. If these lived in the renderers, "Satellite" would drift
 * into meaning two different services and switching 2D/3D would change what
 * the viewer is looking at. Everything either engine needs about a basemap is
 * derived from the one record below.
 *
 * CARTO was dropped here: basemaps.cartocdn.com now requires an API key and
 * serves an "API KEY REQUIRED" watermark over every unauthenticated tile
 * instead of returning an error, so the map looked broken while every request
 * still came back 200. Esri's equivalents need no key and no account.
 */

import type { StyleSpecification } from "maplibre-gl";

export type Basemap = "light" | "dark" | "satellite";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

interface BasemapDef {
  label: string;
  /**
   * Note the {z}/{y}/{x} order: Esri puts row before column, unlike plain XYZ.
   * Both engines take this template verbatim -- MapLibre and Cesium both number
   * rows from the top, as ArcGIS REST /tile/{level}/{row}/{col} does. (Cesium's
   * {reverseY} is for TMS services, which count from the bottom; using it here
   * would mirror every basemap vertically.)
   */
  tiles: string;
  /** Attribution is a licence condition and differs per service. */
  attribution: string;
  /**
   * The deepest zoom the service actually publishes. Without it MapLibre
   * requests tiles past that level and gets 404s -- a blank pane exactly when
   * a user zooms into a field. With it, both engines overzoom the last real
   * tile instead.
   */
  maxzoom: number;
}

export const BASEMAPS: Record<Basemap, BasemapDef> = {
  light: {
    label: "Light",
    tiles: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    attribution: "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxzoom: 16,
  },
  dark: {
    label: "Dark",
    tiles: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    attribution: "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxzoom: 16,
  },
  satellite: {
    label: "Satellite",
    tiles: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    attribution:
      "&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxzoom: 19,
  },
};

export const BASEMAP_KEYS = Object.keys(BASEMAPS) as Basemap[];

/**
 * The 2D form: an inline MapLibre style.
 *
 * The vector styles (positron-gl-style/style.json) parse fine but never finish
 * loading in the browser: 93 layers resolve, styleLoaded stays false, and the
 * pane renders empty. A vector style depends on a chain of further fetches --
 * TileJSON, sprite, and a glyph PBF per fontstack -- and any one of them
 * stalling leaves every layer with nothing to draw. Raster tiles have none of
 * that indirection: one request per tile, no fonts, no sprite.
 */
export function basemapStyle(variant: Basemap): StyleSpecification {
  const def = BASEMAPS[variant];
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [def.tiles],
        tileSize: 256,
        maxzoom: def.maxzoom,
        attribution: def.attribution,
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

/** Plain-text attribution for Cesium's credit line, which does not take HTML. */
export function plainAttribution(variant: Basemap): string {
  return BASEMAPS[variant].attribution
    .replace(/&copy;/g, "©")
    .replace(/<[^>]*>/g, "");
}

/** Does the viewer want a dark UI right now? Drives the default basemap. */
export function prefersDark(): boolean {
  const stamped = document.documentElement.getAttribute("data-theme");
  if (stamped === "dark") return true;
  if (stamped === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Bounding box of any polygon-ish geometry, for fitBounds / flyTo. */
export function boundsOf(g: any): [[number, number], [number, number]] | null {
  const coords: number[][] = [];
  const walk = (x: any) => {
    if (!Array.isArray(x)) return;
    if (typeof x[0] === "number" && typeof x[1] === "number") {
      coords.push(x as number[]);
      return;
    }
    x.forEach(walk);
  };
  walk(g?.coordinates ?? g?.geometry?.coordinates);
  if (!coords.length) return null;
  const lng = coords.map((c) => c[0]);
  const lat = coords.map((c) => c[1]);
  return [
    [Math.min(...lng), Math.min(...lat)],
    [Math.max(...lng), Math.max(...lat)],
  ];
}