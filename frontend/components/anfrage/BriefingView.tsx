import type { TransportAnfrage } from "@/lib/types";
import AnfrageExtractionView from "./AnfrageExtractionView";
import MissingInfoPanel from "./MissingInfoPanel";
import RiskSummaryPanel from "./RiskSummaryPanel";

export default function BriefingView({ anfrage }: { anfrage: TransportAnfrage }) {
  const b = anfrage.kalkulations_briefing;
  return (
    <div className="space-y-4">
      <section className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-2">Zusammenfassung</h2>
        <p className="text-sm text-gray-100">{b?.zusammenfassung || anfrage.ki_einschaetzung || "Noch kein Briefing vorhanden."}</p>
      </section>

      <AnfrageExtractionView anfrage={anfrage} />

      <section className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-3">Erkenntnisse aus Altfällen</h2>
        <p className="text-sm text-gray-300 whitespace-pre-line">{b?.erkenntnisse_aus_altfaellen || "Keine Altfall-Auswertung vorhanden."}</p>
      </section>

      <RiskSummaryPanel summary={b?.risiko_zusammenfassung || anfrage.risiko_zusammenfassung} matches={anfrage.matches} />
      <MissingInfoPanel items={b?.fehlende_informationen?.length ? b.fehlende_informationen : anfrage.fehlende_infos} />

      <section className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-3">Empfohlene nächste Schritte</h2>
        <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
          {(b?.empfohlene_naechste_schritte?.length ? b.empfohlene_naechste_schritte : anfrage.empfohlene_naechste_schritte).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Hint title="Kalkulation" text={b?.hinweis_kalkulation} />
        <Hint title="Genehmigung" text={b?.hinweis_genehmigung} />
        <Hint title="Disposition" text={b?.hinweis_disposition} />
      </section>
    </div>
  );
}

function Hint({ title, text }: { title: string; text?: string }) {
  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-300 mb-2">{title}</h3>
      <p className="text-sm text-gray-400">{text || "-"}</p>
    </div>
  );
}
