"use client";

import type { VehicleMode } from "@/lib/types";

interface VehicleModeToggleProps {
  mode: VehicleMode;
  onChange: (mode: VehicleMode) => void;
}

const MODES: { value: VehicleMode; label: string; desc: string }[] = [
  { value: "STD", label: "STD", desc: "Standard-LKW" },
  { value: "GST", label: "GST", desc: "Großraumtransport" },
  { value: "ST", label: "ST", desc: "Schwertransport" },
];

export default function VehicleModeToggle({ mode, onChange }: VehicleModeToggleProps) {
  return (
    <div className="flex gap-1 rounded-lg bg-gray-800 p-1">
      {MODES.map((m) => (
        <button
          key={m.value}
          title={m.desc}
          onClick={() => onChange(m.value)}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-bold transition-all ${
            mode === m.value
              ? "bg-blue-600 text-white shadow"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
