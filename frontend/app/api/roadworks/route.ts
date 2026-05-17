// src/app/api/roadworks/route.ts
import { NextResponse } from "next/server";
import { decode as decodeFlexPolyline } from "@here/flexpolyline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BBox = [number, number, number, number];

type DbRoadworkRow = {
  id?: string | null;
  external_id?: string | null;
  title?: string | null;
  description?: string | null;
  kind?: string | null;
  source?: string | null;
  subsource?: string | null;
  network?: string | null;
  region?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  max_weight_t?: number | null;
  max_axle_t?: number | null;
  max_height_m?: number | null;
  max_width_m?: number | null;
  urban?: boolean | null;
  length_km?: number | null;
  display_type?: string | null;
  provider_feature_id?: string | null;
  provider_numeric_id?: number | null;
  geom?: {
    type?: string;
    coordinates?: unknown;
  } | null;
};

function isBBox(x: any): x is BBox {
  return (
    Array.isArray(x) &&
    x.length === 4 &&
    x.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    x[0] < x[2] &&
    x[1] < x[3]
  );
}

/** SRID=4326;POLYGON((minx miny, maxx miny, maxx maxy, minx maxy, minx miny)) */
function bboxToWkt4326(b: BBox): string {
  const [minx, miny, maxx, maxy] = b;
  const ring = [
    `${minx} ${miny}`,
    `${maxx} ${miny}`,
    `${maxx} ${maxy}`,
    `${minx} ${maxy}`,
    `${minx} ${miny}`,
  ].join(", ");
  return `SRID=4326;POLYGON((${ring}))`;
}

function emptyFC(meta: any) {
  return { type: "FeatureCollection", features: [] as any[], meta };
}

function walkCoordinates(value: unknown, visitor: (lng: number, lat: number) => void) {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  ) {
    visitor(Number(value[0]), Number(value[1]));
    return;
  }
  for (const child of value) walkCoordinates(child, visitor);
}

function geometryBounds(geom: DbRoadworkRow["geom"]): BBox | null {
  if (!geom?.coordinates) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  walkCoordinates(geom.coordinates, (lng, lat) => {
    if (lng < minX) minX = lng;
    if (lng > maxX) maxX = lng;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  });

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return [minX, minY, maxX, maxY];
}

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function isActiveAt(row: DbRoadworkRow, ts: string): boolean {
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return true;
  const fromMs = row.valid_from ? Date.parse(row.valid_from) : NaN;
  const toMs = row.valid_to ? Date.parse(row.valid_to) : NaN;
  if (Number.isFinite(fromMs) && fromMs > tsMs) return false;
  if (Number.isFinite(toMs) && toMs < tsMs) return false;
  return true;
}

function isMachineRoadworkTitle(title: string | null | undefined): boolean {
  const value = String(title ?? "").trim();
  return !value || /^ROADWORKS__/i.test(value);
}

function buildRoadworkTitle(row: DbRoadworkRow): string {
  if (!isMachineRoadworkTitle(row.title)) return String(row.title).trim();

  const network = String(row.network ?? "").toLowerCase();
  if (network === "urban") return "WFS-Baustelle (innerstädtisch)";
  if (network === "interstate") return "WFS-Baustelle (überregional)";
  return "WFS-Baustelle";
}

function roadworkKey(feature: any): string {
  const p = feature?.properties ?? {};
  const geometryType = String(feature?.geometry?.type ?? p._geom_type ?? "unknown").toLowerCase();
  return [
    String(p.source ?? "unknown"),
    String(p.external_id ?? p.provider_feature_id ?? p.id ?? ""),
    geometryType,
  ].join("::");
}

