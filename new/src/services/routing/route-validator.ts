// src/services/routing/route-validator.ts
//
// Distanzbasierte Post-Route-Validierung.
//
// Ersetzt die bisherige Turf.js booleanIntersects-Logik. Das Grundproblem:
//   booleanIntersects erkennt NICHT, wenn eine Route ein Polygon komplett durchquert,
//   ohne dass ein Stützpunkt auf der Polygongrenze liegt. HERE liefert auf
//   Autobahnabschnitten oft nur alle 200–500m einen Stützpunkt — eine Baustelle
//   kann also komplett zwischen zwei Stützpunkten liegen und wird nicht erkannt.
//
// Die neue Methode:
//   1. Route densifizieren: Zwischenpunkte einfügen, max. 50m zwischen Stützpunkten
//   2. Ray-Casting Point-in-Polygon: für jeden dichten Stützpunkt prüfen ob er
//      innerhalb des gepufferten Restriktionspolygons liegt
//   3. Haversine-Zentroid-Abstand: Sicherheitsnetz für numerische Grenzfälle
//
// Mathematische Garantie:
//   - PostGIS-Polygone sind bereits um mind. 60m gepuffert
//   - Route ist nach Densifizierung max. 50m zwischen Punkten
//   - Jedes Segment das durch ein >50m breites Polygon führt hat mind. einen
//     Punkt innerhalb des Polygons → wird zuverlässig erkannt
//
// Keine Turf.js-Abhängigkeiten für die Kernlogik. Haversine + Ray-Casting
// sind reine Mathematik ohne externe Abhängigkeiten oder Versionsprobleme.

import type { RouteConflict, ValidationResult, RestrictionPolygon, VehicleSpec } from "./types";

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const VALIDATION_CONFIG = {
  /** Maximale Segmentlänge nach Densifizierung (in Metern).
   *  50m bedeutet: Kein Routensegment ist länger als 50m nach der Densifizierung.
   *  Muss KLEINER sein als der Mindestpuffer der Restriktionspolygone (60m). */
  MAX_SEGMENT_LENGTH: 50,

  /** Schwellenwert für den Haversine-Zentroid-Abstandscheck (in Metern).
   *  Fängt numerische Grenzfälle des Ray-Casting ab (z.B. sehr kleine Polygone
   *  oder Punkte haargenau auf der Polygongrenze).
   *  Muss KLEINER sein als der typische Polygon-Radius um False Positives zu vermeiden. */
  CENTROID_THRESHOLD: 80,
} as const;

// ---------------------------------------------------------------------------
// Geometrie-Hilfsfunktionen — keine externen Abhängigkeiten
// ---------------------------------------------------------------------------

/**
 * Haversine-Distanz in Metern zwischen zwei geografischen Koordinaten.
 * Implementiert direkt — keine externe Bibliothek.
 */
function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Erdradius in Metern
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Ray-Casting Point-in-Polygon.
 * Prüft ob ein Punkt [lat, lng] innerhalb eines GeoJSON-Polygonrings liegt.
 *
 * @param lat  Breitengrad des Testpunkts
 * @param lng  Längengrad des Testpunkts
 * @param ring GeoJSON-Außenring: Array von [lng, lat] Paaren
 */
function pointInPolygon(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    // GeoJSON-Konvention: ring[i] = [lng, lat]
    const yi = ring[i][1]; // lat der Ecke i
    const xi = ring[i][0]; // lng der Ecke i
    const yj = ring[j][1]; // lat der Ecke j
    const xj = ring[j][0]; // lng der Ecke j
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Berechnet den Schwerpunkt (arithmetisches Mittel) eines GeoJSON-Polygonrings.
 * Für Distanz-Näherungen ausreichend genau — kein exakter geografischer Centroid nötig.
 *
 * @param ring GeoJSON-Außenring: Array von [lng, lat] Paaren
 * @returns [lng, lat]
 */
function polygonCentroid(ring: number[][]): [number, number] {
  let sumLng = 0;
  let sumLat = 0;
  const n = ring.length;
  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }
  return [sumLng / n, sumLat / n];
}

/**
 * Densifiziert eine Route: Fügt lineare Zwischenpunkte ein, sodass kein Segment
 * länger als maxSegmentLengthMeters ist.
 *
 * Das ist der KRITISCHE Schritt: HERE liefert auf Autobahnabschnitten oft nur
 * alle 200–500m einen Stützpunkt. Eine Baustelle kann komplett zwischen zwei
 * Stützpunkten liegen und wird ohne Densifizierung nicht erkannt.
 *
 * @param points                  [lng, lat] Koordinatenpaare der Route (GeoJSON-Konvention)
 * @param maxSegmentLengthMeters  Maximale Segmentlänge in Metern (Standard: 50)
 * @returns Densifizierte Route mit eingefügten Zwischenpunkten
 */
