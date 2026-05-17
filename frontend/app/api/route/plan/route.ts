// src/app/api/route/plan/route.ts
import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import { lineString, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, Polygon } from "geojson";

import { validateRoute, restrictionId } from "../../../../services/routing/route-validator";
import { escalatePolygon } from "../../../../services/routing/polygon-generator";
import type { RestrictionPolygon, VehicleSpec } from "../../../../services/routing/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

type Coords = [number, number];

type PlanReq = {
  start: Coords;
  end: Coords;
  vias?: Coords[];
  via_mode?: "split_legs" | "pass_through";
  vehicle?: {
    width_m?: number;
    height_m?: number;
    weight_t?: number;
    axleload_t?: number;
    hazmat?: boolean;
  };
  ts?: string;
  tz?: string;
  corridor?: { width_m?: number };
  roadworks?: { buffer_m?: number; only_motorways?: boolean };
  alternates?: number;
  directions_language?: string;
  avoid_target_max?: number;
  routing_max_avoids?: number;
  valhalla_soft_max?: number;  // deprecated alias
  respect_direction?: boolean;
  require_clean?: boolean;
  debug?: boolean;
  heavy_transport?: boolean;  // NEU: Schwertransport-Flag
};

type RestrictionsTelemetry = {
  status: "OK" | "PARTIAL" | "FAILED" | "SKIPPED";
  boxes_total: number;
  boxes_ok: number;
  boxes_failed: number;
  timeout_ms: number;
  buffer_m: number;
  fetched: number;
  used: number;
  notes: string | null;
  errors?: string[];
};

type Candidate = {
  route: FeatureCollection;
  blockingWarnings: any[];
  roadworksHits: number;
  distance_km: number;
  meta: { bbox_km: number | null; avoids_applied: number; fallback_used: boolean };
};

// ---------------------------------------------------------------------------
// Geo-Hilfsfunktionen
// ---------------------------------------------------------------------------

function makeSafeBBox(start: Coords, end: Coords, bufferKm: number): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line, bufferKm, { units: "kilometers" })!;
  return bboxFn(buffered) as [number, number, number, number];
}

function haversineKm(a: Coords, b: Coords) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) * Math.sin(dLon / 2));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function getRouteCoords(route: FeatureCollection): Coords[] {
  try {
    const toCoords = (arr: any): Coords[] => {
      if (!Array.isArray(arr)) return [];
      if (arr.length && Array.isArray(arr[0]) && arr[0].length === 2 && typeof arr[0][0] === "number")
        return arr as Coords[];
      return [];
    };
    // Alle Features zusammenführen (HERE kann mehrere Sektionen als separate Features liefern)
    const out: Coords[] = [];
    for (const f of (route?.features ?? [])) {
      const g: any = f?.geometry;
      if (!g) continue;
      if (g.type === "LineString") out.push(...toCoords(g.coordinates));
      else if (g.type === "MultiLineString") {
        for (const line of (g.coordinates as any[])) out.push(...toCoords(line));
      }
    }
    return out;
  } catch { return []; }
}

function extractDistanceKm(fc: FeatureCollection): number {
  try {
    const f: any = fc?.features?.[0];
    const d = f?.properties?.summary?.distance_km;
    return typeof d === "number" ? d : Number(d || 0);
  } catch { return 0; }
}

function pickResponseGeojson(data: any): FeatureCollection | null {
  return data?.geojson ?? data?.geojosn ?? data?.geoJson ?? null;
}

function mergeRouteCollections(routes: FeatureCollection[]): FeatureCollection {
  const coords: Coords[] = [];
  const maneuvers: any[] = [];
  const streets: string[] = [];
  const notices: any[] = [];
  let distanceKm = 0;
  let durationS = 0;

  for (const route of routes) {
    const routeCoords = getRouteCoords(route);
    for (const coord of routeCoords) {
      const prev = coords[coords.length - 1];
      if (!prev || prev[0] !== coord[0] || prev[1] !== coord[1]) coords.push(coord);
    }
    for (const feature of route?.features ?? []) {
      const props: any = feature?.properties ?? {};
      distanceKm += Number(props?.summary?.distance_km ?? 0);
      durationS += Number(props?.summary?.duration_s ?? 0);
      if (Array.isArray(props?.maneuvers)) maneuvers.push(...props.maneuvers);
      if (Array.isArray(props?.streets_sequence)) streets.push(...props.streets_sequence);
      if (Array.isArray(props?.notices)) notices.push(...props.notices);
    }
  }

  if (coords.length < 2) return { type: "FeatureCollection", features: [] };

  const bbox = bboxFn(lineString(coords)) as [number, number, number, number];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          leg_index: 0,
          summary: { distance_km: distanceKm, duration_s: durationS },
          maneuvers,
          streets_sequence: streets,
          notices,
          bbox,
        },
      },
    ],
  };
}

/** Gesamtschwere aller Konflikte: Summe von (Fahrzeugwert − erlaubter Wert).
 *  Kleinerer Score = weniger kritische Einschränkungen = bevorzugte Route. */
function conflictSeverityScore(warnings: any[]): number {
  return warnings.reduce((sum, w) => {
    if (w?.block_reason === "HEAVY_TRANSPORT_BAN") {
      return sum + 100000;
    }
    if (w?.block_reason === "CLOSED") {
      return sum + 50000;
    }
    if (w?.vehicle_value != null && w?.allowed_value != null) {
      return sum + Math.max(0, Number(w.vehicle_value) - Number(w.allowed_value));
    }
    return sum + 9999; // unbekannter Schweregrad = schlechtester Fall
  }, 0);
}

function countReason(warnings: any[], reason: string): number {
  return warnings.filter((w) => String(w?.block_reason ?? "").toUpperCase() === reason).length;
}

function pickBetterCandidate(a: Candidate | null, b: Candidate | null) {
  if (!a) return b;
  if (!b) return a;
  // Route mit echter Restriktionsinfo bevorzugen gegenüber RESTRICTIONS_UNAVAILABLE
  // (d.h. eine Route mit bekanntem Konflikt ist informativer als eine ungeprüfte Route)
  const aUnavail = a.blockingWarnings.some((w: any) => w?.block_reason === "RESTRICTIONS_UNAVAILABLE");
  const bUnavail = b.blockingWarnings.some((w: any) => w?.block_reason === "RESTRICTIONS_UNAVAILABLE");
  if (!aUnavail && bUnavail && a.route?.features?.length) return a;
  if (aUnavail && !bUnavail && b.route?.features?.length) return b;
  const aClean = a.blockingWarnings.length === 0;
  const bClean = b.blockingWarnings.length === 0;
  if (bClean && !aClean) return b;
  if (aClean && !bClean) return a;
  // Schwertransportverbote sind die wichtigste Restmetrik:
  // eine Route mit 1 HT-Ban ist besser als eine mit vielen HT-Bans,
  // auch wenn andere numerische Konflikte dagegen geringer erscheinen.
  const aHtBans = countReason(a.blockingWarnings, "HEAVY_TRANSPORT_BAN");
  const bHtBans = countReason(b.blockingWarnings, "HEAVY_TRANSPORT_BAN");
  if (bHtBans < aHtBans) return b;
  if (bHtBans > aHtBans) return a;
  // Danach zählen echte Sperrungen allgemein
  const aClosed = countReason(a.blockingWarnings, "CLOSED");
  const bClosed = countReason(b.blockingWarnings, "CLOSED");
  if (bClosed < aClosed) return b;
  if (bClosed > aClosed) return a;
  // Bevorzuge Route mit weniger Konflikten
  if (b.blockingWarnings.length < a.blockingWarnings.length) return b;
  if (b.blockingWarnings.length > a.blockingWarnings.length) return a;
  // Bei gleicher Konfliktanzahl: bevorzuge Route mit kleinstem Gesamtüberschuss
  // (z.B. 9m-Baustelle besser als 7m-Baustelle für ein 10m-Fahrzeug)
  const aSev = conflictSeverityScore(a.blockingWarnings);
  const bSev = conflictSeverityScore(b.blockingWarnings);
  if (bSev < aSev) return b;
  if (bSev > aSev) return a;
  if (b.roadworksHits < a.roadworksHits) return b;
  if (b.roadworksHits > a.roadworksHits) return a;
  if (b.distance_km > 0 && a.distance_km > 0) {
    if (b.distance_km < a.distance_km) return b;
    if (b.distance_km > a.distance_km) return a;
  }
  return a;
}

function chunkRouteToBBoxes(coords: Coords[], chunkKm: number, overlapKm: number, expandKm: number) {
  if (!Array.isArray(coords) || coords.length < 2) return [] as [number, number, number, number][];
  const out: [number, number, number, number][] = [];
  let startIdx = 0, acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversineKm(coords[i - 1], coords[i]);
    if (acc >= chunkKm) {
      const slice = coords.slice(startIdx, i + 1);
      const ls = lineString(slice);
      const bb = bboxFn(buffer(ls, expandKm, { units: "kilometers" })!) as [number, number, number, number];
      out.push(bb);
      let back = 0, j = i;
      while (j > 0 && back < overlapKm) { back += haversineKm(coords[j - 1], coords[j]); j--; }
      startIdx = Math.max(0, j);
      acc = 0;
    }
  }
  const tail = coords.slice(startIdx);
  if (tail.length >= 2) {
    const ls = lineString(tail);
    const bb = bboxFn(buffer(ls, expandKm, { units: "kilometers" })!) as [number, number, number, number];
    out.push(bb);
  }
  const seen = new Set<string>();
  return out.filter((b) => {
    const k = b.map((x) => x.toFixed(3)).join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function featureBounds(geometry: any): [number, number, number, number] | null {
  try {
    if (!geometry?.type) return null;
    const coords: [number, number][] = [];
    const visit = (value: any) => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        coords.push([Number(value[0]), Number(value[1])]);
        return;
      }
      for (const item of value) visit(item);
    };
    visit(geometry.coordinates);
    if (!coords.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  } catch {
    return null;
  }
}

function bboxOverlaps(a: [number, number, number, number], b: [number, number, number, number]) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function toRestrictionPolygonsFromBridgeFeature(feature: any): RestrictionPolygon[] {
  if (!feature?.geometry) return [];
  const properties = {
    ...(feature.properties ?? {}),
    kind: feature?.properties?.kind ?? "heavy_transport_ban",
  };

  try {
    if (feature.geometry.type === "Polygon") {
      return [{ type: "Feature", geometry: feature.geometry, properties } as RestrictionPolygon];
    }

    if (feature.geometry.type === "MultiPolygon" && Array.isArray(feature.geometry.coordinates)) {
      return feature.geometry.coordinates
        .filter((coords: any) => Array.isArray(coords))
        .map((coords: any) => ({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: coords },
          properties,
        }) as RestrictionPolygon);
    }

    const baseBufferKm =
      feature.geometry.type === "Point" ? 0.04 :
      feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString" ? 0.035 :
      0.04;
    const buffered = buffer(feature as any, baseBufferKm, { units: "kilometers" });
    if (!buffered) return [];
    (buffered as any).properties = properties;
    return [buffered as RestrictionPolygon];
  } catch {
    return [];
  }
}