function rowToRoadworkFeature(row: DbRoadworkRow): any | null {
  if (!row.geom?.type || !row.geom?.coordinates) return null;

  const pointCoords =
    row.geom.type === "Point" && Array.isArray(row.geom.coordinates) && row.geom.coordinates.length >= 2
      ? [Number(row.geom.coordinates[0]), Number(row.geom.coordinates[1])]
      : null;

  return {
    type: "Feature",
    geometry: row.geom,
    properties: {
      id: row.external_id ?? row.id ?? null,
      external_id: row.external_id ?? row.id ?? null,
      title: buildRoadworkTitle(row),
      description: row.description ?? null,
      kind: row.kind ?? "roadwork",
      source: row.source ?? "verkehr_nrw_wfs",
      subsource: row.subsource ?? null,
      network: row.network ?? null,
      region: row.region ?? null,
      valid_from: row.valid_from ?? null,
      valid_to: row.valid_to ?? null,
      max_weight_t: row.max_weight_t ?? null,
      max_axle_t: row.max_axle_t ?? null,
      max_height_m: row.max_height_m ?? null,
      max_width_m: row.max_width_m ?? null,
      urban: row.urban ?? null,
      display_type: row.display_type ?? null,
      provider_feature_id: row.provider_feature_id ?? null,
      provider_numeric_id: row.provider_numeric_id ?? null,
      length_m: typeof row.length_km === "number" && Number.isFinite(row.length_km) ? row.length_km * 1000 : null,
      _hard_block: false,
      _icon_lon: pointCoords ? pointCoords[0] : null,
      _icon_lat: pointCoords ? pointCoords[1] : null,
    },
  };
}

async function fetchAdditionalWfsRoadworks(args: {
  supabaseUrl: string;
  serviceKey: string;
  ts: string;
  bbox: BBox | null;
  only_motorways: boolean;
}) {
  const { supabaseUrl, serviceKey, ts, bbox, only_motorways } = args;
  const params = new URLSearchParams();
  params.set(
    "select",
    [
      "id",
      "external_id",
      "title",
      "description",
      "kind",
      "source",
      "subsource",
      "network",
      "region",
      "valid_from",
      "valid_to",
      "max_weight_t",
      "max_axle_t",
      "max_height_m",
      "max_width_m",
      "urban",
      "length_km",
      "display_type",
      "provider_feature_id",
      "provider_numeric_id",
      "geom",
    ].join(",")
  );
  params.set("source", "eq.verkehr_nrw_wfs");
  params.set("kind", "eq.roadwork");
  params.set("limit", "5000");

  const response = await fetch(`${supabaseUrl}/rest/v1/road_restrictions?${params.toString()}`, {
    method: "GET",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false as const,
      error: text.slice(0, 300) || `WFS_ROADWORKS_HTTP_${response.status}`,
      rows: [] as DbRoadworkRow[],
    };
  }

  let rows: DbRoadworkRow[] = [];
  try {
    const parsed = text ? JSON.parse(text) : [];
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { ok: false as const, error: "WFS_ROADWORKS_JSON_PARSE_FAILED", rows: [] as DbRoadworkRow[] };
  }

  const filteredRows = rows.filter((row) => {
    if (!isActiveAt(row, ts)) return false;
    if (bbox) {
      const bounds = geometryBounds(row.geom);
      if (!bounds || !bboxOverlaps(bounds, bbox)) return false;
    }
    if (only_motorways) {
      const network = String(row.network ?? "").toLowerCase();
      return network === "interstate" || isMotorwayByProps(row);
    }
    return true;
  });

  return { ok: true as const, error: null, rows: filteredRows };
}

/**
 * Motorway-Erkennung: nur anhand des `network`-Felds oder source-Feldes,
 * NICHT anhand von external_id (die haben alle Einträge).
 */
function isMotorwayByProps(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  const network = String(p.network ?? "").toLowerCase();
  if (network === "autobahn" || network.includes("autobahn")) return true;
  if (p.source_system && String(p.source_system).toLowerCase().includes("autobahn")) return true;
  if (p.source && String(p.source).toLowerCase().includes("autobahn")) return true;
  return false;
}

/**
 * Normalisiert und validiert Limit-Werte aus der DB.
 * - Liest direkt aus DB-Spalten (neue RPC liefert max_width_m etc. korrekt)
 * - Fallback: Freitext-Extraktion wenn DB-Wert fehlt
 * - Plausibilitätsprüfung: verhindert Einheitenfehler (cm statt m etc.)
 */
