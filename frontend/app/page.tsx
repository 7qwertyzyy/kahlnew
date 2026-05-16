"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { AnfragenStats, DashboardStats, Permit, TransportAnfrage } from "@/lib/types";
import StatsCards from "@/components/dashboard/StatsCards";
import ExpiringPermits from "@/components/dashboard/ExpiringPermits";
import StatusBadge from "@/components/shared/StatusBadge";

const EMPTY_STATS: DashboardStats = {
  total_permits: 0,
  active_permits: 0,
  expiring_soon: 0,
  needs_review: 0,
  expired: 0,
  critical_risk: 0,
};

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [expiring, setExpiring] = useState<Permit[]>([]);
  const [recent, setRecent] = useState<Permit[]>([]);
  const [anfragenStats, setAnfragenStats] = useState<AnfragenStats | null>(null);
  const [recentAnfragen, setRecentAnfragen] = useState<TransportAnfrage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getExpiringPermits(30),
      api.getPermits({ limit: 5, sort: "erstellt_am" }),
      api.getAnfragenStats(),
      api.getAnfragen({ limit: "3" }),
    ])
      .then(([s, exp, rec, aStats, aRecent]) => {
        setStats(s);
        setExpiring(exp);
        setRecent(rec.items);
        setAnfragenStats(aStats);
        setRecentAnfragen(aRecent);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Dashboard</h1>
        <div className="flex gap-2">
          <Link
            href="/genehmigungen/upload"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded transition-colors"
          >
            + Genehmigung hochladen
          </Link>
          <Link
            href="/planer"
            className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-4 py-2 rounded transition-colors"
          >
            Streckenplaner
          </Link>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded p-3 text-red-300 text-sm">
          Backend nicht erreichbar: {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Lade Daten...</div>
      ) : (
        <>
          <StatsCards stats={stats} />

          <section className="bg-gray-900 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-300">Offene Anfragen</h2>
              <Link href="/anfrage" className="text-xs text-blue-400 hover:underline">
                Alle Anfragen
              </Link>
            </div>
            <div className="text-sm text-gray-300 mb-3">
              {(anfragenStats?.neu ?? 0) + (anfragenStats?.in_bearbeitung ?? 0)} offen
              <span className="text-gray-600 px-2">|</span>
              {anfragenStats?.dringend ?? 0} dringend
              <span className="text-gray-600 px-2">|</span>
              {anfragenStats?.diese_woche ?? 0} diese Woche
            </div>
            {recentAnfragen.length === 0 ? (
              <p className="text-gray-400 text-sm">Noch keine Transportanfragen erfasst.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {recentAnfragen.map((a) => (
                  <li key={a.id}>
                    <Link href={`/anfrage/${a.id}`} className="text-blue-400 hover:underline">
                      {a.kunde || `Anfrage #${a.id}`} - {a.startort || "?"} &rarr; {a.zielort || "?"} ({a.status})
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-gray-900 rounded-lg p-4">
            <h2 className="text-sm font-medium text-gray-300 mb-3">
              Bald ablaufende Genehmigungen (30 Tage)
            </h2>
            <ExpiringPermits permits={expiring} />
          </section>

          <section className="bg-gray-900 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-300">Letzte Uploads</h2>
              <Link href="/genehmigungen" className="text-xs text-blue-400 hover:underline">
                Alle anzeigen
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="text-gray-400 text-sm">Noch keine Genehmigungen importiert.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-400 text-left border-b border-gray-700">
                      <th className="pb-2 pr-4">Datei</th>
                      <th className="pb-2 pr-4">Typ</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2">Hochgeladen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((p) => (
                      <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                        <td className="py-2 pr-4">
                          <Link href={`/genehmigungen/${p.id}`} className="text-blue-400 hover:underline">
                            {p.dateiname || `#${p.id}`}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-gray-400 uppercase text-xs">
                          {p.dateityp || "—"}
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={p.status} size="sm" />
                        </td>
                        <td className="py-2 text-gray-400">
                          {p.erstellt_am
                            ? new Date(p.erstellt_am).toLocaleDateString("de-DE")
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
