/**
 * A one-way channel from the assistant to whichever map is on screen.
 *
 * The assistant is mounted in the shell and the map is mounted by a page, so
 * they never share a parent that could hold this in state. A window event is
 * the smallest thing that works across that boundary, survives navigation, and
 * leaves MapView free to ignore commands it cannot honour.
 */

import type { Basemap } from "../map/basemaps";
import type { MapMode } from "../map/types";

export type MapCommand =
  | { type: "mode"; mode: MapMode }
  | { type: "basemap"; basemap: Basemap }
  | { type: "flyTo"; bounds: [[number, number], [number, number]] };

const EVENT = "geoflow:map-command";

export function sendMapCommand(cmd: MapCommand) {
  window.dispatchEvent(new CustomEvent<MapCommand>(EVENT, { detail: cmd }));
}

export function onMapCommand(handler: (cmd: MapCommand) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<MapCommand>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}