function enrichFeatureProperties(f: any): any {
  if (!f || !f.properties) return f;
  const p = f.properties;

  // Direkt aus DB-Spalten lesen (neue RPC liefert diese korrekt)
  let width  = p.max_width_m  != null ? Number(p.max_width_m)  : null;
  let height = p.max_height_m != null ? Number(p.max_height_m) : null;
  let weight = p.max_weight_t != null ? Number(p.max_weight_t) : null;
  let axle   = p.max_axle_t   != null ? Number(p.max_axle_t)   : null;

  // Ungültige Zahlen auf null setzen
  if (!Number.isFinite(width))  width  = null;
  if (!Number.isFinite(height)) height = null;
  if (!Number.isFinite(weight)) weight = null;
  if (!Number.isFinite(axle))   axle   = null;

  // Fallback: Freitext-Extraktion wenn DB-Wert fehlt
  const text = `${p.title || ""} ${p.description || ""} ${p.reason || ""} ${p.subtitle || ""}`;

  if (width === null) {
    const m =
      text.match(/(?:Breite|Durchfahrtsbreite|Fahrstreifenbreite|width)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|Durchfahrtsbreite|Fahrstreifenbreite|width)/i);
    if (m) width = parseFloat(m[1].replace(",", "."));
  }

  if (weight === null) {
    const m = text.match(/(?:Gewicht|weight|Last|last)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i);
    if (m) weight = parseFloat(m[1].replace(",", "."));
  }

  if (height === null) {
    const m = text.match(/(?:Höhe|Hoehe|height)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i);
    if (m) height = parseFloat(m[1].replace(",", "."));
  }

  // Plausibilitätsprüfung – fängt Einheitenfehler (z.B. cm statt m) ab
  // und entfernt physikalisch unsinnige Werte
  if (width  !== null && (width  <= 0 || width  > 30  || !Number.isFinite(width)))  width  = null;
  if (height !== null && (height <= 0 || height > 15  || !Number.isFinite(height))) height = null;
  if (weight !== null && (weight <= 0 || weight > 500 || !Number.isFinite(weight))) weight = null;
  if (axle   !== null && (axle   <= 0 || axle   > 100 || !Number.isFinite(axle)))   axle   = null;

  // Zurückschreiben – immer, auch wenn null (überschreibt alte fehlerhafte Werte)
  f.properties.max_width_m  = width;
  f.properties.max_height_m = height;
  f.properties.max_weight_t = weight;
  f.properties.max_axle_t   = axle;

  // Debug-Logging: nur wenn tatsächlich ein Limit vorhanden ist
  if (width !== null || weight !== null || height !== null || axle !== null) {
    console.log("[ENRICH] limit found:", {
      id:           p.external_id ?? p.roadwork_id ?? null,
      kind:         p.kind        ?? null,
      max_width_m:  width,
      max_height_m: height,
      max_weight_t: weight,
      max_axle_t:   axle,
    });
  }

  return f;
}

const AUTOBAHN_ROADS = [
  "A1","A2","A3","A4","A5","A6","A7","A8","A9","A10","A11","A12","A13","A14","A15","A17","A19",
  "A20","A21","A23","A24","A25","A26","A27","A28","A29","A30","A31","A33","A37","A38","A39",
  "A40","A42","A43","A44","A45","A46","A48","A49","A57","A59","A60","A61","A62","A63","A64",
  "A65","A66","A67","A70","A71","A72","A73","A81","A92","A93","A94","A95","A96","A98","A99",
];

type RoadworkGeometryResult = {
  coords: [number, number][];
  source: "here" | "ors" | "osrm";
};

function validLineCoords(coords: unknown): coords is [number, number][] {
  return Array.isArray(coords) && coords.length >= 2 && coords.every((coord) => isGermanyLngLat(coord));
}

async function fetchHereGeometry(lng1: number, lat1: number, lng2: number, lat2: number): Promise<[number, number][] | null> {
  const apiKey = process.env.HERE_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      transportMode: "truck",
      origin: `${lat1},${lng1}`,
      destination: `${lat2},${lng2}`,
      return: "polyline",
      apikey: apiKey,
    });
    const res = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const sections = Array.isArray(data?.routes?.[0]?.sections) ? data.routes[0].sections : [];
    const coords: [number, number][] = [];
    for (const section of sections) {
      const encoded = section?.polyline;
      if (typeof encoded !== "string" || !encoded) continue;
      const decoded = decodeFlexPolyline(encoded)?.polyline ?? [];
      for (const point of decoded) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const coord: [number, number] = [Number(point[1]), Number(point[0])];
        if (!isGermanyLngLat(coord)) continue;
        const prev = coords[coords.length - 1];
        if (prev && Math.abs(prev[0] - coord[0]) < 1e-7 && Math.abs(prev[1] - coord[1]) < 1e-7) continue;
        coords.push(coord);
      }
    }
    return coords.length >= 2 ? coords : null;
  } catch {
    return null;
  }
}

