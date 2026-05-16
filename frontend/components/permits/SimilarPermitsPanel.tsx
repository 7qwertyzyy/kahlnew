"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { MatchResult, VehicleParams } from "@/lib/types";
import RiskBadge from "@/components/shared/RiskBadge";

interface Props {
  startLabel: string;
  endLabel: string;
  vehicle: VehicleParams;
}

export default function SimilarPermitsPanel({ startLabel, endLabel, vehicle }: Props) {
  const [results, setResults] = useState<MatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!startLabel || !endLabel) return;
    setLoading(true);
    api
      .findMatches({
        startort: startLabel.split(",")[0],
        zielort: endLabel.split(",")[0],
        breite_m: vehicle.width,
        hoehe_m: vehicle.height,
        gewicht_t: vehicle.weight,
        achslast_t: vehicle.axleload,
      })
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [startLabel, endLabel, vehicle.width, vehicle.height, vehicle.weight, vehicle.axleload]);

  if (!startLabel || !endLabel) return null;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800 text-sm font-medium text-gray-300 hover:bg-gray-750"
      >
        <span>Ähnliche Genehmigungen {results.length > 0 && `(${results.length})`}</span>
        <span className="text-gray-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="p-3 space-y-2 bg-gray-900">
          {loading && (
            <p className="text-xs text-gray-500">Suche läuft...</p>
          )}
          {!loading && results.length === 0 && (
            <p className="text-xs text-gray-500">Keine ähnlichen Genehmigungen gefunden.</p>
          )}
          {results.slice(0, 5).map((r) => (
            <div key={r.permit.id} className="bg-gray-800 rounded p-2 space-y-1">
              <div className="flex items-center justify-between">
                <Link
                  href={`/genehmigungen/${r.permit.id}`}
                  className="text-blue-400 hover:underline text-xs font-medium"
                >
                  {r.permit.genehmigungsnummer || `#${r.permit.id}`}
                </Link>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-green-400 font-bold">{r.similarity_score}%</span>
                  <RiskBadge level={r.permit.risikostufe} size="sm" />
                </div>
              </div>
              <p className="text-xs text-gray-400">
                {r.permit.startort && r.permit.zielort
                  ? `${r.permit.startort} → ${r.permit.zielort}`
                  : "—"}
              </p>
              {r.match_grund.length > 0 && (
                <p className="text-xs text-gray-600">{r.match_grund[0]}</p>
              )}
            </div>
          ))}
          {results.length > 0 && (
            <Link
              href={`/anfrage?start=${encodeURIComponent(startLabel.split(",")[0])}&ziel=${encodeURIComponent(endLabel.split(",")[0])}`}
              className="block text-center text-xs text-blue-400 hover:underline pt-1"
            >
              Alle Matches anzeigen →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
