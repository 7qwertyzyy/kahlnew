import type { AnfrageMatch } from "@/lib/types";

export default function RiskSummaryPanel({
  summary,
  matches,
}: {
  summary: string | null;
  matches: AnfrageMatch[];
}) {
  const flags = [
    matches.some((m) => m.begleitpflicht_in_altfall) && "Begleitfahrzeug in Altfällen erkannt",
    matches.some((m) => m.polizei_in_altfall) && "Polizeibeteiligung in Altfällen erkannt",
    matches.some((m) => m.nachtfahrt_in_altfall) && "Nachtfahrtpflicht in Altfällen erkannt",
  ].filter(Boolean) as string[];

  return (
    <section className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-300 mb-3">Risiken</h2>
      <div className="space-y-2 text-sm text-gray-300 whitespace-pre-line">
        {summary || "Noch keine Risikozusammenfassung vorhanden."}
        {flags.length > 0 && (
          <ul className="pt-2 text-yellow-300 space-y-1">
            {flags.map((flag) => (
              <li key={flag}>- {flag}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
