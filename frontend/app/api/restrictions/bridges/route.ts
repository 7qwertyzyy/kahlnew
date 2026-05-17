import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BRIDGE_SOURCES = ["bab_bridges", "nrw_bridges"] as const;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type BridgeRow = {
  id?: string | null;
  external_id?: string | null;
  title?: string | null;
  description?: string | null;
  source?: string | null;
  kind?: string | null;
  no_heavy_transport?: boolean | null;
  max_weight_t?: number | null;
  max_axle_t?: number | null;
  max_width_m?: number | null;
  max_height_m?: number | null;
  network?: string | null;
  region?: string | null;
  geom?: {
    type?: string;
    coordinates?: unknown;
  } | null;
};

function featureCenter(geom: BridgeRow["geom"]): [number, number] | null {
  if (!geom) return null;

  if (geom.type === "Point" && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    const lng = Number(geom.coordinates[0]);
    const lat = Number(geom.coordinates[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }

  const ring =
    geom.type === "Polygon"
      ? (geom.coordinates as unknown[][][] | undefined)?.[0]
      : geom.type === "MultiPolygon"
        ? (geom.coordinates as unknown[][][][] | undefined)?.[0]?.[0]
        : null;

  if (!Array.isArray(ring) || ring.length === 0) return null;

  let sumLng = 0;
  let sumLat = 0;
  let count = 0;

  for (const coord of ring) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const lng = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    sumLng += lng;
    sumLat += lat;
    count++;
  }

  return count > 0 ? [sumLng / count, sumLat / count] : null;
}

function buildQuery(offset: number) {
  const select = [
    "id",
    "external_id",
    "title",
    "description",
    "source",
    "kind",
    "no_heavy_transport",
    "max_weight_t",
    "max_axle_t",
    "max_width_m",
    "max_height_m",
    "network",
    "region",
    "geom",
  ].join(",");

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("source", `in.(${BRIDGE_SOURCES.join(",")})`);
  params.set(
    "or",
    "(no_heavy_transport.is.true,max_weight_t.not.is.null,max_axle_t.not.is.null,max_width_m.not.is.null,max_height_m.not.is.null)"
  );
  params.set("order", "source.asc,title.asc");
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  return params.toString();
}

export async function GET(req: NextRequest) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;
  const geometryMode = req.nextUrl.searchParams.get("geometry") === "full";

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json({ error: "Supabase credentials missing" }, { status: 500 });
  }

  const baseUrl = `${SUPABASE_URL}/rest/v1/road_restrictions`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: "application/json",
  };

  const rows: BridgeRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const response = await fetch(`${baseUrl}?${buildQuery(offset)}`, {
      headers,
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let errBody: any = {};
      try { errBody = JSON.parse(text); } catch { /* ignore */ }
      if (errBody?.code === "PGRST205" || errBody?.code === "42P01" || response.status === 404) {
        console.warn("[BRIDGES] table not found in Supabase — returning empty");
        return NextResponse.json({ type: "FeatureCollection", features: [] });
      }
      return NextResponse.json(
        {
          error: text.slice(0, 300) || "bridge_table_query_failed",
          status: response.status,
          offset,
        },
        { status: 500 }
      );
    }

    const batch = (await response.json().catch(() => [])) as BridgeRow[];
    rows.push(...batch);

    if (batch.length < PAGE_SIZE) break;
  }

  const features = rows
    .map((row) => {
      const center = featureCenter(row.geom);
      if (!geometryMode && !center) return null;

      return {
        type: "Feature" as const,
        geometry: geometryMode
          ? row.geom
          : {
              type: "Point" as const,
              coordinates: center,
            },
        properties: {
          id: row.id ?? null,
          external_id: row.external_id ?? null,
          title: row.title ?? "Bruecke",
          description: row.description ?? null,
          source: row.source ?? null,
          kind: row.kind ?? null,
          no_heavy_transport: row.no_heavy_transport === true,
          max_weight_t: row.max_weight_t ?? null,
          max_axle_t: row.max_axle_t ?? null,
          max_width_m: row.max_width_m ?? null,
          max_height_m: row.max_height_m ?? null,
          network: row.network ?? null,
          region: row.region ?? null,
        },
      };
    })
    .filter((feature): feature is NonNullable<typeof feature> => Boolean(feature?.geometry));

  const heavyCount = features.filter((feature) => feature.properties.no_heavy_transport === true).length;
  const numericOnlyCount = features.length - heavyCount;

  console.log("[BRIDGES API] loaded bridge restrictions", {
    total_rows: rows.length,
    total_features: features.length,
    heavy_transport_bans: heavyCount,
    numeric_only: numericOnlyCount,
    sample: features.slice(0, 5).map((feature) => ({
      external_id: feature.properties.external_id,
      title: feature.properties.title,
      source: feature.properties.source,
      no_heavy_transport: feature.properties.no_heavy_transport,
    })),
    geometry_mode: geometryMode ? "full" : "point",
  });

  return NextResponse.json({
    type: "FeatureCollection",
    features,
    meta: {
      total: features.length,
      heavy_transport_bans: heavyCount,
      numeric_only: numericOnlyCount,
    },
  });
}
