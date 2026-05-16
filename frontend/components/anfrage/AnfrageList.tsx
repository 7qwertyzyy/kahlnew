import Link from "next/link";
import type { TransportAnfrage } from "@/lib/types";
import AnfrageStatusBadge from "./AnfrageStatusBadge";

export default function AnfrageList({ anfragen }: { anfragen: TransportAnfrage[] }) {
  if (anfragen.length === 0) {
    return <div className="bg-gray-900 rounded-lg p-6 text-sm text-gray-400">Keine Anfragen gefunden.</div>;
  }

  return (
    <div className="overflow-x-auto bg-gray-900 rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-400 border-b border-gray-700">
            <th className="p-3">#</th>
            <th className="p-3">Kunde</th>
            <th className="p-3">Strecke</th>
            <th className="p-3">Maße</th>
            <th className="p-3">Prio</th>
            <th className="p-3">Status</th>
            <th className="p-3"></th>
          </tr>
        </thead>
        <tbody>
          {anfragen.map((a) => (
            <tr key={a.id} className="border-b border-gray-800 hover:bg-gray-800/70">
              <td className="p-3 text-gray-500 font-mono">{a.id}</td>
              <td className="p-3 text-gray-100">{a.kunde || "-"}</td>
              <td className="p-3 text-gray-300">{a.startort || "?"} &rarr; {a.zielort || "?"}</td>
              <td className="p-3 text-gray-400">{a.breite_m ?? "?"} m | {a.gewicht_t ?? "?"} t<br /><span className="text-xs">{a.match_count} Matches</span></td>
              <td className="p-3 text-gray-300">{a.prioritaet}</td>
              <td className="p-3"><AnfrageStatusBadge status={a.status} /></td>
              <td className="p-3 text-right">
                <Link href={`/anfrage/${a.id}`} className="text-blue-400 hover:underline">
                  Öffnen
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
