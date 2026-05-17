// src/app/api/route/here/route.ts
//
// HERE Routing API v8 handler — drop-in replacement for /api/route/valhalla.
// Accepts the same request body and returns the same response shape so that
// /api/route/plan needs only a one-line URL change.
//
// NOTE: HERE Freemium plan allows ~5 req/s. This is sufficient for single-user
// operation. Add server-side throttling if the app becomes multi-tenant.

import { NextRequest, NextResponse } from "next/server";
import { decode as decodeFlexPolyline } from "@here/flexpolyline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERE_ROUTER_URL = "https://router.hereapi.com/v8/routes";
/** HERE hard limit for avoid[areas] polygons per request */
const HERE_MAX_AVOID_POLYGONS = 20;
const HERE_DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Coords = [number, number]; // always [lon, lat] (GeoJSON convention)

type VehicleSpec = {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
  hazmat?: boolean;
};

export type HereNotice = {
  title: string;
  code?: string;
  severity?: string;
  cause?: string;
};

// ---------------------------------------------------------------------------
// Coordinate utilities
// ---------------------------------------------------------------------------

function toNum(x: any): number | null {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

function normalizeCoords(input: any): Coords | null {
  if (Array.isArray(input) && input.length >= 2) {
    const lon = toNum(input[0]);
    const lat = toNum(input[1]);
    if (lon == null || lat == null) return null;
    return [lon, lat];
  }
  if (input && typeof input === "object") {
    const lon = toNum(input.lon ?? input.lng);
    const lat = toNum(input.lat);
    if (lon == null || lat == null) return null;
    return [lon, lat];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Avoid-polygon conversion: GeoJSON Polygon geometries → HERE avoid[areas]
// ---------------------------------------------------------------------------

/**
 * Computes a rough area proxy for a GeoJSON polygon ring (sum of |cross products|).
 * Used only for sorting — not a precise geographic area.
 */
function ringAreaProxy(ring: number[][]): number {
  let area = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const [x0, y0] = ring[0];
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
  }
  return area;
}

/**
 * Converts an array of GeoJSON Polygon/MultiPolygon geometry objects to the
 * HERE `avoid[areas]` query-parameter string.
 *
 * Input coords are [lng, lat] (GeoJSON); HERE expects lat,lng — we swap.
 * Returns { value, used, dropped } where `value` is the query param string.
 */
function buildAvoidAreas(geoms: any[]): {
  value: string;
  used: number;
  dropped: number;
} {
  if (!geoms.length) return { value: "", used: 0, dropped: 0 };

  // Collect outer rings from Polygon and MultiPolygon geometries
  const rings: number[][][] = [];
  for (const g of geoms) {
    if (!g) continue;
    if (g.type === "Polygon" && Array.isArray(g.coordinates?.[0])) {
      rings.push(g.coordinates[0]);
    } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
      for (const poly of g.coordinates) {
        if (Array.isArray(poly?.[0])) rings.push(poly[0]);
      }
    }
  }

  if (!rings.length) return { value: "", used: 0, dropped: 0 };

  // Sort ascending by area so the most precise (smallest) restrictions are
  // kept when we must drop polygons due to HERE's 20-polygon limit.
  rings.sort((a, b) => ringAreaProxy(a) - ringAreaProxy(b));

  const used = Math.min(rings.length, HERE_MAX_AVOID_POLYGONS);
  const dropped = rings.length - used;

  if (dropped > 0) {
    console.warn(
      `[HERE] avoid[areas] limit reached: using ${used}/${rings.length} polygons, dropped ${dropped}`
    );
  }

  const parts = rings.slice(0, used).map((ring) => {
    // Ensure ring is closed (last point = first point)
    const closed =
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
        ? ring
        : [...ring, ring[0]];

    // Swap [lng, lat] → lat,lng for HERE
    const coords = closed.map(([lng, lat]) => `${lat},${lng}`).join(";");
    return `polygon:${coords}`;
  });

  return { value: parts.join("|"), used, dropped };
}

// ---------------------------------------------------------------------------
// HERE response → GeoJSON FeatureCollection
// ---------------------------------------------------------------------------

/**
 * Decodes a HERE Flexible Polyline string and returns GeoJSON [lng, lat] pairs.
 */
function decodeHerePolyline(encoded: string): Coords[] {
  try {
    const { polyline } = decodeFlexPolyline(encoded);
    // flexpolyline returns [lat, lng] → swap to [lng, lat] for GeoJSON
    return (polyline as [number, number][]).map(([lat, lng]) => [lng, lat]);
  } catch (e) {
    console.error("[HERE] flexpolyline decode error:", e);
    return [];
  }
}

function computeBBox(coords: Coords[]): [number, number, number, number] | null {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const coord of coords) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Extracts street names from a HERE action's road references.
 */
function extractStreetNames(action: any): string[] {
  const names: string[] = [];
  for (const roadKey of ["currentRoad", "nextRoad"]) {
    const nameArr = action?.[roadKey]?.name;
    if (Array.isArray(nameArr)) {
      for (const n of nameArr) {
        if (n?.value && !names.includes(n.value)) names.push(n.value);
      }
    }
  }
  return names;
}

/**
 * Converts a single HERE route object to a GeoJSON FeatureCollection
 * matching the shape that /api/route/plan expects.
 */
function hereRouteToGeoJSON(route: any): {
  type: "FeatureCollection";
  features: any[];
} {
  const sections: any[] = Array.isArray(route?.sections) ? route.sections : [];
  const coords: Coords[] = [];
  const maneuvers: any[] = [];
  const streets_sequence: string[] = [];
  const notices: HereNotice[] = [];
  let distance_km = 0;
  let duration_s = 0;

  sections.forEach((section: any, idx: number) => {
    if (section.type === "pedestrian") return; // skip transfer segments

    const sectionCoords = decodeHerePolyline(section.polyline ?? "");
    if (!sectionCoords.length) return;

    for (const coord of sectionCoords) {
      const prev = coords[coords.length - 1];
      if (!prev || prev[0] !== coord[0] || prev[1] !== coord[1]) coords.push(coord);
    }

    const summary = section.summary ?? {};
    const actions: any[] = Array.isArray(section.actions) ? section.actions : [];
    const sectionNotices: HereNotice[] = Array.isArray(section.notices)
      ? section.notices
      : [];

    const sectionManeuvers = actions.map((a: any) => ({
      instruction: a.instruction ?? "",
      distance_km: Number((a.length ?? 0) / 1000),
      duration_s: Number(a.duration ?? 0),
      street_names: extractStreetNames(a),
    }));

    distance_km += Number((summary.length ?? 0) / 1000);
    duration_s += Number(summary.duration ?? 0);
    maneuvers.push(...sectionManeuvers);
    notices.push(...sectionNotices);
    streets_sequence.push(
      ...sectionManeuvers
      .flatMap((m) => m.street_names)
      .filter(Boolean)
    );
  });

  if (coords.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  const bbox = computeBBox(coords);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords },
        properties: {
          leg_index: 0,
          summary: { distance_km, duration_s },
          maneuvers,
          streets_sequence,
          notices,
          ...(bbox ? { bbox } : {}),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Meta builder
// ---------------------------------------------------------------------------

function buildMeta(
  ok: boolean,
  avoidCount: number,
  dropped: number,
  notices: HereNotice[],
  timeoutMsUsed: number,
  statusMessage: string | null = null
) {
  return {
    ok,
    avoid_count: avoidCount,
    dropped_avoids: dropped,
    raw_status: null, // HERE has no numeric status code like Valhalla
    raw_status_message: statusMessage,
    has_trip: ok,
    has_alternates: false, // updated by caller
    notices,
    timeout_ms_used: timeoutMsUsed,
  };
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;

  console.log("[HERE IN]", {
    alternates: body?.alternates,
    escape_mode: body?.escape_mode,
    exclude_polygons_count: Array.isArray(body?.exclude_polygons)
      ? body.exclude_polygons.length
      : 0,
  });

  // --- Validate start / end ---
  let start: Coords | null = normalizeCoords(body.start);
  let end: Coords | null = normalizeCoords(body.end);
  const vias: Coords[] = Array.isArray(body.vias)
    ? body.vias.map((coord: any) => normalizeCoords(coord)).filter(Boolean) as Coords[]
    : [];

  if ((!start || !end) && Array.isArray(body.locations) && body.locations.length >= 2) {
    const a = body.locations[0];
    const b = body.locations[1];
    start = start ?? normalizeCoords([a?.lon ?? a?.lng, a?.lat]);
    end = end ?? normalizeCoords([b?.lon ?? b?.lng, b?.lat]);
  }

  if (
    !start || !end ||
    !Number.isFinite(start[0]) || !Number.isFinite(start[1]) ||
    !Number.isFinite(end[0]) || !Number.isFinite(end[1])
  ) {
    return NextResponse.json(
      {
        meta: buildMeta(false, 0, 0, [], 0, "INVALID_START_END: Start oder Ziel fehlen oder sind ungültig."),
        geojson: { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      },
      { status: 400 }
    );
  }

  const vehicle: VehicleSpec = body.vehicle ?? {};

  // --- Build avoid areas ---
  const srcAvoid: any[] = body.exclude_polygons ?? body.avoid_polygons ?? [];
  const avoidGeoms: any[] = Array.isArray(srcAvoid) ? srcAvoid : [];
  const { value: avoidAreasParam, used: avoidUsed, dropped: avoidDropped } =
    buildAvoidAreas(avoidGeoms);

  // --- Build HERE query parameters ---
  // HERE expects: origin=lat,lon  destination=lat,lon
  // Note: start/end are stored as [lon, lat] — swap for HERE
  const params = new URLSearchParams({
    transportMode: "truck",
    origin: `${start[1]},${start[0]}`,
    destination: `${end[1]},${end[0]}`,
    "return": "polyline,summary,actions,instructions",
    lang: body.directions_language || "de-DE",
    apikey: process.env.HERE_API_KEY ?? "",
  });

  for (const via of vias) {
    params.append("via", `${via[1]},${via[0]}`);
  }

  // Vehicle dimensions: HERE expects weight in kg, dimensions in cm
  if (vehicle.weight_t != null) {
    params.set("truck[grossWeight]", String(Math.round(vehicle.weight_t * 1000)));
  }
  if (vehicle.width_m != null) {
    params.set("truck[width]", String(Math.round(vehicle.width_m * 100)));
  }
  if (vehicle.height_m != null) {
    params.set("truck[height]", String(Math.round(vehicle.height_m * 100)));
  }
  if (vehicle.axleload_t != null) {
    params.set("truck[axleWeight]", String(Math.round(vehicle.axleload_t * 1000)));
  }

  // Alternatives: HERE uses `alternatives` (0 = only main route)
  const altsRaw = body.alternates != null ? Number(body.alternates) : 1;
  const alternatives = Math.max(0, Math.min(6, Number.isFinite(altsRaw) ? altsRaw : 0));
  if (alternatives > 0) {
    params.set("alternatives", String(alternatives));
  }

  // Avoid areas (appended separately — URLSearchParams encodes `|` which HERE
  // requires unencoded, so we append to the URL string manually below)
  const timeoutMs = Math.min(
    typeof body.timeout_ms === "number" && body.timeout_ms > 0
      ? body.timeout_ms
      : HERE_DEFAULT_TIMEOUT_MS,
    20_000
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build URL — avoid[areas] must NOT be percent-encoded (HERE requires raw `|` and `;`)
    let url = `${HERE_ROUTER_URL}?${params.toString()}`;
    if (avoidAreasParam) {
      // append manually to prevent URLSearchParams from encoding `|` and `;`
      url += `&avoid[areas]=${avoidAreasParam}`;
    }

    console.log("[HERE] request url (truncated):", url.slice(0, 300));

    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    const rawText = await res.text().catch(() => "");
    let parsed: any = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch { parsed = null; }

    if (!res.ok || !parsed) {
      const errMsg =
        parsed?.cause ??
        parsed?.title ??
        parsed?.message ??
        rawText?.slice(0, 200) ??
        `HTTP ${res.status}`;

      console.error("[HERE] error response:", res.status, errMsg);

      return NextResponse.json({
        meta: buildMeta(false, avoidUsed, avoidDropped, [], timeoutMs, errMsg),
        geojson: { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      });
    }

    const routes: any[] = Array.isArray(parsed.routes) ? parsed.routes : [];

    if (!routes.length) {
      return NextResponse.json({
        meta: buildMeta(false, avoidUsed, avoidDropped, [], timeoutMs, "HERE: Keine Route gefunden."),
        geojson: { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      });
    }

    // Collect all notices across all sections of the primary route
    const primaryNotices: HereNotice[] = (routes[0]?.sections ?? []).flatMap(
      (s: any) => (Array.isArray(s.notices) ? s.notices : [])
    );

    const geojson = hereRouteToGeoJSON(routes[0]);
    const geojson_alts = routes.slice(1).map((r: any) => hereRouteToGeoJSON(r));

    console.log("[HERE OUT]", {
      ok: true,
      features: geojson.features.length,
      alternates: geojson_alts.length,
      avoid_count: avoidUsed,
      dropped_avoids: avoidDropped,
      notices: primaryNotices.length,
      distance_km: geojson.features[0]?.properties?.summary?.distance_km ?? null,
    });

    return NextResponse.json({
      meta: {
        ...buildMeta(true, avoidUsed, avoidDropped, primaryNotices, timeoutMs),
        has_alternates: geojson_alts.length > 0,
      },
      geojson,
      geojson_alts,
    });

  } catch (e: any) {
    const msg = String(e);
    const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
    console.error("[HERE ERROR]", isAbort ? "TIMEOUT" : msg);

    return NextResponse.json({
      meta: buildMeta(
        false,
        avoidUsed,
        avoidDropped,
        [],
        timeoutMs,
        isAbort ? "HERE_TIMEOUT" : msg
      ),
      geojson: { type: "FeatureCollection", features: [] },
      geojson_alts: [] as any[],
    });
  } finally {
    clearTimeout(timer);
  }
}