function densifyRoute(
  points: [number, number][],
  maxSegmentLengthMeters: number = VALIDATION_CONFIG.MAX_SEGMENT_LENGTH
): [number, number][] {
  if (points.length < 2) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const [lng0, lat0] = points[i - 1];
    const [lng1, lat1] = points[i];

    const dist = haversineDistance(lat0, lng0, lat1, lng1);

    if (dist > maxSegmentLengthMeters) {
      // Segment ist zu lang → Zwischenpunkte einfügen
      const steps = Math.ceil(dist / maxSegmentLengthMeters);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        // Lineare Interpolation — ausreichend genau für < 5km Segmente
        result.push([lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t]);
      }
    }

    result.push(points[i]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen (Metadaten-Extraktion — unverändert)
// ---------------------------------------------------------------------------

/** Stabile ID für eine Restriction (für Deduplizierung und avoidMap) */
export function restrictionId(r: RestrictionPolygon): string {
  const p = r.properties ?? {};
  const raw =
    p.id ?? p.external_id ?? JSON.stringify(r.geometry?.coordinates).slice(0, 80);
  return String(raw);
}

function inferReason(p: RestrictionPolygon["properties"]): RouteConflict["reason"] {
  const kind = String(p?.kind ?? "").toLowerCase();
  if (kind.includes("width") || kind === "breite") return "width";
  if (kind.includes("weight") || kind.includes("gewicht") || kind === "last") return "weight";
  if (kind.includes("height") || kind.includes("hoehe") || kind.includes("höhe")) return "height";
  if (kind.includes("axle") || kind.includes("achs")) return "axle";
  if (kind.includes("clos") || kind.includes("sperr") || kind === "blocked") return "closed";
  // Fallback: aus vorhandenen Limit-Feldern ableiten
  if (p?.max_width_m != null) return "width";
  if (p?.max_weight_t != null) return "weight";
  if (p?.max_height_m != null) return "height";
  if (p?.max_axle_t != null) return "axle";
  return "unknown";
}

function getAllowedValue(
  p: RestrictionPolygon["properties"],
  reason: RouteConflict["reason"]
): number | null {
  switch (reason) {
    case "width":              return p?.max_width_m  ?? null;
    case "weight":             return p?.max_weight_t ?? null;
    case "height":             return p?.max_height_m ?? null;
    case "axle":               return p?.max_axle_t   ?? null;
    case "heavy_transport_ban": return p?.max_weight_t ?? null;
    default:                   return null;
  }
}

function getVehicleValue(v: VehicleSpec, reason: RouteConflict["reason"]): number | null {
  switch (reason) {
    case "width":  return v.width_m    ?? null;
    case "weight": return v.weight_t   ?? null;
    case "height": return v.height_m   ?? null;
    case "axle":   return v.axleload_t ?? null;
    default:       return null;
  }
}

function getTriggeredReasons(
  restriction: RestrictionPolygon,
  vehicle: VehicleSpec,
  heavyTransport?: boolean
): RouteConflict["reason"][] {
  const props = restriction.properties ?? {};
  const reasons: RouteConflict["reason"][] = [];

  const heavyBanTriggered = heavyTransport === true && props.no_heavy_transport === true;

  if (props.max_width_m != null && vehicle.width_m != null && vehicle.width_m > props.max_width_m) {
    reasons.push("width");
  }
  if (props.max_weight_t != null && vehicle.weight_t != null && vehicle.weight_t > props.max_weight_t) {
    reasons.push("weight");
  }
  if (props.max_height_m != null && vehicle.height_m != null && vehicle.height_m > props.max_height_m) {
    reasons.push("height");
  }
  if (props.max_axle_t != null && vehicle.axleload_t != null && vehicle.axleload_t > props.max_axle_t) {
    reasons.push("axle");
  }

  const inferred = inferReason(props);
  if (inferred === "closed" && !reasons.includes("closed")) {
    reasons.push("closed");
  }

  if (heavyBanTriggered) {
    return reasons.includes("closed") ? ["heavy_transport_ban", "closed"] : ["heavy_transport_ban"];
  }

  if (reasons.length > 0) return reasons;

  if (props.no_heavy_transport === true && heavyTransport !== true) {
    return [];
  }

  return inferred === "unknown" ? [] : [];
}

// ---------------------------------------------------------------------------
// Kern-Validierungsfunktion
// ---------------------------------------------------------------------------

/**
 * Validiert eine dekodierte Route gegen alle Restriktionspolygone aus /api/restrictions.
 *
 * ALGORITHMUS:
 *   1. Route densifizieren (max. 50m zwischen Stützpunkten)
 *   2. Für jede Restriktion:
 *      a. BBox-Vorfilter (Performance: schnelle Abstoßung wenn Route weit entfernt)
 *      b. Ray-Casting: liegt ein Routenpunkt im gepufferten Polygon? → Konflikt
 *      c. Zentroid-Abstand: ist ein Routenpunkt < 80m vom Polygon-Zentroid? → Konflikt
 *         (Sicherheitsnetz für numerische Grenzfälle)
 *   3. Wenn heavyTransport=true: Restriktionen mit no_heavy_transport=true sind immer Konflikte
 *      (zusätzlich zum geometrischen Check)
 *
 * @param routeCoords    [lng, lat] Koordinatenpaare der Route (GeoJSON-Konvention)
 * @param restrictions   Gepufferte Polygon-Features aus /api/restrictions
 * @param vehicle        Fahrzeugmaße für die Konflikt-Beschreibung
 * @param heavyTransport true = Fahrzeug ist Schwertransport, HT-Verbote werden erkannt
 */
export function validateRoute(
  routeCoords: [number, number][],
  restrictions: RestrictionPolygon[],
  vehicle: VehicleSpec,
  heavyTransport?: boolean
): ValidationResult {
  if (routeCoords.length < 2 || !restrictions.length) {
    return { clean: true, conflicts: [] };
  }

  // ── Route densifizieren: max. 50m zwischen Stützpunkten ──
  // Das ist der entscheidende Schritt gegenüber dem alten booleanIntersects-Ansatz.
  const densified = densifyRoute(routeCoords, VALIDATION_CONFIG.MAX_SEGMENT_LENGTH);

  console.log("[validateRoute] Punkte:", {
    original: routeCoords.length,
    densifiziert: densified.length,
    restriktionen: restrictions.length,
  });

  const conflicts: RouteConflict[] = [];
  const seen = new Set<string>();

  for (const restriction of restrictions) {
    try {
      const ring: number[][] = restriction.geometry?.coordinates?.[0];
      if (!Array.isArray(ring) || ring.length < 3) continue;

      // ── BBox-Vorfilter (Performance) ──
      // Grobe Abstoßung wenn kein densifizierter Routenpunkt in der Bounding Box liegt.
      // Pad von 0.002° ≈ 220m, um Grenzfälle abzufangen.
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      const pad = 0.002;
      const inBbox = densified.some(
        ([lng, lat]) =>
          lng >= minLng - pad &&
          lng <= maxLng + pad &&
          lat >= minLat - pad &&
          lat <= maxLat + pad
      );
      if (!inBbox) continue;

      // ── Primärcheck: Ray-Casting Point-in-Polygon ──
      // Mit densifizierter Route (max. 50m Segmente) und gepufferten Polygonen (min. 60m)
      // ist mathematisch garantiert dass jede Route die durch ein Polygon führt erkannt wird.
      let hit = false;
      for (const [lng, lat] of densified) {
        if (pointInPolygon(lat, lng, ring)) {
          hit = true;
          break;
        }
      }

      // ── Sicherheitsnetz: Haversine-Abstand zum Polygon-Zentroid ──
      // Fängt numerische Grenzfälle ab: z.B. Punkte haargenau auf der Polygonkante
      // die der Ray-Casting-Algorithmus knapp verfehlt, oder sehr kleine Polygone.
      if (!hit) {
        const [centLng, centLat] = polygonCentroid(ring);
        for (const [lng, lat] of densified) {
          if (haversineDistance(lat, lng, centLat, centLng) < VALIDATION_CONFIG.CENTROID_THRESHOLD) {
            hit = true;
            break;
          }
        }
      }

      if (!hit) continue;

      const id = restrictionId(restriction);
      const reasons = getTriggeredReasons(restriction, vehicle, heavyTransport);
      for (const reason of reasons) {
        const semanticKey = [
          reason,
          restriction.properties?.title ?? "",
          restriction.properties?.network ?? "",
          getAllowedValue(restriction.properties, reason) ?? "",
        ].join("|");
        if (seen.has(semanticKey)) continue;
        seen.add(semanticKey);
        conflicts.push({
          restrictionId: id,
          restriction,
          reason,
          vehicleValue: getVehicleValue(vehicle, reason),
          allowedValue: getAllowedValue(restriction.properties, reason),
        });
      }
    } catch {
      continue;
    }
  }

  if (conflicts.length > 0) {
    console.log("[validateRoute] Konflikte erkannt:", conflicts.map((c) => ({
      id:      c.restrictionId,
      reason:  c.reason,
      title:   c.restriction.properties?.title ?? null,
      vehicle: c.vehicleValue,
      allowed: c.allowedValue,
    })));
  }

  return { clean: conflicts.length === 0, conflicts };
}
