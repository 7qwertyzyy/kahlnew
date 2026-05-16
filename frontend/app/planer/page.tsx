"use client";

import dynamic from "next/dynamic";
import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { RouteResult, VehicleParams, RouteStop, VehicleMode } from "@/lib/types";
import type { TransportAnfrage } from "@/lib/types";
import { api } from "@/lib/api";
import Sidebar from "@/components/Sidebar";
import Link from "next/link";

const MapView = dynamic(() => import("@/components/Map"), { ssr: false });

const DEFAULT_VEHICLE: VehicleParams = {
  width: 2.55,
  height: 4.0,
  weight: 40,
  axleload: 11.5,
};

const makeStop = (label = ""): RouteStop => ({
  id: crypto.randomUUID(),
  label,
  coordinates: null,
});

function PlanerInner() {
  const searchParams = useSearchParams();

  // Read URL params — label only (no geocoding at mount; user confirms via geocoder)
  const urlStart = searchParams.get("start") ?? "";
  const urlZiel = searchParams.get("ziel") ?? "";
  const urlBreite = parseFloat(searchParams.get("breite") ?? "") || null;
  const urlHoehe = parseFloat(searchParams.get("hoehe") ?? "") || null;
  const urlGewicht = parseFloat(searchParams.get("gewicht") ?? "") || null;
  const urlAchslast = parseFloat(searchParams.get("achslast") ?? "") || null;
  const urlAnfrageId = searchParams.get("anfrage_id");

  const initialVehicle: VehicleParams = {
    width: urlBreite ?? DEFAULT_VEHICLE.width,
    height: urlHoehe ?? DEFAULT_VEHICLE.height,
    weight: urlGewicht ?? DEFAULT_VEHICLE.weight,
    axleload: urlAchslast ?? DEFAULT_VEHICLE.axleload,
  };

  const [vehicleMode, setVehicleMode] = useState<VehicleMode>("STD");
  const [vehicle, setVehicle] = useState<VehicleParams>(initialVehicle);
  const [start, setStart] = useState<RouteStop>(makeStop(urlStart));
  const [end, setEnd] = useState<RouteStop>(makeStop(urlZiel));
  const [waypoints, setWaypoints] = useState<RouteStop[]>([]);
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isRouting, setIsRouting] = useState(false);
  const [showConstructions, setShowConstructions] = useState(true);
  const [showTraffic, setShowTraffic] = useState(false);
  const [filterDate, setFilterDate] = useState<Date>(new Date());
  const [anfrage, setAnfrage] = useState<TransportAnfrage | null>(null);

  const mapFlyToRef = useRef<((coords: [number, number]) => void) | null>(null);

  // Update vehicle if URL params change (e.g. navigated from permit detail)
  useEffect(() => {
    setVehicle({
      width: urlBreite ?? DEFAULT_VEHICLE.width,
      height: urlHoehe ?? DEFAULT_VEHICLE.height,
      weight: urlGewicht ?? DEFAULT_VEHICLE.weight,
      axleload: urlAchslast ?? DEFAULT_VEHICLE.axleload,
    });
    if (urlStart) setStart(makeStop(urlStart));
    if (urlZiel) setEnd(makeStop(urlZiel));
  // Only run when URL params change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  useEffect(() => {
    let cancelled = false;
    if (!urlAnfrageId) {
      Promise.resolve().then(() => {
        if (!cancelled) setAnfrage(null);
      });
      return;
    }
    api.getAnfrage(Number(urlAnfrageId))
      .then((value) => {
        if (!cancelled) setAnfrage(value);
      })
      .catch(() => {
        if (!cancelled) setAnfrage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [urlAnfrageId]);

  const handleCalculateRoute = useCallback(async () => {
    if (!start.coordinates || !end.coordinates) {
      setRouteError("Bitte Start und Ziel angeben.");
      return;
    }
    setIsRouting(true);
    setRouteError(null);
    try {
      const { calculateRoute } = await import("@/lib/openrouteservice");
      const coords: [number, number][] = [
        start.coordinates,
        ...waypoints.filter((w) => w.coordinates).map((w) => w.coordinates!),
        end.coordinates,
      ];
      const result = await calculateRoute(coords, vehicle);
      setRouteResult(result);
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : "Unbekannter Fehler beim Routing.");
    } finally {
      setIsRouting(false);
    }
  }, [start, end, waypoints, vehicle]);

  return (
    <div className="h-full w-full overflow-hidden relative">
      <Sidebar
        vehicleMode={vehicleMode}
        onVehicleModeChange={setVehicleMode}
        vehicle={vehicle}
        onVehicleChange={setVehicle}
        start={start}
        onStartChange={setStart}
        end={end}
        onEndChange={setEnd}
        waypoints={waypoints}
        onWaypointsChange={setWaypoints}
        onCalculateRoute={handleCalculateRoute}
        isRouting={isRouting}
        routeResult={routeResult}
        routeError={routeError}
        showConstructions={showConstructions}
        onShowConstructionsChange={setShowConstructions}
        showTraffic={showTraffic}
        onShowTrafficChange={setShowTraffic}
        filterDate={filterDate}
        onFilterDateChange={setFilterDate}
        mapFlyTo={mapFlyToRef}
      />
      {/* offset left-[380px] for sidebar, top-16 for navbar */}
      <div className="fixed top-16 bottom-0 left-[380px] right-0">
        <MapView
          routeGeoJSON={routeResult?.geojson ?? null}
          showConstructions={showConstructions}
          showTraffic={showTraffic}
          filterDate={filterDate}
          mapFlyToRef={mapFlyToRef}
        />
      </div>
      {anfrage && (
        <div className="fixed right-4 top-20 z-20 w-72 rounded-lg border border-gray-700 bg-gray-900/95 p-4 shadow-xl">
          <h2 className="text-sm font-medium text-white">Anfrage #{anfrage.id}</h2>
          <p className="mt-1 text-xs text-gray-300">{anfrage.kunde || "Unbekannter Kunde"} | {anfrage.transportgut || "Transportgut"}</p>
          <p className="mt-2 text-xs text-gray-400">{anfrage.matches.length} ähnliche Genehmigungen</p>
          <Link href={`/anfrage/${anfrage.id}`} className="mt-3 inline-block rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500">
            Zurück zum Briefing
          </Link>
        </div>
      )}
    </div>
  );
}

export default function PlanerPage() {
  return (
    <Suspense>
      <PlanerInner />
    </Suspense>
  );
}
