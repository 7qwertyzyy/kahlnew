"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import type { TransportAnfrage } from "@/lib/types";
import AnfrageStatusBadge from "@/components/anfrage/AnfrageStatusBadge";
import BriefingView from "@/components/anfrage/BriefingView";
import MatchPanel from "@/components/anfrage/MatchPanel";
import CustomerReplyDraft from "@/components/anfrage/CustomerReplyDraft";

type Tab = "briefing" | "matches" | "reply" | "original";

export default function AnfrageDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [anfrage, setAnfrage] = useState<TransportAnfrage | null>(null);
  const [tab, setTab] = useState<Tab>("briefing");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAnfrage(id).then(setAnfrage).catch((e) => setError(e.message));
  }, [id]);

  async function updateStatus(status: string) {
    const updated = await api.updateAnfrageStatus(id, status);
    setAnfrage(updated);
  }

  async function regenerateBriefing() {
    const updated = await api.regenerateBriefing(id);
    setAnfrage(updated);
  }

  if (error) return <div className="p-6 text-red-300 text-sm">{error}</div>;
  if (!anfrage) return <div className="p-6 text-gray-400 text-sm">Lade Anfrage...</div>;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-5">
      <div className="bg-gray-900 rounded-lg p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-white">Anfrage #{anfrage.id} — {anfrage.kunde || "Unbekannter Kunde"}</h1>
              <AnfrageStatusBadge status={anfrage.status} />
            </div>
            <p className="text-sm text-gray-400 mt-1">
              {anfrage.startort || "?"} &rarr; {anfrage.zielort || "?"} | {anfrage.breite_m ?? "?"} x {anfrage.hoehe_m ?? "?"} m | {anfrage.gewicht_t ?? "?"} t
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Erstellt: {anfrage.erstellt_am ? new Date(anfrage.erstellt_am).toLocaleDateString("de-DE") : "-"} | Priorität: {anfrage.prioritaet}
            </p>
          </div>
          <div className="flex gap-2">
            <select className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" value={anfrage.status} onChange={(e) => updateStatus(e.target.value)}>
              <option value="neu">Neu</option>
              <option value="in_bearbeitung">In Bearbeitung</option>
              <option value="angebot_erstellt">Angebot erstellt</option>
              <option value="abgeschlossen">Abgeschlossen</option>
              <option value="storniert">Storniert</option>
            </select>
            <button onClick={regenerateBriefing} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded">
              Briefing neu generieren
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2 border-b border-gray-800">
        {[
          ["briefing", "Briefing"],
          ["matches", "Matches"],
          ["reply", "Kundenantwort"],
          ["original", "Originalanfrage"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key as Tab)}
            className={`px-3 py-2 text-sm border-b-2 ${tab === key ? "border-blue-500 text-white" : "border-transparent text-gray-400 hover:text-white"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "briefing" && <BriefingView anfrage={anfrage} />}
      {tab === "matches" && <MatchPanel anfrage={anfrage} />}
      {tab === "reply" && <CustomerReplyDraft anfrage={anfrage} />}
      {tab === "original" && (
        <section className="bg-gray-900 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Originalanfrage</h2>
          <p className="text-xs text-gray-500 mb-2">Eingabetyp: {anfrage.eingabe_typ}</p>
          <pre className="whitespace-pre-wrap bg-gray-950 rounded border border-gray-800 p-3 text-sm text-gray-300">
            {anfrage.eingabe_rohtext || "Kein Rohtext gespeichert."}
          </pre>
        </section>
      )}
    </div>
  );
}
