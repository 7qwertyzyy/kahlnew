"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { TransportAnfrage } from "@/lib/types";
import AnfrageList from "@/components/anfrage/AnfrageList";

export default function AnfragePage() {
  const [items, setItems] = useState<TransportAnfrage[]>([]);
  const [status, setStatus] = useState("");
  const [prioritaet, setPrioritaet] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAnfragen({ status, prioritaet, q })
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [status, prioritaet, q]);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Transportanfragen</h1>
        <Link href="/anfrage/neu" className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded">
          + Neue Anfrage
        </Link>
      </div>

      <div className="bg-gray-900 rounded-lg p-4 flex flex-wrap gap-3">
        <select className={CONTROL} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Alle Status</option>
          <option value="neu">Neu</option>
          <option value="in_bearbeitung">In Bearbeitung</option>
          <option value="angebot_erstellt">Angebot erstellt</option>
          <option value="abgeschlossen">Abgeschlossen</option>
        </select>
        <select className={CONTROL} value={prioritaet} onChange={(e) => setPrioritaet(e.target.value)}>
          <option value="">Alle Prioritäten</option>
          <option value="normal">Normal</option>
          <option value="hoch">Hoch</option>
          <option value="dringend">Dringend</option>
        </select>
        <input className={`${CONTROL} min-w-64`} placeholder="Suche Kunde, Strecke, Text" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <div className="bg-red-900/40 border border-red-700 rounded p-3 text-red-300 text-sm">{error}</div>}
      {loading ? <div className="text-sm text-gray-400">Lade Anfragen...</div> : <AnfrageList anfragen={items} />}
    </div>
  );
}

const CONTROL = "bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500";
