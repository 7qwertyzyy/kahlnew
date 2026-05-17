import type { GeocodingResult } from "./types";

export async function geocodeAddress(query: string): Promise<GeocodingResult[]> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) throw new Error("Mapbox-Token fehlt.");

  const encoded = encodeURIComponent(query);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&country=de&language=de&limit=5&types=place,address,poi`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding-Fehler: ${res.status}`);

  const data = await res.json();
  return (data.features ?? []).map((f: { place_name: string; center: [number, number] }) => ({
    place_name: f.place_name,
    center: f.center,
  }));
}
