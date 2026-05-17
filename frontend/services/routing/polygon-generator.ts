// src/services/routing/polygon-generator.ts
//
// Adaptive Avoid-Polygon-Erzeugung für den Validierungs-Loop.
//
// Strategie:
//   Iteration 0 → Polygon direkt aus PostGIS verwenden (bereits gepuffert)
//   Iteration 1 → +50 m zusätzlicher Turf-Buffer
//   Iteration 2 → +100 m
//   Iteration 3 → +200 m
//   Iteration 4 → +350 m
//   Iteration 5+ → +500 m (Maximum)
//
// Warum nicht von Anfang an maximal groß?
//   Zu große Polygone blockieren Alternativrouten und HERE findet keinen Weg mehr.
//   Die schrittweise Eskalation gibt HERE die Chance, kleine Umfahrungen zu finden,
//   bevor wir mit großen Sperrzonen eingreifen.

import buffer from "@turf/buffer";
import type { Feature, Polygon } from "geojson";
import type { RestrictionPolygon } from "./types";

/** Extra-Buffer in Metern pro Eskalationsstufe (Index = attemptCount) */
const ESCALATION_STEPS_M = [0, 50, 100, 200, 350, 500] as const;

/** Max Buffer in Metern (über diesen Wert geht kein Sinn mehr) */
export const MAX_BUFFER_M = 500;

/**
 * Gibt das Restriction-Polygon zurück, ggf. mit zusätzlichem Turf-Buffer,
 * wenn vorangegangene Routing-Versuche erfolglos waren (HERE hat das Polygon ignoriert
 * oder die Route führt trotzdem hindurch).
 *
 * @param restriction  Original-Polygon aus /api/restrictions (PostGIS-gepuffert)
 * @param attemptCount Anzahl bisheriger Versuche für diese Restriction (0 = erster Versuch)
 */
export function escalatePolygon(
  restriction: RestrictionPolygon,
  attemptCount: number
): Feature<Polygon> | null {
  const idx = Math.min(Math.max(0, attemptCount), ESCALATION_STEPS_M.length - 1);
  const extraM = ESCALATION_STEPS_M[idx];

  // Erster Versuch: Polygon unverändert verwenden
  if (extraM === 0) {
    return restriction as unknown as Feature<Polygon>;
  }

  try {
    const buffered = buffer(restriction as any, extraM / 1000, { units: "kilometers" });
    if (!buffered) return restriction as unknown as Feature<Polygon>;
    // Properties erhalten (Titel, Kind etc. für Logging)
    (buffered as any).properties = restriction.properties;
    return buffered as Feature<Polygon>;
  } catch {
    // Buffer-Fehler → Original zurückgeben
    return restriction as unknown as Feature<Polygon>;
  }
}
