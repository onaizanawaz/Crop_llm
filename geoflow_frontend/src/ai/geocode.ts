/**
 * Place-name lookup, via OpenStreetMap's Nominatim.
 *
 * No key and no account, which matches the rest of the map stack. The trade is
 * Nominatim's usage policy: at most one request per second, and the client must
 * identify itself. A browser cannot set User-Agent, so the Referer the browser
 * sends automatically is what identifies us -- which is why this calls the API
 * directly rather than through a proxy that would strip it.
 *
 * Asking the language model for coordinates instead would be cheaper and is
 * tempting, but a model that misremembers a city by a degree puts the map in
 * the wrong province with no indication anything is wrong. A gazetteer lookup
 * is either right or empty.
 */

export interface Place {
  name: string;
  displayName: string;
  /** [lng, lat] */
  center: [number, number];
  /** [[minLng, minLat], [maxLng, maxLat]] -- the order MapLibre expects. */
  bounds: [[number, number], [number, number]];
  kind: string;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL_MS = 1100;

const cache = new Map<string, Place | null>();
let lastCall = 0;

async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export async function geocode(query: string): Promise<Place | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;

  await throttle();

  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(
      "Could not reach the place-name service. Check the network connection.",
    );
  }
  if (!res.ok) {
    throw new Error(`Place lookup failed (${res.status} ${res.statusText}).`);
  }

  const hits = (await res.json()) as any[];
  if (!hits?.length) {
    cache.set(key, null);
    return null;
  }

  const h = hits[0];
  // Nominatim gives [south, north, west, east] as strings; MapLibre wants
  // [[west, south], [east, north]] as numbers.
  const [s, n, w, e] = (h.boundingbox as string[]).map(Number);
  const place: Place = {
    name: h.name ?? query,
    displayName: h.display_name ?? h.name ?? query,
    center: [Number(h.lon), Number(h.lat)],
    bounds: [[w, s], [e, n]],
    kind: h.type ?? h.addresstype ?? "place",
  };
  cache.set(key, place);
  return place;
}