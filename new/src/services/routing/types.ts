// src/services/routing/types.ts
import type { Feature, Polygon } from "geojson";

export type Coords = [number, number]; // [lng, lat] – GeoJSON-Konvention

/** Properties wie sie von get_active_restrictions_fc zurückgegeben werden */
export interface RestrictionProperties {
  id?: string;
  external_id?: string;
  kind?: string;         // z.B. "width", "weight", "height", "axle"
  title?: string;
  description?: string;
  max_width_m?: number | null;
  max_height_m?: number | null;
  max_weight_t?: number | null;
  max_axle_t?: number | null;
  no_heavy_transport?: boolean | null;  // true = Schwertransportverbot
  network?: string;      // z.B. "autobahn"
  source?: string;
  region?: string;
  valid_from?: string | null;
  valid_to?: string | null;
}

/** Ein bereits gepuffertes Polygon-Feature aus /api/restrictions */
export type RestrictionPolygon = Feature<Polygon, RestrictionProperties>;

/** Fahrzeugparameter für die Validierung */
export interface VehicleSpec {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
  heavy_transport?: boolean;  // true = Fahrzeug ist als Schwertransport eingestuft
}

/** Ein erkannter Konflikt zwischen Route und einer Restriktion */
export interface RouteConflict {
  restrictionId: string;
  restriction: RestrictionPolygon;
  reason: "width" | "weight" | "height" | "axle" | "closed" | "unknown" | "heavy_transport_ban";
  vehicleValue: number | null;   // Fahrzeugmaß (z.B. 3.5 m Breite)
  allowedValue: number | null;   // Erlaubter Grenzwert (z.B. 3.2 m)
}

/** Ergebnis der Routenvalidierung */
export interface ValidationResult {
  clean: boolean;
  conflicts: RouteConflict[];
}

/** Log-Eintrag für eine einzelne Iteration */
export interface IterationLog {
  iteration: number;
  avoidPolygonCount: number;
  hereStatus: "ok" | "error" | "no_route";
  violatedAvoidArea: boolean;
  conflicts: Array<{
    id: string;
    reason: string;
    vehicleValue: number | null;
    allowedValue: number | null;
    title: string | null;
  }>;
}