function pickSpreadBoxes<T>(arr: T[], max: number): T[] {
  if (!Array.isArray(arr) || arr.length <= max) return arr;
  if (max <= 1) return [arr[0]];
  const out: T[] = [];
  const n = arr.length;
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (n - 1)) / (max - 1));
    out.push(arr[idx]);
  }
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeRestrictions(lists: RestrictionPolygon[][], cap: number): RestrictionPolygon[] {
  const out: RestrictionPolygon[] = [];
  const seen = new Set<string>();
  for (const feats of lists) {
    for (const f of feats) {
      const id = restrictionId(f);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(f);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function safeSlice<T>(arr: T[], n: number) {
  return Array.isArray(arr) ? arr.slice(0, Math.max(0, n)) : [];
}

function summarizeAvoids(polys: Feature<Polygon>[], max = 5) {
  return safeSlice(polys, max).map((p) => {
    const pr: any = p.properties || {};
    return {
      id:    pr.id ?? pr.external_id ?? null,
      title: pr.title ?? null,
      bbox:  (() => { try { return bboxFn(p as any); } catch { return null; } })(),
    };
  });
}

function summarizeBlockingWarnings(warns: any[], max = 8) {
  return safeSlice(warns, max).map((w) => ({
    title:           w?.title          ?? null,
    block_reason:    w?.block_reason   ?? null,
    limits:          w?.limits         ?? null,
    already_avoided: Boolean(w?.already_avoided),
    network:         w?.network        ?? null,
  }));
}

/** Wandelt RouteConflicts in das blockingWarnings-Format für das Frontend um */
function conflictsToWarnings(
  conflicts: ReturnType<typeof validateRoute>["conflicts"],
  avoidMap: Map<string, Feature<Polygon>>
): any[] {
  return conflicts.map((c) => {
    const isHtBan = c.reason === "heavy_transport_ban";
    const baseSeverity = (c.vehicleValue != null && c.allowedValue != null)
      ? Math.max(0, Number(c.vehicleValue) - Number(c.allowedValue))
      : null;
    return {
      title:            c.restriction.properties?.title ?? "Restriktion",
      description:      c.restriction.properties?.description ?? null,
      limits: {
        width:  c.restriction.properties?.max_width_m  ?? null,
        weight: c.restriction.properties?.max_weight_t ?? null,
        height: c.restriction.properties?.max_height_m ?? null,
        axle:   c.restriction.properties?.max_axle_t   ?? null,
      },
      block_reason:     c.reason.toUpperCase(),
      vehicle_value:    c.vehicleValue,
      allowed_value:    c.allowedValue,
      // HT-Ban hat immer maximale Severity → BLOCKED-Status wird erzwungen
      severity:         isHtBan ? 9999 : baseSeverity,
      network:          c.restriction.properties?.network ?? null,
      restriction_kind: c.restriction.properties?.kind    ?? null,
      no_heavy_transport: Boolean(c.restriction.properties?.no_heavy_transport),
      coords:           null,
      already_avoided:  avoidMap.has(c.restrictionId),
    };
  });
}

function normalizeBlockingWarnings(warnings: any[]): any[] {
  const grouped = new Map<string, any[]>();
  for (const warning of warnings) {
    const key = `${warning?.title ?? ""}|${warning?.network ?? ""}`;
    const current = grouped.get(key) ?? [];
    current.push(warning);
    grouped.set(key, current);
  }

  const normalized: any[] = [];
  for (const group of grouped.values()) {
    const heavy = group.find((warning) => warning?.block_reason === "HEAVY_TRANSPORT_BAN");
    if (heavy) {
      normalized.push(heavy);
      continue;
    }
    const closed = group.find((warning) => warning?.block_reason === "CLOSED");
    if (closed) {
      normalized.push(closed);
      continue;
    }
    const bestNumeric = group.reduce((best, current) => {
      if (!best) return current;
      const bestDelta = typeof best?.severity === "number" ? best.severity : Number.POSITIVE_INFINITY;
      const currentDelta = typeof current?.severity === "number" ? current.severity : Number.POSITIVE_INFINITY;
      return currentDelta < bestDelta ? current : best;
    }, null as any);
    if (bestNumeric) normalized.push(bestNumeric);
  }

  return normalized;
}

function getHereRouteCandidates(res: any): FeatureCollection[] {
  const primary = res?.geojson?.features?.length ? [res.geojson as FeatureCollection] : [];
  const alts = Array.isArray(res?.geojson_alts)
    ? res.geojson_alts.filter((fc: any) => Array.isArray(fc?.features) && fc.features.length > 0)
    : [];
  return [...primary, ...alts];
}

function buildCandidateFromRoute(params: {
  route: FeatureCollection;
  validationPolys: RestrictionPolygon[];
  restrictions: RestrictionPolygon[];
  vehicle: VehicleSpec;
  heavyTransport?: boolean;
  avoidMap: Map<string, Feature<Polygon>>;
  bboxKm: number | null;
  fallbackUsed: boolean;
}): Candidate {
  const routeCoords = getRouteCoords(params.route);
  const effectivePolys = params.validationPolys.length ? params.validationPolys : params.restrictions;
  const { conflicts } = validateRoute(routeCoords, effectivePolys, params.vehicle, params.heavyTransport);
  const blockingWarnings = normalizeBlockingWarnings(conflictsToWarnings(conflicts, params.avoidMap));
  return {
    route: params.route,
    blockingWarnings,
    roadworksHits: conflicts.length,
    distance_km: extractDistanceKm(params.route),
    meta: {
      bbox_km: params.bboxKm,
      avoids_applied: params.avoidMap.size,
      fallback_used: params.fallbackUsed,
    },
  };
}

function pickBestHereCandidate(params: {
  res: any;
  validationPolys: RestrictionPolygon[];
  restrictions: RestrictionPolygon[];
  vehicle: VehicleSpec;
  heavyTransport?: boolean;
  avoidMap: Map<string, Feature<Polygon>>;
  bboxKm: number | null;
  fallbackUsed: boolean;
}): Candidate | null {
  let best: Candidate | null = null;
  for (const route of getHereRouteCandidates(params.res)) {
    const candidate = buildCandidateFromRoute({
      route,
      validationPolys: params.validationPolys,
      restrictions: params.restrictions,
      vehicle: params.vehicle,
      heavyTransport: params.heavyTransport,
      avoidMap: params.avoidMap,
      bboxKm: params.bboxKm,
      fallbackUsed: params.fallbackUsed,
    });
    best = pickBetterCandidate(best, candidate);
  }
  return best;
}

function conflictPriorityTuple(conflict: any): [number, number, number, string] {
  const reason = String(conflict?.reason ?? "");
  const allowed = Number(conflict?.allowedValue ?? 0);
  const vehicle = Number(conflict?.vehicleValue ?? 0);
  const delta = Number.isFinite(vehicle) && Number.isFinite(allowed) ? Math.max(0, vehicle - allowed) : 0;

  if (reason === "heavy_transport_ban") return [0, -delta, 0, String(conflict?.restrictionId ?? "")];
  if (reason === "closed") return [1, -delta, 0, String(conflict?.restrictionId ?? "")];
  return [2, -delta, 0, String(conflict?.restrictionId ?? "")];
}

// ---------------------------------------------------------------------------
// Fetch-Helper
// ---------------------------------------------------------------------------

async function fetchJSONSafe(
  url: string,
  body: any,
  timeoutMs: number,
  forwardedHeaders?: Record<string, string>
): Promise<{ ok: boolean; status: number; data: any | null; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(forwardedHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const status = res.status;
    const text = await res.text().catch(() => "");
    let parsed: any = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    if (!parsed) return { ok: false, status, data: null, text, error: res.ok ? "NON_JSON_RESPONSE" : "HTTP_ERROR_NON_JSON" };
    return { ok: res.ok, status, data: parsed, text };
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "");
    const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
    return { ok: false, status: 0, data: null, text: "", error: isAbort ? "ABORT_TIMEOUT" : `FETCH_FAILED:${msg}` };
  } finally { clearTimeout(timer); }
}

function buildInternalForwardHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const cookie = req.headers.get("cookie");
  if (cookie) out.cookie = cookie;

  const authorization = req.headers.get("authorization");
  if (authorization) out.authorization = authorization;

  const vercelBypass = req.headers.get("x-vercel-protection-bypass");
  if (vercelBypass) out["x-vercel-protection-bypass"] = vercelBypass;

  const vercelSetBypass = req.headers.get("x-vercel-set-bypass-cookie");
  if (vercelSetBypass) out["x-vercel-set-bypass-cookie"] = vercelSetBypass;

  return out;
}

// ---------------------------------------------------------------------------
// API-Aufrufe
// ---------------------------------------------------------------------------

async function callHERE(
  origin: string,
  reqBody: any,
  avoidPolys: Feature<Polygon>[],
  timeoutMs: number,
  escape_mode: boolean = false,
  alternates_override?: number,
  forwardedHeaders?: Record<string, string>
) {
  const polys = avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined;
  const avoidDebug = avoidPolys?.length
    ? avoidPolys.slice(0, 5).map((p) => {
        try {
          const b = bboxFn(p as any);
          return { bbox: b.map((x: number) => Number(x.toFixed(4))), title: (p as any)?.properties?.title ?? null };
        } catch { return { bbox: null, title: (p as any)?.properties?.title ?? null }; }
      })
    : [];

  const payload = {
    ...reqBody,
    escape_mode:      escape_mode ? true : undefined,
    alternates:       typeof alternates_override === "number" ? alternates_override : reqBody?.alternates,
    exclude_polygons: polys,
  };

  console.log("[PLAN->HERE]", {
    escape_mode:            payload.escape_mode ?? false,
    alternates:             payload.alternates,
    exclude_polygons_count: Array.isArray(payload.exclude_polygons) ? payload.exclude_polygons.length : 0,
    avoid_sample_bboxes:    avoidDebug,
    timeoutMs,
  });

  const out = await fetchJSONSafe(`${origin}/api/route/here`, payload, timeoutMs, forwardedHeaders);
  if (out.ok && out.data) return out.data;
  return {
    geojson: { type: "FeatureCollection", features: [] },
    error: out.error ? `${out.error} (status=${out.status})` : "HERE_ERROR",
    raw: out.text ? out.text.slice(0, 200) : undefined,
  };
}

async function callPrecheck(origin: string, payload: any, timeoutMs: number, forwardedHeaders?: Record<string, string>) {
  const out = await fetchJSONSafe(`${origin}/api/route/precheck`, payload, timeoutMs, forwardedHeaders);
  if (out.ok && out.data) return { ok: true, data: out.data };
  return {
    ok: false,
    data: out.data ?? { status: "WARN", error: out.error ?? "PRECHECK_FAILED" },
  };
}

/**
 * Lädt aktive Restriktionen (Baustellen + Brücken) aus /api/restrictions.
 * Die RPC get_active_restrictions_fc filtert bereits nach Fahrzeugmaßen:
 *   - Nur Einträge mit max_width_m < veh_width_m werden zurückgegeben
 *   - Nur Einträge mit max_weight_t < veh_weight_t werden zurückgegeben
 * Die zurückgegebenen Geometrien sind bereits in PostGIS gepuffert (buffer_m).
 */
async function callRestrictions(
  origin: string,
  body: {
    ts: string;
    tz: string;
    bbox: [number, number, number, number];
    vehicle?: VehicleSpec;
    buffer_m?: number;
  },
  timeoutMs: number,
  forwardedHeaders?: Record<string, string>
): Promise<{ ok: boolean; features: RestrictionPolygon[]; meta?: any; error?: string; status: number }> {
  const payload = {
    ts:           body.ts,
    tz:           body.tz,
    bbox:         body.bbox,
    buffer_m:     body.buffer_m ?? 60,   // 60m Standardpuffer um Liniensegmente
    max_polygons: 300,
    vehicle:      body.vehicle,
    timeout_ms:   timeoutMs,
  };

  console.log("[PLAN->RESTRICTIONS]", {
    bbox:     body.bbox.map((x) => x.toFixed(3)).join(","),
    buffer_m: payload.buffer_m,
    vehicle:  body.vehicle,
    timeoutMs,
  });

  const out = await fetchJSONSafe(`${origin}/api/restrictions`, payload, timeoutMs, forwardedHeaders);
  if (out.ok && out.data) {
    const fc = out.data?.geojson;
    const feats: RestrictionPolygon[] = Array.isArray(fc?.features) ? fc.features : [];
    console.log("[RESTRICTIONS] loaded:", feats.length, "features");
    return { ok: true, features: feats, meta: out.data?.meta, status: out.status };
  }
  const errDetail = out.data?.error || out.data?.message || out.data?.hint || out.text?.slice(0, 200) || out.error || "RESTRICTIONS_FAILED";
  console.warn("[RESTRICTIONS] failed:", errDetail, "status:", out.status, "data:", JSON.stringify(out.data)?.slice(0, 300));
  return { ok: false, features: [], error: errDetail, status: out.status };
}

/**
 * Lädt Baustellen aus /api/roadworks (inkl. enrichFeatureProperties Text-Extraktion).
 * Wird NUR für die Validierung verwendet, NICHT für HERE avoid[areas].
 */
async function callRoadworks(
  origin: string,
  body: { ts: string; tz: string; bbox: [number, number, number, number] },
  timeoutMs: number,
  forwardedHeaders?: Record<string, string>
): Promise<{ ok: boolean; features: any[] }> {
  const out = await fetchJSONSafe(`${origin}/api/roadworks`, {
    ts: body.ts, tz: body.tz, bbox: body.bbox, only_motorways: false, timeout_ms: timeoutMs,
  }, timeoutMs, forwardedHeaders);
  if (out.ok && out.data) {
    const feats = Array.isArray(out.data?.features) ? out.data.features : [];
    console.log("[ROADWORKS-VAL] loaded:", feats.length, "features");
    return { ok: true, features: feats };
  }
  return { ok: false, features: [] };
}

async function callHeavyTransportBanPolygons(
  origin: string,
  bbox: [number, number, number, number],
  timeoutMs: number,
  forwardedHeaders?: Record<string, string>
): Promise<{ ok: boolean; features: RestrictionPolygon[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data: any = null;
  try {
    const res = await fetch(`${origin}/api/restrictions/bridges?geometry=full`, {
      method: "GET",
      headers: { Accept: "application/json", ...(forwardedHeaders ?? {}) },
      cache: "no-store",
      signal: controller.signal,
    });
    data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return { ok: false, features: [], error: data?.error ?? `HT_BAN_BRIDGES_HTTP_${res.status}` };
    }
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "HT_BAN_BRIDGES_TIMEOUT" : `HT_BAN_BRIDGES_FAILED:${String(e?.message ?? e)}`;
    return { ok: false, features: [], error: msg };
  } finally {
    clearTimeout(timer);
  }

  const [minX, minY, maxX, maxY] = bbox;
  const rawFeatures = Array.isArray(data?.features) ? data.features : [];
  const filtered = rawFeatures.filter((f: any) => {
    if (f?.properties?.no_heavy_transport !== true) return false;
    const geomBbox = featureBounds(f?.geometry);
    if (!geomBbox) return false;
    return bboxOverlaps(geomBbox, [minX, minY, maxX, maxY]);
  });

  const polygons = filtered.flatMap((f: any) => toRestrictionPolygonsFromBridgeFeature(f));

  console.log("[HT-BAN] validation polygons loaded:", {
    bbox: bbox.map((x) => Number(x.toFixed(3))),
    features: filtered.length,
    polygons: polygons.length,
  });

  return { ok: true, features: polygons };
}

/**
 * Konvertiert Baustellen-Features (Point/LineString, text-enriched) in Validierungs-Polygone.
 * Filtert nur Features wo das Fahrzeug das Limit verletzt.
 * Diese Polygone werden NUR für validateRoute() verwendet, NICHT als HERE avoid[areas].
 */
function buildRoadworkValidationPolygons(
  features: any[],
  vehicle: VehicleSpec,
  bufferM: number
): RestrictionPolygon[] {
  const out: RestrictionPolygon[] = [];
  for (const f of features) {
    if (!f?.geometry || !f?.properties) continue;
    const p = f.properties;
    const hasConflict =
      (p.max_width_m  != null && vehicle.width_m    != null && vehicle.width_m    > p.max_width_m)  ||
      (p.max_weight_t != null && vehicle.weight_t   != null && vehicle.weight_t   > p.max_weight_t) ||
      (p.max_height_m != null && vehicle.height_m   != null && vehicle.height_m   > p.max_height_m) ||
      (p.max_axle_t   != null && vehicle.axleload_t != null && vehicle.axleload_t > p.max_axle_t);
    if (!hasConflict) continue;
    try {
      const buffered = buffer(f, bufferM / 1000, { units: "kilometers" });
      if (!buffered) continue;
      // _rw_-Prefix verhindert Deduplizierung gegen gleichnamige Restriction-Polygone in
      // mergeRestrictions → beide Quellen werden in validateRoute geprüft.
      const srcId = String(p.id ?? p.external_id ?? JSON.stringify(f.geometry?.coordinates ?? "").slice(0, 60));
      buffered.properties = { ...p, id: `_rw_${srcId}`, _rw_source: true };
      out.push(buffered as unknown as RestrictionPolygon);
    } catch {
      continue;
    }
  }
  console.log("[ROADWORKS-VAL] validation polygons built:", out.length);
  return out;
}

// ---------------------------------------------------------------------------
// Validierungs-Iterations-Loop
//
// Implementiert das Herzstück: Validate-and-Retry.
// Für jede Iteration:
//   1. HERE aufrufen (mit aktuellen Avoid-Polygonen)
//   2. Route gegen Restriktionen validieren (exakte Linie-Polygon-Prüfung)
//   3. Konflikte → Avoid-Polygone hinzufügen/eskalieren
//   4. Wiederholen bis sauber oder Limit erreicht
// ---------------------------------------------------------------------------

async function runIterationLoop(params: {
  restrictions:          RestrictionPolygon[];
  /** Kombinierte Polygone für validateRoute (restrictions + roadworks text-enriched). Defaults to restrictions. */
  validationPolys?:      RestrictionPolygon[];
  vehicle:               VehicleSpec;
  initialBest:           Candidate;
  IS_WIDE:               boolean;
  MAX_AVOIDS_EFFECTIVE:  number;
  MAX_ITERATIONS:        number;
  MAX_NEW_AVOIDS_PER_ITER: number;
  baseHERETimeout:       number;
  maxHERETimeout:        number;
  timeLeft:              () => number;
  bboxKm:                number | null;
  callHEREDbg:           (polys: Feature<Polygon>[], timeout: number, escape: boolean, alts: number) => Promise<any>;
  internalAlternates:    number;
  heavyTransport?:       boolean;
  /** IDs von HT-Ban-Restriktionen die NIEMALS aus avoidMap entfernt werden dürfen */
  permanentAvoidIds?:    Set<string>;
  /** Vorberechnete Polygone für permanente Avoids (werden direkt als Startpunkt gesetzt) */
  permanentAvoidPolys?:  Map<string, Feature<Polygon>>;
}): Promise<{ best: Candidate; stuckReason: string | null; iterations: number }> {
  const {
    restrictions, vehicle, initialBest, IS_WIDE,
    MAX_AVOIDS_EFFECTIVE, MAX_ITERATIONS, MAX_NEW_AVOIDS_PER_ITER,
    baseHERETimeout, maxHERETimeout, timeLeft, bboxKm, callHEREDbg,
    internalAlternates, heavyTransport, permanentAvoidIds, permanentAvoidPolys,
  } = params;

  // avoidMap: restrictionId → gepuffertes Polygon (für HERE avoid[areas])
  const avoidMap      = new Map<string, Feature<Polygon>>();
  // avoidAttempts: wie oft haben wir diese Restriktion bereits versucht zu vermeiden?
  const avoidAttempts = new Map<string, number>();

  // Permanente Avoids vorbelegen (HT-Ban-Brücken) — werden NIE entfernt
  if (permanentAvoidPolys) {
    for (const [id, poly] of permanentAvoidPolys.entries()) {
      avoidMap.set(id, poly);
      avoidAttempts.set(id, 1);
    }
  }

  let best       = initialBest;
  let stuckReason: string | null = null;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const localTimeout = Math.min(maxHERETimeout, baseHERETimeout + Math.min(2_000, iterations * 500));
    if (timeLeft() < localTimeout + 3_500) {
      stuckReason = "Zeitbudget erreicht.";
      break;
    }

    iterations++;

    const escapeNow = avoidMap.size > 0;
    const avoidsArr = Array.from(avoidMap.values());

    // ── 1. Route bei HERE berechnen ──
    const res = await callHEREDbg(avoidsArr, localTimeout, escapeNow, internalAlternates);
    const hereRoutes = getHereRouteCandidates(res);

    if (!hereRoutes.length) {
      stuckReason = res?.error ?? "Keine Route (HERE).";
      if (avoidMap.size === 0) break;
      // Letzte N Avoids entfernen und es erneut versuchen (permanente Avoids niemals entfernen)
      const keys = Array.from(avoidMap.keys()).filter((k) => !permanentAvoidIds?.has(k));
      if (keys.length === 0) break;  // nur noch permanente Avoids → keine Lösung möglich
      for (const k of keys.slice(-Math.min(IS_WIDE ? 6 : 10, keys.length))) avoidMap.delete(k);
      continue;
    }

    // ── 2. HERE-Notices prüfen ──
    const hereNotices: any[] = res?.meta?.notices ?? [];
    const violatedAvoidArea  = hereNotices.some((n: any) => n?.code === "violatedAvoidArea");

    if (violatedAvoidArea) {
      console.warn("[PLAN] violatedAvoidArea – HERE hat Avoid-Polygone ignoriert, eskaliere...");
    }

    // ── 3. Route gegen Restriktionen validieren (exakte Linie-Polygon-Prüfung) ──
    const cand = pickBestHereCandidate({
      res,
      validationPolys: params.validationPolys ?? restrictions,
      restrictions,
      vehicle,
      heavyTransport,
      avoidMap,
      bboxKm,
      fallbackUsed: false,
    });
    if (!cand) {
      stuckReason = "Keine verwertbare Route nach Kandidatenbewertung.";
      break;
    }

    console.log("[PLAN] iteration", iterations, {
      avoids:            avoidMap.size,
      route_candidates:  hereRoutes.length,
      conflicts:         cand.blockingWarnings.length,
      violatedAvoidArea,
      notices:           hereNotices.map((n: any) => n?.code ?? n?.title).filter(Boolean),
    });

    // Konflikt-Details für Iteration-Logging
    const routeCoords = getRouteCoords(cand.route);
    const { conflicts } = validateRoute(routeCoords, params.validationPolys ?? restrictions, vehicle, heavyTransport);
    for (const c of conflicts) {
      console.log("[PLAN] conflict:", {
        id:      c.restrictionId,
        reason:  c.reason,
        title:   c.restriction.properties?.title ?? null,
        vehicle: c.vehicleValue,
        allowed: c.allowedValue,
        network: c.restriction.properties?.network ?? null,
      });
    }

    best = pickBetterCandidate(best, cand)!;

    // Route ist sauber und HERE hat alle Avoids respektiert → fertig
    if (conflicts.length === 0 && !violatedAvoidArea) {
      stuckReason = null;
      break;
    }

    // ── 4. Konflikte aufteilen: neu (noch nicht in avoidMap) vs. hartnäckig ──
    const newConflicts      = conflicts.filter((c) => !avoidMap.has(c.restrictionId));
    const stillBlocked      = conflicts.filter((c) =>  avoidMap.has(c.restrictionId));

    // ── 5a. Wenn HERE ein Polygon ignoriert hat → alle bestehenden Avoids eskalieren ──
    if (violatedAvoidArea && avoidMap.size > 0) {
      for (const [id] of avoidMap.entries()) {
        const restr = restrictions.find((r) => restrictionId(r) === id);
        if (!restr) continue;
        const prev = avoidAttempts.get(id) ?? 0;
        const next = prev + 1;
        avoidAttempts.set(id, next);
        const poly = escalatePolygon(restr, next);
        if (poly) avoidMap.set(id, poly);
      }
    }

    let added = 0;
    const prioritizedNewConflicts = [...newConflicts].sort((a, b) => {
      const pa = conflictPriorityTuple(a);
      const pb = conflictPriorityTuple(b);
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return pa[3].localeCompare(pb[3]);
    });
    const maxAddsThisRound = heavyTransport
      ? Math.min(MAX_NEW_AVOIDS_PER_ITER, IS_WIDE ? 4 : 6)
      : Math.min(MAX_NEW_AVOIDS_PER_ITER, IS_WIDE ? 6 : 8);

    // ── 5b. Neue Konflikte in avoidMap aufnehmen ──
    for (const c of prioritizedNewConflicts) {
      if (avoidMap.size >= MAX_AVOIDS_EFFECTIVE) break;
      avoidAttempts.set(c.restrictionId, 1);
      // PostGIS-Restriction bevorzugen (skalierbar); sonst validationPoly direkt verwenden
      const restrSource = restrictions.find((r) => restrictionId(r) === c.restrictionId);
      const poly = escalatePolygon(restrSource ?? c.restriction, 0);
      if (poly) {
        avoidMap.set(c.restrictionId, poly);
        if (c.reason === "heavy_transport_ban") {
          permanentAvoidIds?.add(c.restrictionId);
          permanentAvoidPolys?.set(c.restrictionId, poly);
        }
        added++;
      }
      if (added >= maxAddsThisRound) break;
    }

    // ── 5c. Hartnäckige Konflikte (Route geht immer noch durch) eskalieren ──
    if (added === 0 && stillBlocked.length > 0) {
      let escalated = 0;
      for (const c of stillBlocked.slice(0, IS_WIDE ? 10 : 14)) {
        const prev = avoidAttempts.get(c.restrictionId) ?? 0;
        const next = prev + 1;
        avoidAttempts.set(c.restrictionId, next);
        const restrSource = restrictions.find((r) => restrictionId(r) === c.restrictionId);
        // Für Nicht-Restrictions (Baustellen-only): Polygon beibehalten, kein weiterer Puffer
        const poly = restrSource
          ? escalatePolygon(restrSource, next)
          : avoidMap.get(c.restrictionId) ?? null;
        if (poly) {
          avoidMap.set(c.restrictionId, poly);
          escalated++;
        }
      }
      if (escalated > 0) added = escalated;
    }

    if (added === 0 && !violatedAvoidArea) {
      stuckReason = "Keine neuen Avoid-Polygone ableitbar (alle Restriktionen bereits eskaliert).";
      break;
    }
  }

  return { best, stuckReason, iterations };
}

