"use client";

import { useState, useEffect } from "react";
import { Construction, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { fetchPriorityRoadworks, isActiveAt } from "@/lib/autobahn-api";
import type { Roadwork } from "@/lib/types";

// Module-level cache shared with Map component
let roadworksCache: Roadwork[] | null = null;
let roadworksFetchPromise: Promise<Roadwork[]> | null = null;

async function getRoadworks(): Promise<Roadwork[]> {
  if (roadworksCache) return roadworksCache;
  if (!roadworksFetchPromise) {
    roadworksFetchPromise = fetchPriorityRoadworks().then((data) => {
      roadworksCache = data;
      return data;
    });
  }
  return roadworksFetchPromise;
}

interface ConstructionPanelProps {
  show: boolean;
  onShowChange: (v: boolean) => void;
  filterDate: Date;
  onFilterDateChange: (d: Date) => void;
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function ConstructionPanel({
  show,
  onShowChange,
  filterDate,
  onFilterDateChange,
}: ConstructionPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allRoadworks, setAllRoadworks] = useState<Roadwork[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);

  const loadRoadworks = async () => {
    setLoading(true);
    setError(null);
    // Clear cache to force reload
    roadworksCache = null;
    roadworksFetchPromise = null;
    try {
      const data = await getRoadworks();
      setAllRoadworks(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fehler beim Laden");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getRoadworks()
      .then(setAllRoadworks)
      .catch((e) => setError(e instanceof Error ? e.message : "Fehler beim Laden"));
  }, []);

  useEffect(() => {
    if (!show) {
      setVisibleCount(0);
      return;
    }
    const active = allRoadworks.filter((rw) => isActiveAt(rw, filterDate));
    setVisibleCount(active.length);
  }, [allRoadworks, filterDate, show]);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800 hover:bg-gray-750 text-sm font-medium transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-2">
          <Construction size={15} className="text-orange-400" />
          <span>Baustellen</span>
          {show && (
            <span className="bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full leading-none">
              {visibleCount}
            </span>
          )}
        </div>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>

      {!collapsed && (
        <div className="p-3 space-y-3 bg-gray-850">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={show}
              onChange={(e) => onShowChange(e.target.checked)}
              className="w-4 h-4 rounded accent-blue-500"
            />
            <span className="text-sm text-gray-300">Baustellen anzeigen (aktiv)</span>
          </label>

          <div className="space-y-1">
            <label className="text-xs text-gray-400">Zeitpunkt (lokal)</label>
            <input
              type="datetime-local"
              value={toLocalInputValue(filterDate)}
              onChange={(e) => {
                if (e.target.value) onFilterDateChange(new Date(e.target.value));
              }}
              className="w-full bg-gray-700 border border-gray-600 rounded-md px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-900/30 rounded px-2 py-1">{error}</p>
          )}

          <button
            onClick={loadRoadworks}
            disabled={loading}
            className="flex items-center gap-2 w-full justify-center py-1.5 px-3 rounded-md bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Lade Baustellen…" : "Baustellen neu laden"}
          </button>

          {show && (
            <p className="text-xs text-gray-500 text-center">
              {visibleCount} Baustelle{visibleCount !== 1 ? "n" : ""} sichtbar
            </p>
          )}
        </div>
      )}
    </div>
  );
}
