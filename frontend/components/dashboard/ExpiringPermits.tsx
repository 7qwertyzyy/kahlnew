import Link from "next/link";
import type { Permit } from "@/lib/types";
import RiskBadge from "@/components/shared/RiskBadge";

interface Props {
  permits: Permit[];
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

export default function ExpiringPermits({ permits }: Props) {
  if (permits.length === 0) {
    return (
      <p className="text-gray-400 text-sm">Keine ablaufenden Genehmigungen in den nächsten 30 Tagen.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-left border-b border-gray-700">
            <th className="pb-2 pr-4">Nr.</th>
            <th className="pb-2 pr-4">Kunde</th>
            <th className="pb-2 pr-4">Strecke</th>
            <th className="pb-2 pr-4">Gültig bis</th>
            <th className="pb-2 pr-4">Tage</th>
            <th className="pb-2">Risiko</th>
          </tr>
        </thead>
        <tbody>
          {permits.map((p) => {
            const days = daysUntil(p.gueltig_bis);
            return (
              <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                <td className="py-2 pr-4">
                  <Link href={`/genehmigungen/${p.id}`} className="text-blue-400 hover:underline">
                    {p.genehmigungsnummer || `#${p.id}`}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-gray-300">{p.kunde || "—"}</td>
                <td className="py-2 pr-4 text-gray-300">
                  {p.startort && p.zielort ? `${p.startort} → ${p.zielort}` : "—"}
                </td>
                <td className="py-2 pr-4 text-gray-300">{p.gueltig_bis || "—"}</td>
                <td className="py-2 pr-4">
                  <span className={days !== null && days <= 7 ? "text-red-400 font-bold" : "text-yellow-400"}>
                    {days !== null ? `${days}d` : "—"}
                  </span>
                </td>
                <td className="py-2">
                  <RiskBadge level={p.risikostufe} size="sm" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
