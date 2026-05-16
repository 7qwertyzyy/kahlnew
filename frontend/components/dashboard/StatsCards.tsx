import type { DashboardStats } from "@/lib/types";

interface Props {
  stats: DashboardStats;
}

const CARDS = [
  { key: "total_permits", label: "Gesamt", color: "text-blue-400" },
  { key: "active_permits", label: "Aktiv", color: "text-green-400" },
  { key: "expiring_soon", label: "Läuft ab", color: "text-yellow-400" },
  { key: "needs_review", label: "Zu prüfen", color: "text-orange-400" },
  { key: "expired", label: "Abgelaufen", color: "text-gray-400" },
  { key: "critical_risk", label: "Kritisch", color: "text-red-400" },
] as const;

export default function StatsCards({ stats }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {CARDS.map(({ key, label, color }) => (
        <div key={key} className="bg-gray-800 rounded-lg p-4">
          <div className={`text-3xl font-bold ${color}`}>{stats[key]}</div>
          <div className="text-xs text-gray-400 mt-1">{label}</div>
        </div>
      ))}
    </div>
  );
}