async function fetchOrsGeometry(lng1: number, lat1: number, lng2: number, lat2: number): Promise<[number, number][] | null> {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-hgv/geojson", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5500),
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        coordinates: [
          [lng1, lat1],
          [lng2, lat2],
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const coords = data?.features?.[0]?.geometry?.coordinates;
    return validLineCoords(coords) ? coords : null;
  } catch {
    return null;
  }
}

async function fetchOsrmGeometry(lng1: number, lat1: number, lng2: number, lat2: number): Promise<[number, number][] | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (
      Array.isArray(coords) &&
      coords.length >= 2 &&
      coords.every((coord: unknown) => isGermanyLngLat(coord))
    ) {
      return coords as [number, number][];
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchRoadworkGeometry(lng1: number, lat1: number, lng2: number, lat2: number): Promise<RoadworkGeometryResult | null> {
  const providers: Array<["here" | "ors" | "osrm", () => Promise<[number, number][] | null>]> = [
    ["here", () => fetchHereGeometry(lng1, lat1, lng2, lat2)],
    ["ors", () => fetchOrsGeometry(lng1, lat1, lng2, lat2)],
    ["osrm", () => fetchOsrmGeometry(lng1, lat1, lng2, lat2)],
  ];

  for (const [source, load] of providers) {
    const coords = await load();
    if (coords && coords.length >= 2) return { coords, source };
  }

  return null;
}

function isGermanyLngLat(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  return Number.isFinite(lng) && Number.isFinite(lat) && lng >= 4 && lng <= 16 && lat >= 46 && lat <= 56;
}

function endpointScore(pair: [[number, number], [number, number]], center: [number, number]) {
  const [lng, lat] = center;
  return Math.min(
    Math.abs(pair[0][0] - lng) + Math.abs(pair[0][1] - lat),
    Math.abs(pair[1][0] - lng) + Math.abs(pair[1][1] - lat)
  );
}

function parseAutobahnExtent(extent: unknown, center: [number, number]): [[number, number], [number, number]] | null {
  if (typeof extent !== "string" || !extent.trim()) return null;
  const parts = extent.split(",").map(Number);
  if (parts.length < 4 || !parts.every(Number.isFinite)) return null;

  const [a, b, c, d] = parts;
  const candidates: [[number, number], [number, number]][] = [
    [[a, b], [c, d]], // lng,lat,lng,lat
    [[b, a], [d, c]], // lat,lng,lat,lng
  ];

  const valid = candidates
    .filter((candidate) => candidate.every(isGermanyLngLat))
    .filter((candidate) => Math.abs(candidate[0][0] - candidate[1][0]) + Math.abs(candidate[0][1] - candidate[1][1]) > 0.0001)
    .sort((left, right) => endpointScore(left, center) - endpointScore(right, center));

  return valid[0] ?? null;
}

async function fetchAutobahnRoadworks(args: { ts: string; bbox: BBox | null; only_motorways: boolean }) {
  const { ts, bbox } = args;
  const tsMs = ts ? Date.parse(ts) : NaN;

  const results = await Promise.allSettled(
    AUTOBAHN_ROADS.map(async (road) => {
      const res = await fetch(`https://verkehr.autobahn.de/o/autobahn/${road}/services/roadworks`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!res || !res.ok || res.status === 204) return [];
      return (await res.json().catch(() => ({}))).roadworks ?? [];
    })
  );

  const seen = new Set<string>();
  type ValidRw = { id: string; rw: any; lat: number; lng: number; extentPair: [[number, number], [number, number]] | null };
  const validRoadworks: ValidRw[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const rw of result.value) {
      const id = String(rw?.identifier ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);

      if (Number.isFinite(tsMs)) {
        const fromMs = rw.startTimestamp ? Date.parse(rw.startTimestamp) : NaN;
        const toMs   = rw.endTimestamp   ? Date.parse(rw.endTimestamp)   : NaN;
        if (Number.isFinite(fromMs) && fromMs > tsMs) continue;
        if (Number.isFinite(toMs)   && toMs   < tsMs) continue;
      }

      const lat = parseFloat(rw.coordinate?.lat ?? "");
      const lng = parseFloat(rw.coordinate?.long ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      if (bbox) {
        const [minx, miny, maxx, maxy] = bbox;
        if (lng < minx || lng > maxx || lat < miny || lat > maxy) continue;
      }

      let extentPair: [[number, number], [number, number]] | null = null;
      extentPair = parseAutobahnExtent(rw.extent, [lng, lat]);

      validRoadworks.push({ id, rw, lat, lng, extentPair });
    }
  }

  // Fetch road-following geometry from multiple providers. Never draw raw
  // extent endpoints as a line; they create false straight segments at low zoom.
  const rawLimit = Number(process.env.ROADWORKS_GEOMETRY_LIMIT ?? 80);
  const geometryLimit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(rawLimit, 160)) : 80;
  const geometryById = new Map<string, RoadworkGeometryResult>();
  const withExtent = validRoadworks.filter((r) => r.extentPair !== null).slice(0, geometryLimit);

  const geometryResults = await Promise.allSettled(
    withExtent.map(async ({ id, extentPair }) => {
      const [[lng1, lat1], [lng2, lat2]] = extentPair!;
      const geometry = await fetchRoadworkGeometry(lng1, lat1, lng2, lat2);
      return { id, geometry };
    })
  );

  for (const r of geometryResults) {
    if (r.status === "fulfilled" && r.value.geometry) geometryById.set(r.value.id, r.value.geometry);
  }

  const features: any[] = [];

  for (const { id, rw, lat, lng, extentPair } of validRoadworks) {
    const baseProps = {
      id, external_id: id,
      title: String(rw.title ?? "Baustelle"),
      description: Array.isArray(rw.description) ? rw.description.join("\n") : String(rw.description ?? ""),
      kind: "roadwork", source: "autobahn_api", network: "autobahn",
      valid_from: rw.startTimestamp ?? null, valid_to: rw.endTimestamp ?? null,
      _hard_block: rw.isBlocked === true, _icon_lon: lng, _icon_lat: lat,
    };

    const routedGeometry = geometryById.get(id);
    if (routedGeometry?.coords?.length >= 2) {
      const { _icon_lon: _a, _icon_lat: _b, ...lineProps } = baseProps as any;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: routedGeometry.coords },
        properties: { ...lineProps, _geom_type: "line", _geometry_source: `${routedGeometry.source}_route` },
      });
    }

    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { ...baseProps, _geom_type: "point" } });
  }

  return { type: "FeatureCollection" as const, features: features.map(enrichFeatureProperties) };
}