// ---------------------------------------------------------------------------
// Haupt-POST-Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const HARD_DEADLINE_MS = 52_000;

  try {
    const body = (await req.json().catch(() => ({}))) as PlanReq;
    const start = body.start;
    const end   = body.end;
    const vias = Array.isArray(body.vias)
      ? body.vias.filter((v): v is Coords => Array.isArray(v) && v.length === 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1])))
      : [];
    const viaMode = body.via_mode === "pass_through" ? "pass_through" : "split_legs";
    const DEBUG = Boolean((body as any)?.debug);

    if (!Array.isArray(start) || start.length !== 2 || !Array.isArray(end) || end.length !== 2) {
      return NextResponse.json(
        {
          meta: {
            source: "route/plan-stable-v2", status: "BLOCKED", clean: false,
            error: "Ungültige Eingabe: start/end fehlen oder sind nicht [lon,lat].",
          },
          restrictions: {
            status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
            timeout_ms: 0, buffer_m: 0, fetched: 0, used: 0, notes: "invalid_input",
          } as RestrictionsTelemetry,
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [], geojson_alts: [],
        },
        { status: 400 }
      );
    }

    if (vias.length > 0 && viaMode !== "pass_through") {
      const origin = req.nextUrl.origin;
      const internalForwardHeaders = buildInternalForwardHeaders(req);
      const points = [start, ...vias, end];
      const legRoutes: FeatureCollection[] = [];
      const legWarnings: any[] = [];
      const legPhases: any[] = [];
      let overallStatus: "CLEAN" | "WARN" | "BLOCKED" = "CLEAN";
      let restrictionsStatus: RestrictionsTelemetry["status"] = "OK";
      let restrictionsNotes: string[] = [];
      let totalIterationsLocal = 0;
      let totalAvoidsLocal = 0;
      let anyFallback = false;
      let lastDebugDistance = 0;

      for (let i = 0; i < points.length - 1; i++) {
        const legBody = {
          ...body,
          start: points[i],
          end: points[i + 1],
          vias: undefined,
        };
        const legRes = await fetchJSONSafe(
          `${origin}/api/route/plan`,
          legBody,
          Math.min(45_000, HARD_DEADLINE_MS),
          internalForwardHeaders
        );
        const legData = legRes.data;
        const legGeo = pickResponseGeojson(legData);

        legPhases.push({
          phase: `LEG_${i + 1}`,
          from: i === 0 ? "start" : `via_${i}`,
          to: i === points.length - 2 ? "end" : `via_${i + 1}`,
          status: legData?.meta?.status ?? (legRes.ok ? "UNKNOWN" : "ERROR"),
          conflicts: legData?.meta?.conflict_count ?? null,
        });

        if (!legRes.ok || !legGeo?.features?.length) {
          overallStatus = "BLOCKED";
          return NextResponse.json({
            meta: {
              source: "route/plan-stable-v2",
              status: "BLOCKED",
              clean: false,
              error: `Keine Route für Teilstrecke ${i + 1} gefunden.`,
              iterations: totalIterationsLocal,
              avoids_applied: totalAvoidsLocal,
              conflict_count: legWarnings.length,
              phases: legPhases,
            },
            roadworks: {
              status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
              timeout_ms: 0, buffer_m: 0, fetched: 0, used: 0, notes: "multi_leg_failed",
            } as RestrictionsTelemetry,
            restrictions: {
              status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
              timeout_ms: 0, buffer_m: 0, fetched: 0, used: 0, notes: "multi_leg_failed",
            } as RestrictionsTelemetry,
            geojson: mergeRouteCollections(legRoutes),
            blocking_warnings: legWarnings,
            geojson_alts: [],
          });
        }

        legRoutes.push(legGeo);
        lastDebugDistance += Number(legData?.debug?.route_distance_km ?? extractDistanceKm(legGeo));
        totalIterationsLocal += Number(legData?.meta?.iterations ?? 0);
        totalAvoidsLocal += Number(legData?.meta?.avoids_applied ?? 0);
        anyFallback = anyFallback || Boolean(legData?.meta?.fallback_used);

        const warnings = Array.isArray(legData?.blocking_warnings) ? legData.blocking_warnings : [];
        legWarnings.push(...warnings.map((warning: any) => ({ ...warning, leg_index: i + 1 })));

        const legRestrictions = legData?.restrictions || legData?.roadworks;
        const legRestrictionsStatus = String(legRestrictions?.status ?? "OK").toUpperCase() as RestrictionsTelemetry["status"];
        if (legRestrictionsStatus === "FAILED") restrictionsStatus = "FAILED";
        else if (legRestrictionsStatus !== "OK" && restrictionsStatus === "OK") restrictionsStatus = "PARTIAL";
        if (typeof legRestrictions?.notes === "string" && legRestrictions.notes.trim()) {
          restrictionsNotes.push(`Teilstrecke ${i + 1}: ${legRestrictions.notes.trim()}`);
        }

        if (legData?.meta?.status === "WARN") overallStatus = "WARN";
        if (legData?.meta?.status === "BLOCKED") overallStatus = "BLOCKED";
      }

      const mergedRoute = mergeRouteCollections(legRoutes);
      const restrictionsIncomplete = restrictionsStatus !== "OK";
      const clean = overallStatus === "CLEAN" && legWarnings.length === 0 && !restrictionsIncomplete;
      const status: "CLEAN" | "WARN" | "BLOCKED" =
        clean ? "CLEAN" : overallStatus === "BLOCKED" ? "BLOCKED" : "WARN";
      const error =
        status === "CLEAN"
          ? "Route ist nach aktueller Datenlage frei von erkannten Konflikten."
          : legWarnings.length === 0 && restrictionsIncomplete
          ? "⚠ Die Route wird angezeigt, konnte über alle Teilstrecken aber nicht vollständig gegen Restriktionen geprüft werden."
          : `⚠ Keine vollständig saubere Route über alle Teilstrecken gefunden. Die beste verfügbare Route mit Zwischenstopps wird angezeigt. Es verbleiben ${legWarnings.length} Restriktion(en).`;

      return NextResponse.json({
        meta: {
          source: "route/plan-stable-v2",
          status,
          clean,
          error,
          iterations: totalIterationsLocal,
          avoids_applied: totalAvoidsLocal,
          fallback_used: anyFallback,
          conflict_count: legWarnings.length,
          conflict_severity_total: conflictSeverityScore(legWarnings),
          phases: legPhases,
        },
        roadworks: {
          status: restrictionsStatus,
          boxes_total: points.length - 1,
          boxes_ok: restrictionsStatus === "OK" ? points.length - 1 : 0,
          boxes_failed: restrictionsStatus === "FAILED" ? points.length - 1 : 0,
          timeout_ms: 0,
          buffer_m: 0,
          fetched: 0,
          used: 0,
          notes: restrictionsNotes.length ? restrictionsNotes.join(" | ") : "multi_leg_aggregated",
        } as RestrictionsTelemetry,
        restrictions: {
          status: restrictionsStatus,
          boxes_total: points.length - 1,
          boxes_ok: restrictionsStatus === "OK" ? points.length - 1 : 0,
          boxes_failed: restrictionsStatus === "FAILED" ? points.length - 1 : 0,
          timeout_ms: 0,
          buffer_m: 0,
          fetched: 0,
          used: 0,
          notes: restrictionsNotes.length ? restrictionsNotes.join(" | ") : "multi_leg_aggregated",
        } as RestrictionsTelemetry,
        geojson: mergedRoute,
        blocking_warnings: legWarnings,
        geojson_alts: [],
        ...(DEBUG ? { debug: { route_distance_km: lastDebugDistance, legs: points.length - 1 } } : {}),
      });
    }

    const vWidth  = body.vehicle?.width_m  ?? 2.55;
    const vWeight = body.vehicle?.weight_t ?? 40;
    const IS_WIDE = vWidth >= 3;
    const heavyTransport = Boolean(body.heavy_transport);

    const vehicle: VehicleSpec = {
      width_m:         body.vehicle?.width_m,
      height_m:        body.vehicle?.height_m,
      weight_t:        body.vehicle?.weight_t,
      axleload_t:      body.vehicle?.axleload_t,
      heavy_transport: heavyTransport,
    };

    // require_clean: automatisch true für Schwertransporte
    const requireClean = Boolean(body.require_clean) || IS_WIDE || vWeight > 40;

    const ts = body.ts ?? new Date().toISOString();
    const tz = body.tz ?? "Europe/Berlin";

    console.log("[PLAN] request", { start, end, vWidth, vWeight, requireClean, ts });

    const t0       = Date.now();
    const timeLeft = () => HARD_DEADLINE_MS - (Date.now() - t0);

    const baseHERETimeout = vWidth >= 3 ? 10_000 : 8_000;
    const maxHERETimeout  = vWidth >= 3 ? 12_000 : 10_000;
    const internalAlternates = heavyTransport ? 3 : 2;

    const RESTRICTIONS_TIMEOUT_MS = 20_000;
    // Validierungs-Buffer: 60m reicht für zuverlässige Erkennung bei 50m-Densifizierung.
    // Größere Buffer (>60m) fangen benachbarte Parallelstraßen ein → falsch-positive Konflikte.
    // HERE-Avoidance nutzt escalatePolygon() mit eigenem Buffer-Stufensystem.
    const RESTRICTION_BUFFER_M = 60;

    const origin   = req.nextUrl.origin;
    const internalForwardHeaders = buildInternalForwardHeaders(req);
    const approxKm = haversineKm(start, end);
    // Der bisherige Schwellwert von 220 km war zu niedrig:
    // typische Deutschland-Strecken wie Moers -> Hamburg liefen dadurch
    // nur durch den Fast-Path-Shortcut. Dieser Pfad ist gut für sehr lange
    // Fernstrecken, aber zu grob für Routen, bei denen noch eine saubere
    // Alternative gefunden werden soll.
    const LONG_ROUTE_KM = 500;

    const plannerReqBase = {
      start, end,
      vias: viaMode === "pass_through" ? vias : undefined,
      vehicle:             body.vehicle,
      alternates:          internalAlternates,
      directions_language: body.directions_language ?? "de-DE",
      respect_direction:   body.respect_direction ?? true,
      end_radius_m:        300,
    };

    const phases: any[]    = [];
    let totalIterations    = 0;

    const rwTelemetry: RestrictionsTelemetry = {
      status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
      timeout_ms: RESTRICTIONS_TIMEOUT_MS,
      buffer_m: RESTRICTION_BUFFER_M, fetched: 0, used: 0, notes: null, errors: [],
    };

    const dbg: any = DEBUG
      ? { routing_calls: 0, last_routing: null as any, notes: [] as any[] }
      : null;

    const callHEREDbg = async (
      avoidPolys: Feature<Polygon>[],
      timeoutMs: number,
      escapeMode: boolean,
      alternatesOverride: number
    ) => {
      if (dbg) {
        dbg.routing_calls++;
        dbg.last_routing = {
          timeout_ms: timeoutMs, escape_mode: Boolean(escapeMode),
          avoid_count: avoidPolys.length, avoid_sample: summarizeAvoids(avoidPolys, 5),
        };
      }
      return callHERE(origin, plannerReqBase, avoidPolys, timeoutMs, escapeMode, alternatesOverride, internalForwardHeaders);
    };

    const finalizeResponse = (
      best: Candidate | null,
      extra: { bbox_km_used?: number | null; fallback_used?: boolean }
    ) => {
      const hasRoute = Boolean(best?.route?.features?.length);
      const restrictionsIncomplete = hasRoute && rwTelemetry.status !== "OK";
      const actualWarnings = best?.blockingWarnings ?? [];
      const hasWarns = hasRoute && (actualWarnings.length > 0 || restrictionsIncomplete);
      const clean    = hasRoute && !hasWarns;

      // RESTRICTIONS_UNAVAILABLE = Systemfehler, kein echter Restriktionskonflikt.
      // Route soll sichtbar bleiben (WARN), nicht blockiert werden.
      const allUnavailable =
        hasRoute &&
        restrictionsIncomplete &&
        actualWarnings.every((w: any) => w?.block_reason === "RESTRICTIONS_UNAVAILABLE");
      const status: "CLEAN" | "WARN" | "BLOCKED" =
        !hasRoute ? "BLOCKED"
        : hasWarns ? "WARN"
        : "CLEAN";

      const safetyNote =
        "Bitte die angezeigte Route vor Fahrtantritt manuell prüfen. Karten- und Restriktionsdaten können unvollständig oder veraltet sein.";

      const errorMsg =
        !hasRoute
          ? "Es konnte keine Route berechnet werden."
          : hasWarns && allUnavailable && actualWarnings.length === 0
          ? `⚠ Restriktionsdaten nicht vollständig verfügbar. Die beste verfügbare Route wird angezeigt, konnte aber nicht vollständig geprüft werden. ${safetyNote}`
          : hasWarns && allUnavailable
          ? `⚠ Restriktionsdaten nicht vollständig verfügbar. Die beste verfügbare Route wird angezeigt, konnte aber nicht vollständig geprüft werden. ${safetyNote}`
          : hasWarns
          ? `⚠ Keine vollständig saubere Route gefunden. Die nächstbeste Route wird angezeigt. Es verbleiben ${actualWarnings.length} Restriktion(en) auf der Route.${restrictionsIncomplete ? " Zusätzlich war die Restriktionsprüfung nicht vollständig." : ""} ${safetyNote}`
          : `Route ist nach aktueller Datenlage frei von erkannten Konflikten. ${safetyNote}`;

      console.log("[PLAN] finalize", {
        status, clean, requireClean,
        blocking_warnings: actualWarnings.length,
        restrictions_incomplete: restrictionsIncomplete,
        avoids_applied:    best?.meta?.avoids_applied ?? 0,
        distance_km:       best?.distance_km ?? null,
      });

      const debug = DEBUG ? {
        time_left_ms:             timeLeft(),
        approx_km:                approxKm,
        route_has_features:       hasRoute,
        route_distance_km:        best?.distance_km ?? null,
        blocking_warnings_count:  actualWarnings.length,
        blocking_warnings_sample: summarizeBlockingWarnings(actualWarnings, 8),
        avoids_applied:           best?.meta?.avoids_applied ?? 0,
        bbox_km_used:             extra.bbox_km_used ?? best?.meta?.bbox_km ?? null,
        fallback_used:            Boolean(extra.fallback_used ?? best?.meta?.fallback_used ?? false),
        routing_calls:            dbg?.routing_calls ?? 0,
        last_routing:             dbg?.last_routing ?? null,
        restrictions_status:      rwTelemetry.status,
        notes:                    dbg?.notes ?? [],
      } : undefined;

      return NextResponse.json({
        meta: {
          source:                  "route/plan-stable-v2",
          status,
          clean,
          error:                   errorMsg,
          iterations:              totalIterations,
          avoids_applied:          best?.meta?.avoids_applied ?? 0,
          bbox_km_used:            extra.bbox_km_used ?? best?.meta?.bbox_km ?? null,
          fallback_used:           Boolean(extra.fallback_used ?? best?.meta?.fallback_used ?? false),
          conflict_count:          actualWarnings.length,
          conflict_severity_total: conflictSeverityScore(actualWarnings),
          phases,
          require_clean_requested: requireClean,
          hard_deadline_ms:        HARD_DEADLINE_MS,
        },
        // "roadworks" als Alias für Backward-Compat mit Frontend
        roadworks:         rwTelemetry,
        restrictions:      rwTelemetry,
        avoid_applied:     { total: best?.meta?.avoids_applied ?? 0 },
        // Route immer mitliefern (auch bei BLOCKED), damit Frontend Konfliktstellen visualisieren kann.
        geojson:           best?.route?.features?.length ? best.route : { type: "FeatureCollection", features: [] },
        blocking_warnings: actualWarnings,
        geojson_alts:      [],
        ...(debug ? { debug } : {}),
      });
    };

    // ──────────────── PRECHECK ────────────────
    if (timeLeft() > 3_500) {
      const pre = await callPrecheck(origin, { start, end, ts, tz, vehicle: body.vehicle, roadworks: body.roadworks }, 3_000, internalForwardHeaders);
      phases.push(pre.ok && pre.data
        ? { phase: "PRECHECK", result: pre.data?.status ?? "UNKNOWN", clean: pre.data?.clean ?? null, blocking_count: pre.data?.blocking_count ?? null }
        : { phase: "PRECHECK", result: "WARN", reason: (pre.data as any)?.error ?? "Precheck failed" }
      );
    } else {
      phases.push({ phase: "PRECHECK", result: "SKIPPED", reason: "time_budget_low" });
    }

    // HERE hard limit: 20 avoid polygons
    const ROUTING_MAX_AVOIDS   = Math.max(1, Math.min(20, body.routing_max_avoids ?? body.valhalla_soft_max ?? 20));
    const MAX_AVOIDS_EFFECTIVE = Math.min(ROUTING_MAX_AVOIDS, 20);

    const corridorWidthM = body.corridor?.width_m ?? 2000;
    const corridorKm     = Math.max(6, Math.min(120, (corridorWidthM / 1000) * 6));

    // ──────────────── LÖSUNGEN FÜR LANGE STRECKEN (>= 220 km) ────────────────
    if (approxKm >= LONG_ROUTE_KM) {
      if (timeLeft() < 4_500) {
        const quickTimeout = Math.max(2_500, Math.min(6_000, timeLeft() - 1_000));
        if (quickTimeout > 2_500) {
          const resQ   = await callHEREDbg([], quickTimeout, false, internalAlternates);
          const routeQ: FeatureCollection = resQ?.geojson ?? { type: "FeatureCollection", features: [] };
          phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "QUICK_DEADLINE" });
          return finalizeResponse(
            routeQ?.features?.length
              ? { route: routeQ, blockingWarnings: [], roadworksHits: 0, distance_km: extractDistanceKm(routeQ), meta: { bbox_km: null, avoids_applied: 0, fallback_used: true } }
              : null,
            { bbox_km_used: null, fallback_used: true }
          );
        }
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "TIME_BUDGET" });
        return finalizeResponse(null, { bbox_km_used: null, fallback_used: true });
      }

      // Erste Route ohne Avoids für Streckenbestimmung
      const res0 = await callHEREDbg([], baseHERETimeout, false, internalAlternates);
      const route0: FeatureCollection = res0?.geojson ?? { type: "FeatureCollection", features: [] };

      if (!route0?.features?.length) {
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE", reason: res0?.error ?? null });
        return finalizeResponse(null, { bbox_km_used: null, fallback_used: true });
      }

      // Streckenabschnitte samplen für Restriktionsabfragen
      const coords: Coords[]  = getRouteCoords(route0);
      const boxesAll = coords.length >= 2 ? chunkRouteToBBoxes(coords, 220, 55, Math.max(12, Math.min(34, corridorKm))) : [];
      const boxes    = pickSpreadBoxes(boxesAll, 6);

      rwTelemetry.boxes_total = boxes.length;
      rwTelemetry.status = boxes.length ? "PARTIAL" : "FAILED";
      rwTelemetry.notes  = boxes.length ? "sampling_along_route" : "no_route_coords_for_sampling";

      let restrictions: RestrictionPolygon[] = [];
      let validationPolys: RestrictionPolygon[] = [];

      if (boxes.length && timeLeft() > 2_500) {
        const perCallTimeout = Math.min(RESTRICTIONS_TIMEOUT_MS, Math.max(4_800, Math.floor(timeLeft() / (boxes.length + 2))));
        rwTelemetry.timeout_ms = perCallTimeout;

        // Vollständige Route-BBox für Baustellen-Validierungsabfrage
        const fullBboxLine = coords.length >= 2 ? lineString(coords.slice(0, Math.min(coords.length, 500))) : null;
        const fullBbox = fullBboxLine
          ? bboxFn(buffer(fullBboxLine, Math.max(12, corridorKm), { units: "kilometers" })!) as [number, number, number, number]
          : null;

        const [results, rwValResult] = await Promise.all([
          Promise.all(boxes.map((bb) => callRestrictions(origin, { ts, tz, bbox: bb, vehicle, buffer_m: RESTRICTION_BUFFER_M }, perCallTimeout, internalForwardHeaders))),
          fullBbox ? callRoadworks(origin, { ts, tz, bbox: fullBbox }, perCallTimeout, internalForwardHeaders) : Promise.resolve({ ok: false, features: [] }),
        ]);

        const lists: RestrictionPolygon[][] = [];
        for (const r of results) {
          if (r.ok) { rwTelemetry.boxes_ok++; rwTelemetry.fetched += r.features.length; lists.push(r.features); }
          else { rwTelemetry.boxes_failed++; rwTelemetry.errors?.push(r.error ?? `restrictions_failed_status_${r.status}`); }
        }

        restrictions = mergeRestrictions(lists, 2200);

        if (heavyTransport && fullBbox) {
          const htBanRes = await callHeavyTransportBanPolygons(origin, fullBbox, perCallTimeout, internalForwardHeaders);
          if (htBanRes.ok && htBanRes.features.length > 0) {
            restrictions = mergeRestrictions([restrictions, htBanRes.features], 2600);
          }
        }
        rwTelemetry.used = restrictions.length;

        // Baustellen (text-enriched) als zusätzliche Validierungsquelle
        // 300m Buffer: Baustellen-Punkte sind oft neben der Fahrbahn gesetzt, kein fester
        // Mittelstreifen-Bezug. Großzügiger Buffer vermeidet False-Negatives.
        const rwValidationPolys = rwValResult.ok
          ? buildRoadworkValidationPolygons(rwValResult.features, vehicle, 300)
          : [];
        validationPolys = rwValidationPolys.length > 0
          ? mergeRestrictions([restrictions, rwValidationPolys], 3000)
          : restrictions;

        if (rwTelemetry.boxes_ok > 0 && rwTelemetry.boxes_failed === 0) rwTelemetry.status = "OK";
        else if (rwTelemetry.boxes_ok > 0) rwTelemetry.status = "PARTIAL";
        else rwTelemetry.status = "FAILED";

        if (rwTelemetry.status !== "OK") rwTelemetry.notes = "Restriktionsdaten unvollständig. Route trotzdem geliefert (fail-open).";
      } else {
        rwTelemetry.status = "FAILED";
        rwTelemetry.notes  = "Restriktions-Sampling übersprungen.";
        validationPolys = restrictions;
      }

      // Permanente Avoids für Schwertransport-Verbote entstehen erst dann,
      // wenn eine tatsächlich berechnete Route in ein HT-Verbot läuft.
      const fastPermanentAvoidIds   = new Set<string>();
      const fastPermanentAvoidPolys = new Map<string, Feature<Polygon>>();

      // Initiale Validierung (gegen kombinierte Menge inkl. text-enriched Baustellen)
      const effectiveValPolys = validationPolys.length ? validationPolys : restrictions;
      let best: Candidate = pickBestHereCandidate({
        res: res0,
        validationPolys: effectiveValPolys,
        restrictions,
        vehicle,
        heavyTransport,
        avoidMap: fastPermanentAvoidPolys,
        bboxKm: null,
        fallbackUsed: true,
      }) ?? {
        route: route0,
        blockingWarnings: [],
        roadworksHits: 0,
        distance_km: extractDistanceKm(route0),
        meta: { bbox_km: null, avoids_applied: fastPermanentAvoidPolys.size, fallback_used: true },
      };

      if (rwTelemetry.status === "FAILED") {
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "OK_ROUTE_NO_RESTRICTIONS", boxes: boxes.length });
        return finalizeResponse(best, { bbox_km_used: null, fallback_used: true });
      }

      if (best.blockingWarnings.length > 0 && timeLeft() > baseHERETimeout + 3_500) {
        const { best: newBest, stuckReason, iterations } = await runIterationLoop({
          restrictions, validationPolys: effectiveValPolys, vehicle, initialBest: best,
          IS_WIDE, MAX_AVOIDS_EFFECTIVE,
          MAX_ITERATIONS: 20, MAX_NEW_AVOIDS_PER_ITER: IS_WIDE ? 18 : 26,
          baseHERETimeout, maxHERETimeout, timeLeft, bboxKm: null, callHEREDbg, internalAlternates,
          heavyTransport, permanentAvoidIds: fastPermanentAvoidIds, permanentAvoidPolys: fastPermanentAvoidPolys,
        });
        best = newBest;
        totalIterations += iterations;
        phases.push({
          phase: "FAST_PATH", approx_km: approxKm,
          result: best.blockingWarnings.length === 0 ? "CLEAN" : "WARN",
          boxes: boxes.length, restrictions_hits: best.roadworksHits,
          avoids_applied: best.meta.avoids_applied, reason: stuckReason,
        });
      } else {
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: best.blockingWarnings.length ? "WARN" : "CLEAN" });
      }

      return finalizeResponse(best, { bbox_km_used: null, fallback_used: true });
    }

    // ──────────────── KURZE STRECKEN: STRICT PATH ────────────────
    const baseRestrictionBBoxKm = Math.max(12, Math.min(55, approxKm * 0.8 + 5));
    const SEARCH_STEPS = heavyTransport
      ? [
          { bboxKm: 200, restrictionBBoxKm: baseRestrictionBBoxKm, alternates: internalAlternates, label: "STRICT_BASE" },
          { bboxKm: 200, restrictionBBoxKm: Math.max(baseRestrictionBBoxKm, 85), alternates: 6, label: "STRICT_EXPANDED_ALTS" },
          { bboxKm: 200, restrictionBBoxKm: Math.max(baseRestrictionBBoxKm, 130), alternates: 6, label: "STRICT_WIDE_SCOPE" },
        ]
      : [
          { bboxKm: 200, restrictionBBoxKm: baseRestrictionBBoxKm, alternates: internalAlternates, label: "STRICT_BASE" },
          { bboxKm: 200, restrictionBBoxKm: Math.max(baseRestrictionBBoxKm, 80), alternates: Math.max(3, internalAlternates), label: "STRICT_WIDE_SCOPE" },
        ];
    const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 18 : 26;

    let best: Candidate | null = null;

    rwTelemetry.boxes_total = SEARCH_STEPS.length;

    type RestrictionScope = {
      ok: boolean;
      bboxKm: number;
      bbox: [number, number, number, number];
      restrictions: RestrictionPolygon[];
      validationPolys: RestrictionPolygon[];
      error?: string;
      status?: number;
    };

    const scopeCache = new Map<number, RestrictionScope>();
    let widestLoadedScope: RestrictionScope | null = null;
    let allHeavyBridgeFeaturesPromise: Promise<any[]> | null = null;

    const loadAllHeavyBridgeFeatures = async (): Promise<any[]> => {
      if (!heavyTransport) return [];
      if (!allHeavyBridgeFeaturesPromise) {
        allHeavyBridgeFeaturesPromise = (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), RESTRICTIONS_TIMEOUT_MS);
          try {
            const res = await fetch(`${origin}/api/restrictions/bridges?geometry=full`, {
              method: "GET",
              headers: { Accept: "application/json", ...internalForwardHeaders },
              cache: "no-store",
              signal: controller.signal,
            });
            const data = await res.json().catch(() => null);
            return Array.isArray(data?.features) ? data.features : [];
          } catch {
            return [];
          } finally {
            clearTimeout(timer);
          }
        })();
      }
      return allHeavyBridgeFeaturesPromise;
    };

    const getHeavyTransportBanPolygonsForBBox = async (
      bbox: [number, number, number, number]
    ): Promise<RestrictionPolygon[]> => {
      const features = await loadAllHeavyBridgeFeatures();
      return features
        .filter((feature: any) => {
          if (feature?.properties?.no_heavy_transport !== true) return false;
          const geomBbox = featureBounds(feature?.geometry);
          return geomBbox ? bboxOverlaps(geomBbox, bbox) : false;
        })
        .flatMap((feature: any) => toRestrictionPolygonsFromBridgeFeature(feature));
    };

    const loadRestrictionScope = async (restrictionBBoxKm: number): Promise<RestrictionScope> => {
      const cached = scopeCache.get(restrictionBBoxKm);
      if (cached) return cached;

      const scopeBbox = makeSafeBBox(start, end, restrictionBBoxKm);
      const rwCallTimeout = Math.min(RESTRICTIONS_TIMEOUT_MS, Math.max(4_500, Math.floor(timeLeft() / 3)));
      rwTelemetry.timeout_ms = rwCallTimeout;

      const [rwRes, rwValRes] = await Promise.all([
        callRestrictions(origin, { ts, tz, bbox: scopeBbox, vehicle, buffer_m: RESTRICTION_BUFFER_M }, rwCallTimeout, internalForwardHeaders),
        callRoadworks(origin, { ts, tz, bbox: scopeBbox }, rwCallTimeout, internalForwardHeaders),
      ]);

      let restrictions: RestrictionPolygon[] = rwRes.ok ? rwRes.features : [];
      if (heavyTransport) {
        const htBanFeatures = await getHeavyTransportBanPolygonsForBBox(scopeBbox);
        if (htBanFeatures.length > 0) {
          restrictions = mergeRestrictions([restrictions, htBanFeatures], 2600);
        }
      }

      const rwValidPolys = rwValRes.ok ? buildRoadworkValidationPolygons(rwValRes.features, vehicle, 300) : [];
      const validationPolys = rwValidPolys.length > 0
        ? mergeRestrictions([restrictions, rwValidPolys], 3000)
        : restrictions;

      const scope: RestrictionScope = {
        ok: rwRes.ok,
        bboxKm: restrictionBBoxKm,
        bbox: scopeBbox,
        restrictions,
        validationPolys,
        error: rwRes.error,
        status: rwRes.status,
      };

      scopeCache.set(restrictionBBoxKm, scope);

      if (rwRes.ok) {
        rwTelemetry.boxes_ok += 1;
        rwTelemetry.fetched = Math.max(rwTelemetry.fetched, restrictions.length);
        rwTelemetry.used = Math.max(rwTelemetry.used, validationPolys.length);
        widestLoadedScope = !widestLoadedScope || restrictionBBoxKm >= widestLoadedScope.bboxKm ? scope : widestLoadedScope;
        console.log("[PLAN] restrictions loaded", {
          bbox_km: restrictionBBoxKm,
          total: restrictions.length,
          validation_total: validationPolys.length,
          with_width: restrictions.filter(f => f?.properties?.max_width_m != null).length,
          with_weight: restrictions.filter(f => f?.properties?.max_weight_t != null).length,
          vWidth, vWeight,
        });
      } else {
        rwTelemetry.boxes_failed += 1;
        rwTelemetry.errors?.push(rwRes.error ?? `restrictions_failed_status_${rwRes.status}`);
      }

      rwTelemetry.status =
        rwTelemetry.boxes_ok === rwTelemetry.boxes_total ? "OK"
        : rwTelemetry.boxes_ok > 0 ? "PARTIAL"
        : "FAILED";

      return scope;
    };

    const collectFreshBestEffort = async (
      scans: number,
      alternates: number,
      restrictions: RestrictionPolygon[],
      validationPolys: RestrictionPolygon[]
    ): Promise<Candidate | null> => {
      let freshBest: Candidate | null = null;
      const effectiveValPolys = validationPolys.length ? validationPolys : restrictions;

      for (let i = 0; i < scans; i++) {
        if (timeLeft() < baseHERETimeout + 1_500) break;
        const freshRes = await callHEREDbg([], baseHERETimeout, false, alternates);
        const freshCand = pickBestHereCandidate({
          res: freshRes,
          validationPolys: effectiveValPolys,
          restrictions,
          vehicle,
          heavyTransport,
          avoidMap: new Map(),
          bboxKm: null,
          fallbackUsed: true,
        });
        if (freshCand?.route?.features?.length) {
          freshBest = pickBetterCandidate(freshBest, freshCand);
          if (freshBest?.blockingWarnings.length === 0) break;
        }
      }

      return freshBest;
    };

    for (const step of SEARCH_STEPS) {
      if (timeLeft() < baseHERETimeout + 4_000) break;

      const bboxKm = step.bboxKm;
      const scope = await loadRestrictionScope(step.restrictionBBoxKm);
      if (!scope.ok) {
        phases.push({
          phase: `${step.label}_RESTRICTIONS`,
          bbox_km: step.restrictionBBoxKm,
          ok: false,
          status: scope.status,
          error: scope.error ?? null,
        });
        continue;
      }
      const restrictions = scope.restrictions;
      const validationPolys = scope.validationPolys;

      // Wichtige Korrektur:
      // Permanente Avoids aus einer schlechteren Suchrunde duerfen spaetere
      // "frische" Suchrunden nicht blockieren. Sonst kann eine spaeter
      // vorhandene saubere Route nie mehr gefunden werden.
      const stepPermanentAvoidIds = new Set<string>();
      const stepPermanentAvoidPolys = new Map<string, Feature<Polygon>>();

      // Erste Route (mit permanenten HT-Ban-Avoids wenn Schwertransport)
      const permanentPolysArr = Array.from(stepPermanentAvoidPolys.values());
      const initialRes = await callHEREDbg(permanentPolysArr, baseHERETimeout, permanentPolysArr.length > 0, step.alternates);
      const initialRoute: FeatureCollection = initialRes?.geojson ?? { type: "FeatureCollection", features: [] };
      totalIterations++;

      if (!initialRoute?.features?.length) {
        phases.push({
          phase: step.label,
          bbox_km: bboxKm,
          iterations: 1,
          avoids_applied: 0,
          alternates: step.alternates,
          result: "NO_ROUTE",
          reason: initialRes?.error ?? "no_initial_route",
        });
        continue;
      }

      // Initiale Validierung mit exactem Linie-Polygon-Check (inkl. text-enriched Baustellen)
      const effectiveValPolys = validationPolys.length ? validationPolys : restrictions;
      const initialBest = pickBestHereCandidate({
        res: initialRes,
        validationPolys: effectiveValPolys,
        restrictions,
        vehicle,
        heavyTransport,
        avoidMap: stepPermanentAvoidPolys,
        bboxKm,
        fallbackUsed: false,
      }) ?? {
        route: initialRoute,
        blockingWarnings: [],
        roadworksHits: 0,
        distance_km: extractDistanceKm(initialRoute),
        meta: { bbox_km: bboxKm, avoids_applied: stepPermanentAvoidPolys.size, fallback_used: false },
      };

      if (initialBest.blockingWarnings.length === 0) {
        best = pickBetterCandidate(best, initialBest);
        phases.push({
          phase: step.label,
          bbox_km: bboxKm,
          iterations: 1,
          avoids_applied: stepPermanentAvoidPolys.size,
          alternates: step.alternates,
          result: "CLEAN",
        });
        break;
      }

      // Iterationsloop starten
      const { best: loopBest, stuckReason, iterations } = await runIterationLoop({
        restrictions, validationPolys: effectiveValPolys, vehicle, initialBest,
        IS_WIDE, MAX_AVOIDS_EFFECTIVE,
        MAX_ITERATIONS: 18, MAX_NEW_AVOIDS_PER_ITER,
        baseHERETimeout, maxHERETimeout, timeLeft, bboxKm, callHEREDbg, internalAlternates: step.alternates,
        heavyTransport, permanentAvoidIds: stepPermanentAvoidIds, permanentAvoidPolys: stepPermanentAvoidPolys,
      });

      totalIterations += iterations;
      best = pickBetterCandidate(best, loopBest);

      phases.push({
        phase: step.label, bbox_km: bboxKm, iterations,
        avoids_applied: best?.meta?.avoids_applied ?? 0,
        alternates: step.alternates,
        result: best?.route?.features?.length ? "CANDIDATE" : "NO_ROUTE",
        reason: stuckReason,
      });

      if (best?.route?.features?.length && best.blockingWarnings.length === 0) break;

      // Corridor-Retry: zweiter Versuch mit großem Korridor (25 km)
      if (best && best.blockingWarnings.length > 0 && timeLeft() > baseHERETimeout + 5_000) {
        console.log("[PLAN] Corridor-Retry mit 25km...");
        const { best: retryBest, stuckReason: retryReason, iterations: retryIter } = await runIterationLoop({
          restrictions, validationPolys: effectiveValPolys, vehicle, initialBest: best,
          IS_WIDE, MAX_AVOIDS_EFFECTIVE,
          MAX_ITERATIONS: 8, MAX_NEW_AVOIDS_PER_ITER,
          baseHERETimeout, maxHERETimeout, timeLeft, bboxKm, callHEREDbg, internalAlternates: step.alternates,
          heavyTransport, permanentAvoidIds: stepPermanentAvoidIds, permanentAvoidPolys: stepPermanentAvoidPolys,
        });
        totalIterations += retryIter;
        const newBest = pickBetterCandidate(best, retryBest);
        if (newBest !== best) {
          best = newBest;
          phases.push({
            phase: `${step.label}_RETRY`, bbox_km: bboxKm, iterations: retryIter,
            alternates: step.alternates,
            result: best?.blockingWarnings.length === 0 ? "CLEAN" : "WARN",
            reason: retryReason,
          });
        }
        if (best?.blockingWarnings.length === 0) break;
      }
    }

    const maxRequestedRestrictionBBoxKm = SEARCH_STEPS.reduce(
      (max, step) => Math.max(max, step.restrictionBBoxKm),
      0
    );

    if (
      best?.route?.features?.length &&
      best.blockingWarnings.length === 0 &&
      widestLoadedScope &&
      widestLoadedScope.bboxKm < maxRequestedRestrictionBBoxKm &&
      timeLeft() > 4_000
    ) {
      const finalScope = await loadRestrictionScope(maxRequestedRestrictionBBoxKm);
      if (finalScope.ok) {
        widestLoadedScope = finalScope;
        const revalidatedBest = buildCandidateFromRoute({
          route: best.route,
          validationPolys: finalScope.validationPolys,
          restrictions: finalScope.restrictions,
          vehicle,
          heavyTransport,
          avoidMap: new Map(),
          bboxKm: finalScope.bboxKm,
          fallbackUsed: best.meta?.fallback_used ?? false,
        });
        best = {
          ...revalidatedBest,
          meta: {
            ...best.meta,
            bbox_km: finalScope.bboxKm,
            avoids_applied: best.meta?.avoids_applied ?? 0,
            fallback_used: best.meta?.fallback_used ?? false,
          },
        };
        phases.push({
          phase: "STRICT_FINAL_VERIFICATION",
          bbox_km: finalScope.bboxKm,
          result: best.blockingWarnings.length === 0 ? "CLEAN" : "WARN",
        });
      }
    }

    // Wenn der breiteste angeforderte Restriktions-Scope erfolgreich geladen wurde,
    // gilt die finale Validierung als vollstaendig. Fruehere Fehlversuche auf engeren
    // Scopes duerfen den Endstatus dann nicht kuenstlich auf PARTIAL ziehen.
    if (widestLoadedScope && widestLoadedScope.bboxKm >= maxRequestedRestrictionBBoxKm) {
      rwTelemetry.status = "OK";
      if (rwTelemetry.notes === "Restriktionsdaten unvollständig. Route trotzdem geliefert (fail-open).") {
        rwTelemetry.notes = null;
      }
    }

    // Wenn kein Restriktions-Scope erfolgreich geladen wurde → einmalig Fail-open-Route holen und fertig
    if (!widestLoadedScope) {
      rwTelemetry.status = "FAILED";
      rwTelemetry.notes = "Restriktionsdaten nicht ladbar. Route trotzdem (fail-open).";
      const permanentPolysArr: Feature<Polygon>[] = [];
      const res = await callHEREDbg(permanentPolysArr, baseHERETimeout, permanentPolysArr.length > 0, internalAlternates);
      const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };
      totalIterations++;
      const unverifiedWarning = requireClean ? [{
        title: "Restriktionsprüfung nicht möglich",
        description: "Restriktionsdaten (Brückenlast- und Baustellensperrungen) konnten nicht abgerufen werden. Die Route wurde NICHT auf Durchfahrtsbeschränkungen geprüft.",
        block_reason: "RESTRICTIONS_UNAVAILABLE",
        limits: null, vehicle_value: null, allowed_value: null,
        network: null, restriction_kind: null, already_avoided: false,
      }] : [];
      if (route?.features?.length) {
        best = {
          route,
          blockingWarnings: unverifiedWarning,
          roadworksHits: unverifiedWarning.length,
          distance_km: extractDistanceKm(route),
          meta: { bbox_km: null, avoids_applied: 0, fallback_used: false },
        };
      }
      return finalizeResponse(best, { bbox_km_used: null, fallback_used: false });
    }

    if (best?.route?.features?.length) {
      const revalidated = buildCandidateFromRoute({
        route: best.route,
        validationPolys: widestLoadedScope.validationPolys,
        restrictions: widestLoadedScope.restrictions,
        vehicle,
        heavyTransport,
        avoidMap: new Map(),
        bboxKm: best.meta?.bbox_km ?? widestLoadedScope.bboxKm,
        fallbackUsed: best.meta?.fallback_used ?? false,
      });
      best = {
        ...revalidated,
        meta: {
          ...best.meta,
          bbox_km: best.meta?.bbox_km ?? widestLoadedScope.bboxKm,
          fallback_used: best.meta?.fallback_used ?? false,
        },
      };
    }

    // Ein frischer letzter Suchlauf mit maximalen Alternativen verhindert,
    // dass eine spaet verfuegbare, saubere Route von frueheren Avoids ueberdeckt wird.
    if (heavyTransport && best?.route?.features?.length && best.blockingWarnings.length > 0 && timeLeft() >= baseHERETimeout + 2_500) {
      const freshBest = await collectFreshBestEffort(3, 6, widestLoadedScope.restrictions, widestLoadedScope.validationPolys);
      if (freshBest?.route?.features?.length) {
        const betterFresh = pickBetterCandidate(best, freshBest);
        if (betterFresh !== best) {
          best = betterFresh;
          phases.push({ phase: "STRICT_FINAL_FRESH_SCAN", alternates: 6, scans: 3, result: best.blockingWarnings.length ? "WARN" : "CLEAN" });
        }
      }
    }

    // ──────────────── FALLBACK: Route ohne Avoids (Best Effort) ────────────────
    if (!best?.route?.features?.length && timeLeft() >= baseHERETimeout + 2_500) {
      const fallbackBest = await collectFreshBestEffort(3, 6, widestLoadedScope.restrictions, widestLoadedScope.validationPolys);
      if (fallbackBest?.route?.features?.length) {
        best = fallbackBest;
        phases.push({ phase: "FALLBACK_BEST_EFFORT_SCAN", alternates: 6, scans: 3, result: best.blockingWarnings.length ? "WARN" : "OK" });
      } else {
        const unrestrictedBest = await collectFreshBestEffort(1, 6, widestLoadedScope.restrictions, widestLoadedScope.validationPolys);
        if (unrestrictedBest?.route?.features?.length) {
          best = unrestrictedBest;
          phases.push({ phase: "FALLBACK_UNRESTRICTED_BEST_EFFORT", result: best.blockingWarnings.length ? "WARN" : "OK" });
        } else {
          phases.push({ phase: "FALLBACK_NO_RESTRICTIONS", result: "NO_ROUTE", reason: "no_best_effort_route" });
        }
      }
    }

    return finalizeResponse(best, {
      bbox_km_used:  best?.meta?.bbox_km ?? null,
      fallback_used: best?.meta?.fallback_used ?? false,
    });

  } catch (err: any) {
    console.error("[PLAN] unhandled error:", err);
    return NextResponse.json(
      {
        meta: {
          source: "route/plan-stable-v2", status: "ERROR", clean: false,
          error: String(err?.message ?? err ?? "Unbekannter Fehler"),
        },
        roadworks: {
          status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
          timeout_ms: 0, buffer_m: 0, fetched: 0, used: 0, notes: "handler_exception",
        } as RestrictionsTelemetry,
        restrictions: {
          status: "SKIPPED", boxes_total: 0, boxes_ok: 0, boxes_failed: 0,
          timeout_ms: 0, buffer_m: 0, fetched: 0, used: 0, notes: "handler_exception",
        } as RestrictionsTelemetry,
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: [], geojson_alts: [],
      },
      { status: 500 }
    );
  }
}
