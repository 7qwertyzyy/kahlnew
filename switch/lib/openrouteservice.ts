import type { RouteResult, VehicleParams } from "./types";

const ORS_BASE = "https://api.openrouteservice.org/v2";

export async function calculateRoute(
  coordinates: [number, number][],
  vehicle: VehicleParams
): Promise<RouteResult> {
  const apiKey = process.env.NEXT_PUBLIC_ORS_API_KEY;
  if (!apiKey) throw new Error("ORS API-Key fehlt. Bitte NEXT_PUBLIC_ORS_API_KEY setzen.");

  const body = {
    coordinates,
    instructions: true,
    language: "de",
    units: "m",
    options: {
      profile_params: {
        restrictions: {
          width: vehicle.width,
          height: vehicle.height,
          weight: vehicle.weight,
          axleload: vehicle.axleload,
        },
      },
    },
  };

  const res = await fetch(`${ORS_BASE}/directions/driving-hgv/geojson`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ORS Fehler ${res.status}: ${err}`);
  }

  const geojson = await res.json();

  const summary = geojson.features?.[0]?.properties?.summary;
  const segments = geojson.features?.[0]?.properties?.segments ?? [];

  return {
    geojson,
    distance: summary?.distance ?? 0,
    duration: summary?.duration ?? 0,
    segments: segments.map((seg: {
      distance: number;
      duration: number;
      steps?: Array<{
        distance: number;
        duration: number;
        instruction: string;
        name: string;
        type: number;
        way_points: [number, number];
      }>;
    }) => ({
      distance: seg.distance,
      duration: seg.duration,
      steps: (seg.steps ?? []).map((step) => ({
        distance: step.distance,
        duration: step.duration,
        instruction: step.instruction,
        name: step.name,
        type: step.type,
        way_points: step.way_points,
      })),
    })),
  };
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} Std. ${m} Min.`;
  return `${m} Min.`;
}
