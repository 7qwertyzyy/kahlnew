"use client";

import { useState } from "react";
import { Route, Clock, ChevronDown, ChevronRight, Navigation } from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/openrouteservice";
import type { RouteResult as RouteResultType } from "@/lib/types";

const STEP_ICONS: Record<number, string> = {
  0: "→",  // straight
  1: "↗",  // slight right
  2: "→",  // right
  3: "↘",  // sharp right
  4: "↔",  // u-turn
  5: "↙",  // sharp left
  6: "←",  // left
  7: "↖",  // slight left
  8: "⬆",  // continue
  10: "↑", // roundabout
  11: "↑", // roundabout
  12: "🏁", // arrive
};

interface RouteResultProps {
  result: RouteResultType;
}

export default function RouteResult({ result }: RouteResultProps) {
  const [showSteps, setShowSteps] = useState(false);

  const allSteps = result.segments.flatMap((s) => s.steps);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2.5 bg-gray-800 flex items-center gap-2">
        <Route size={15} className="text-blue-400" />
        <span className="text-sm font-medium">Routenergebnis</span>
        <span className="ml-auto text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded-full">
          {allSteps.length} Manöver
        </span>
      </div>

      <div className="p-3 space-y-3 bg-gray-850">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-700 rounded-lg p-2.5 text-center">
            <div className="flex items-center justify-center gap-1 text-gray-400 text-xs mb-1">
              <Route size={11} />
              <span>Distanz</span>
            </div>
            <p className="text-blue-300 font-semibold text-sm">
              {formatDistance(result.distance)}
            </p>
          </div>
          <div className="bg-gray-700 rounded-lg p-2.5 text-center">
            <div className="flex items-center justify-center gap-1 text-gray-400 text-xs mb-1">
              <Clock size={11} />
              <span>Fahrzeit</span>
            </div>
            <p className="text-blue-300 font-semibold text-sm">
              {formatDuration(result.duration)}
            </p>
          </div>
        </div>

        {/* Turn-by-turn toggle */}
        <button
          onClick={() => setShowSteps((v) => !v)}
          className="flex items-center justify-between w-full py-1.5 px-2 rounded-md bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            <Navigation size={12} />
            <span>Abbiegehinweise</span>
          </div>
          {showSteps ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        {showSteps && (
          <div className="space-y-1 max-h-64 overflow-y-auto sidebar-scroll">
            {allSteps.map((step, i) => (
              <div
                key={i}
                className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-700 transition-colors"
              >
                <span className="text-blue-400 text-sm w-4 shrink-0 mt-0.5">
                  {STEP_ICONS[step.type] ?? "→"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-200 leading-snug">{step.instruction}</p>
                  {step.name && step.name !== "-" && (
                    <p className="text-xs text-gray-500 truncate">{step.name}</p>
                  )}
                </div>
                <span className="text-xs text-gray-500 shrink-0 text-right">
                  {formatDistance(step.distance)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