export async function POST(req: Request) {
  const metaBase: any = { source: "roadworks_merged", status: "OK" };

  try {
    const body = await req.json().catch(() => ({}));
    const ts: string | undefined = body?.ts;
    const tz: string = body?.tz || "Europe/Berlin";
    const bbox: BBox | null = isBBox(body?.bbox) ? body.bbox : null;
    const only_motorways: boolean = !!body?.only_motorways;

    const requested =
      typeof body?.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 12_000;
    const timeoutMs = Math.min(requested, 15_000);

    if (!ts) {
      return NextResponse.json(
        emptyFC({ ...metaBase, ts, tz, rw_bbox: bbox, only_motorways, error: "Missing 'ts' (ISO-UTC)" }),
        { status: 400 }
      );
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return NextResponse.json(emptyFC({ ...metaBase, error: "ENV missing" }), { status: 500 });
    }

    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_active_roadworks_geojson`;
    const rpcPayload: Record<string, any> = { _ts: ts, _tz: tz };
    // _bbox als WKT mit SRID übergeben – PostGIS akzeptiert das als geometry
    if (bbox) rpcPayload._bbox = bboxToWkt4326(bbox);

    console.log("[ROADWORKS] calling RPC + WFS parallel", {
      ts,
      tz,
      bbox,
      only_motorways,
      timeoutMs,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // RPC und WFS-Abfrage parallel starten
    const rpcPromise = fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(rpcPayload),
      cache: "no-store",
      signal: controller.signal,
    }).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text().catch(() => "") }))
      .catch((e: any) => ({ ok: false as const, status: 0, text: "", error: e }));

    const wfsPromise = fetchAdditionalWfsRoadworks({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_ROLE,
      ts,
      bbox,
      only_motorways,
    });

    let rpcResult: { ok: boolean; status: number; text: string; error?: any };
    let wfsResult: Awaited<ReturnType<typeof fetchAdditionalWfsRoadworks>>;

    try {
      [rpcResult, wfsResult] = await Promise.all([rpcPromise, wfsPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (rpcResult.error) {
      const isAbort = rpcResult.error?.name === "AbortError" || String(rpcResult.error).toLowerCase().includes("abort");
      console.error("[ROADWORKS] RPC fetch failed:", isAbort ? "TIMEOUT" : String(rpcResult.error));
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          status: "FAILED",
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          error: isAbort ? "RPC_TIMEOUT" : "RPC_FETCH_FAILED",
          timed_out: isAbort,
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    }

    const { ok: rpcOk, status: rpcStatus, text } = rpcResult;

    if (!rpcOk) {
      let errBody: any = {};
      try { errBody = JSON.parse(text); } catch { /* ignore */ }
      if (errBody?.code === "PGRST205" || errBody?.code === "42883" || rpcStatus === 404) {
        console.warn("[ROADWORKS] Supabase RPC not found — falling back to Autobahn API");
        const fallback = await fetchAutobahnRoadworks({ ts, bbox, only_motorways });
        return NextResponse.json({
          ...fallback,
          meta: { ...metaBase, status: "OK", ts, tz, rw_bbox: bbox, only_motorways, fetched: fallback.features.length, used: fallback.features.length, source: "autobahn_api", timeout_ms_used: timeoutMs },
        });
      }
      console.error("[ROADWORKS] RPC HTTP error:", rpcStatus, text.slice(0, 300));
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          status: "FAILED",
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          rpc_status: rpcStatus,
          error: "RPC failed",
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    }

    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      console.error("[ROADWORKS] JSON parse failed, raw:", text.slice(0, 300));
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          status: "FAILED",
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          error: "RPC JSON parse failed",
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    }

    // Die neue RPC gibt direkt ein json-Objekt zurück (kein Array)
    let rawFeatures: any[] = [];
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed?.features)) {
      rawFeatures = parsed.features;
    } else if (Array.isArray(parsed)) {
      // Fallback für alte RPC-Variante
      rawFeatures = parsed;
    } else if (parsed && typeof parsed === "object") {
      // Supabase RPC gibt manchmal das Objekt direkt zurück
      if (Array.isArray(parsed?.features)) {
        rawFeatures = parsed.features;
      }
    }

    console.log("[ROADWORKS] fetched features:", rawFeatures.length);

    const enrichedFeatures = rawFeatures.map(enrichFeatureProperties);

    if (!wfsResult.ok) {
      console.warn("[ROADWORKS] WFS roadworks fetch failed:", wfsResult.error);
    }

    const wfsFeatures = wfsResult.ok
      ? wfsResult.rows.map(rowToRoadworkFeature).filter(Boolean).map(enrichFeatureProperties)
      : [];

    const mergedByKey = new Map<string, any>();
    for (const feature of [...enrichedFeatures, ...wfsFeatures]) {
      mergedByKey.set(roadworkKey(feature), feature);
    }

    let usedFeatures = Array.from(mergedByKey.values());
    if (only_motorways) {
      usedFeatures = usedFeatures.filter((f) => {
        const network = String(f?.properties?.network ?? "").toLowerCase();
        return network === "interstate" || isMotorwayByProps(f?.properties);
      });
    }

    // Zähle wie viele Features tatsächlich Limits haben (für Debugging)
    const withLimits = usedFeatures.filter(
      (f) => f?.properties?.max_width_m != null || f?.properties?.max_weight_t != null
    ).length;

    console.log("[ROADWORKS] result:", {
      fetched: rawFeatures.length,
      fetched_wfs: wfsFeatures.length,
      used: usedFeatures.length,
      with_limits: withLimits,
      only_motorways,
    });

    return NextResponse.json(
      {
        type: "FeatureCollection",
        features: usedFeatures,
        meta: {
          ...metaBase,
          status: "OK",
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          fetched: rawFeatures.length,
          fetched_wfs: wfsFeatures.length,
          used: usedFeatures.length,
          with_limits: withLimits,
          timeout_ms_used: timeoutMs,
        },
      },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[ROADWORKS] unhandled error:", e);
    return NextResponse.json(
      emptyFC({ ...metaBase, status: "FAILED", error: String(e?.message || e) }),
      { status: 200 }
    );
  }
}
