/**
 * Facts about a field that need no analysis run: its size, and the weather
 * over it.
 *
 * Both answer questions a grower asks constantly and neither justifies an
 * Earth Engine job, so they live here rather than as workflow nodes. Area is
 * pure geometry. Weather comes from Open-Meteo, which like the CARTO basemaps
 * and Nominatim needs no key and no account.
 */

const EARTH_RADIUS_M = 6_378_137;
const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

type Ring = number[][];

function ringsOf(geometry: any): Ring[] {
  const c = geometry?.coordinates ?? geometry?.geometry?.coordinates;
  if (!Array.isArray(c)) return [];
  // Polygon is [ring, ...holes]; MultiPolygon is [[ring, ...], ...].
  if (typeof c[0]?.[0]?.[0] === "number") return c as Ring[];
  if (typeof c[0]?.[0]?.[0]?.[0] === "number") return (c as Ring[][]).flat();
  return [];
}

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Spherical polygon area in m², by the shoelace formula on a sphere.
 *
 * A planar calculation on degrees would be wrong by the cosine of the
 * latitude -- about 15% at 31°N, which is the difference between a hectare
 * figure a grower trusts and one they do not.
 */
export function areaM2(geometry: any): number {
  let total = 0;
  for (const ring of ringsOf(geometry)) {
    if (ring.length < 4) continue;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      sum += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
    }
    total += Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
  }
  return total;
}

/** Great-circle perimeter in metres. */
export function perimeterM(geometry: any): number {
  let total = 0;
  for (const ring of ringsOf(geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const dLat = rad(lat2 - lat1);
      const dLon = rad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
      total += 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
    }
  }
  return total;
}

export function centroid(geometry: any): [number, number] | null {
  const pts = ringsOf(geometry).flat();
  if (!pts.length) return null;
  const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lon, lat];
}

export interface Weather {
  temperature_c: number;
  humidity_pct: number;
  wind_kmh: number;
  rain_now_mm: number;
  forecast_days: number;
  rain_total_mm: number;
  reference_et_total_mm: number;
  timezone: string;
}

/**
 * Current conditions plus a short forecast.
 *
 * reference_et_total_mm is the FAO reference evapotranspiration Open-Meteo
 * already computes. It is the same quantity the irrigation node takes from
 * WaPOR, so a grower can sanity-check a recommendation built on a 250 m
 * satellite grid against a local forecast -- and rain_total_mm is the figure
 * the node's own note says to subtract before applying water.
 */
export async function weatherAt(
  lon: number,
  lat: number,
  days = 7,
): Promise<Weather> {
  const url =
    `${WEATHER_ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m` +
    `&daily=precipitation_sum,et0_fao_evapotranspiration` +
    `&forecast_days=${days}&timezone=auto`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Could not reach the weather service. Check the network.");
  }
  if (!res.ok) throw new Error(`Weather lookup failed (${res.status}).`);

  const b = await res.json();
  const sum = (xs: unknown) =>
    Array.isArray(xs) ? xs.reduce((s: number, v) => s + (Number(v) || 0), 0) : 0;

  return {
    temperature_c: b.current?.temperature_2m,
    humidity_pct: b.current?.relative_humidity_2m,
    wind_kmh: b.current?.wind_speed_10m,
    rain_now_mm: b.current?.precipitation ?? 0,
    forecast_days: days,
    rain_total_mm: Math.round(sum(b.daily?.precipitation_sum) * 10) / 10,
    reference_et_total_mm:
      Math.round(sum(b.daily?.et0_fao_evapotranspiration) * 10) / 10,
    timezone: b.timezone ?? "UTC",
  };
}