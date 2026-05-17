// src/app/api/roadworks/route.ts
import { NextResponse } from "next/server";

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
  return [
    String(p.source ?? "unknown"),
    String(p.external_id ?? p.provider_feature_id ?? p.id ?? ""),
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
      text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|width|breite)/i);
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

    console.log("[ROADWORKS] calling RPC", {
      ts,
      tz,
      bbox,
      only_motorways,
      timeoutMs,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    let text = "";

    try {
      resp = await fetch(rpcUrl, {
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
      });

      text = await resp.text().catch(() => "");
    } catch (e: any) {
      const msg = String(e);
      const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
      console.error("[ROADWORKS] RPC fetch failed:", isAbort ? "TIMEOUT" : msg);
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
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      console.error("[ROADWORKS] RPC HTTP error:", resp.status, text.slice(0, 300));
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          status: "FAILED",
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          rpc_status: resp.status,
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

    const wfsResult = await fetchAdditionalWfsRoadworks({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_ROLE,
      ts,
      bbox,
      only_motorways,
    });

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
