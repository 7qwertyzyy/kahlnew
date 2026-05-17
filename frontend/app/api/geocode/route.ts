// src/app/api/geocode/route.ts
import { NextRequest, NextResponse } from "next/server";

const ORS_BASE = "https://api.openrouteservice.org";
const ORS_KEY = process.env.ORS_API_KEY!;
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

// Hilfsfunktionen
function ok(data: unknown, init: number = 200) {
  return NextResponse.json(data, { status: init });
}
function bad(msg: string, init: number = 400) {
  return ok({ error: msg }, init);
}

async function fetchORSJson(url: string) {
  const r = await fetch(url, { headers: { Authorization: ORS_KEY } });
  if (!r.ok) throw new Error(`ORS_${r.status}`);
  return r.json();
}

async function fetchNominatimSearch(params: {
  q: string;
  size: number;
  focusLon?: string | null;
  focusLat?: string | null;
  left?: string | null;
  top?: string | null;
  right?: string | null;
  bottom?: string | null;
}) {
  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(params.size));
  url.searchParams.set("q", params.q);
  url.searchParams.set("countrycodes", "de");
  if (params.focusLon && params.focusLat) {
    url.searchParams.set("lon", params.focusLon);
    url.searchParams.set("lat", params.focusLat);
  }
  if (params.left && params.top && params.right && params.bottom) {
    url.searchParams.set("viewbox", `${params.left},${params.top},${params.right},${params.bottom}`);
  }
  const r = await fetch(url, {
    headers: {
      "User-Agent": "route-mvp/0.1 (demo)",
      "Accept-Language": "de",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`NOMINATIM_${r.status}`);
  return r.json();
}

/**
 * GET /api/geocode?q=Adresse   -> vorwärts
 * GET /api/geocode?lon=..&lat=.. -> rückwärts
 * Antwort: { lon, lat, label }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const lon = searchParams.get("lon");
  const lat = searchParams.get("lat");
  const suggest = searchParams.get("suggest") === "1";
  const size = Math.max(1, Math.min(10, Number(searchParams.get("size") || 1)));
  const focusLon = searchParams.get("focus_lon");
  const focusLat = searchParams.get("focus_lat");
  const left = searchParams.get("left");
  const top = searchParams.get("top");
  const right = searchParams.get("right");
  const bottom = searchParams.get("bottom");

  try {
    if (q) {
      let items: Array<{ lon: number; lat: number; label: string; raw: any }> = [];

      try {
        const url = new URL(`${ORS_BASE}/geocode/search`);
        url.searchParams.set("text", q);
        url.searchParams.set("size", String(suggest ? size : 1));
        url.searchParams.set("lang", "de");
        url.searchParams.set("boundary.country", "DE");
        if (focusLon && focusLat) {
          url.searchParams.set("focus.point.lon", focusLon);
          url.searchParams.set("focus.point.lat", focusLat);
        }
        if (left && top && right && bottom) {
          url.searchParams.set("boundary.rect.min_lon", left);
          url.searchParams.set("boundary.rect.max_lon", right);
          url.searchParams.set("boundary.rect.min_lat", bottom);
          url.searchParams.set("boundary.rect.max_lat", top);
        }
        const j = await fetchORSJson(url.toString());
        const features = Array.isArray(j?.features) ? j.features : [];
        items = features
          .map((f: any) => ({
            lon: Number(f?.geometry?.coordinates?.[0]),
            lat: Number(f?.geometry?.coordinates?.[1]),
            label: f?.properties?.label || q,
            raw: f,
          }))
          .filter((item: any) => Number.isFinite(item.lon) && Number.isFinite(item.lat));
      } catch {
        const j = await fetchNominatimSearch({
          q,
          size: suggest ? size : 1,
          focusLon,
          focusLat,
          left,
          top,
          right,
          bottom,
        });
        items = (Array.isArray(j) ? j : [])
          .map((row: any) => ({
            lon: Number(row?.lon),
            lat: Number(row?.lat),
            label: row?.display_name || q,
            raw: row,
          }))
          .filter((item: any) => Number.isFinite(item.lon) && Number.isFinite(item.lat));
      }

      if (!items.length) return bad("Keine Treffer für Adresse.");
      if (suggest) return ok({ items });
      return ok(items[0]);
    }

    if (lon && lat) {
      // Rückwärts-Geocoding
      let label = `${lon},${lat}`;
      try {
        const url = `${ORS_BASE}/geocode/reverse?point.lon=${lon}&point.lat=${lat}&size=1&lang=de`;
        const j = await fetchORSJson(url);
        const f = j.features?.[0];
        label = f?.properties?.label || label;
      } catch {
        const url = new URL(`${NOMINATIM_BASE}/reverse`);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("lon", lon);
        url.searchParams.set("lat", lat);
        const r = await fetch(url, {
          headers: {
            "User-Agent": "route-mvp/0.1 (demo)",
            "Accept-Language": "de",
            Accept: "application/json",
          },
        });
        if (r.ok) {
          const j = await r.json();
          label = j?.display_name || label;
        }
      }
      return ok({ lon: Number(lon), lat: Number(lat), label });
    }

    return bad("Parameter fehlen. Nutze ?q=… oder ?lon=…&lat=…");
  } catch (e: any) {
    return bad(e?.message || "Unbekannter Fehler", 500);
  }
}
