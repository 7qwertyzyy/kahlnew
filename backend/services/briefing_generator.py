import json
import re

from services.ki_client import call_ai


PROMPT = """Du bist ein interner Assistent einer Schwertransport-Spedition. Erstelle ein strukturiertes Kalkulationsbriefing fuer die interne Weiterverarbeitung.

Schreibe auf Deutsch. Schreibe klar, knapp und operativ nuetzlich. Kein Marketing, keine Floskeln.

Antworte ausschliesslich mit validem JSON:

{
  "zusammenfassung": "Ein Satz: Was ist die Anfrage?",
  "anfrage_bewertung": "2-3 Saetze: Ist das schwertransportrelevant? Wie komplex? Was faellt auf?",
  "strecken_einschaetzung": "2-3 Saetze: Welche Route ist wahrscheinlich? Welche Autobahnen? Welche Regionen?",
  "genehmigungshinweis": "2-3 Saetze: Braucht man wahrscheinlich eine Genehmigung? Wenn ja, welche Art? Basierend auf den Massen.",
  "erkenntnisse_aus_altfaellen": "3-5 Saetze: Was wissen wir aus aehnlichen alten Genehmigungen?",
  "risiko_zusammenfassung": "Bullet-Points: Welche Risiken bestehen?",
  "fehlende_informationen": ["Liste: Was fehlt noch vom Kunden?"],
  "empfohlene_naechste_schritte": ["Liste: Was soll intern als naechstes passieren?"],
  "hinweis_kalkulation": "2-3 Saetze",
  "hinweis_genehmigung": "2-3 Saetze",
  "hinweis_disposition": "2-3 Saetze"
}

Eingabedaten:

Anfrage:
{anfrage_json}

Aehnliche Altgenehmigungen:
{matches_json}
"""


def generate_briefing(anfrage: dict, matches: list[dict]) -> dict:
    try:
        raw = call_ai(
            PROMPT.format(
                anfrage_json=json.dumps(anfrage, ensure_ascii=False),
                matches_json=json.dumps(matches, ensure_ascii=False),
            ),
            max_tokens=3000,
        )
        return _parse_json(raw)
    except Exception:
        return _fallback(anfrage, matches)


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```\s*$", "", raw)
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    return json.loads(match.group(0) if match else raw)


def _fallback(anfrage: dict, matches: list[dict]) -> dict:
    start = anfrage.get("startort") or "unbekannter Start"
    ziel = anfrage.get("zielort") or "unbekanntes Ziel"
    gut = anfrage.get("transportgut") or "Transportgut"
    flags = {
        "begleitung": sum(1 for m in matches if m.get("begleitpflicht_in_altfall")),
        "polizei": sum(1 for m in matches if m.get("polizei_in_altfall")),
        "nacht": sum(1 for m in matches if m.get("nachtfahrt_in_altfall")),
    }
    risks = []
    if flags["begleitung"]:
        risks.append(f"Begleitfahrzeug in {flags['begleitung']} aehnlichen Altfaellen erforderlich.")
    if flags["polizei"]:
        risks.append(f"Polizeibeteiligung in {flags['polizei']} aehnlichen Altfaellen erkannt.")
    if flags["nacht"]:
        risks.append(f"Nachtfahrtpflicht in {flags['nacht']} aehnlichen Altfaellen erkannt.")
    if anfrage.get("achslast_t") is None:
        risks.append("Achslasten fehlen; Bruecken- und Streckenbewertung ist nur eingeschraenkt moeglich.")

    next_steps = [
        "Fehlende Kundeninformationen nachfordern.",
        "Aehnliche Altgenehmigungen fachlich pruefen.",
        "Genehmigungsbedarf und voraussichtliche Auflagen bewerten.",
        "Fahrzeug- und Begleitverfuegbarkeit intern pruefen.",
    ]
    return {
        "zusammenfassung": f"Anfrage fuer {gut} von {start} nach {ziel}.",
        "anfrage_bewertung": f"Schwertransportrelevanz: {anfrage.get('schwertransport_relevant')}. Komplexitaet: {anfrage.get('geschaetzte_komplexitaet') or 'unklar'}. Mass- und Gewichtsdaten sind fuer die Kalkulation massgeblich.",
        "strecken_einschaetzung": f"Die Route ist zwischen {start} und {ziel} zu planen. Autobahn- und Baustellensituation muss im Streckenplaner konkret geprueft werden.",
        "genehmigungshinweis": "Auf Basis der angegebenen Masse ist eine Genehmigung wahrscheinlich erforderlich." if anfrage.get("schwertransport_relevant") else "Genehmigungsbedarf ist ohne vollstaendige Masse noch zu pruefen.",
        "erkenntnisse_aus_altfaellen": f"{len(matches)} aehnliche Altgenehmigungen gefunden. " + (" ".join(risks) if risks else "Keine dominanten Auflagenmuster aus Altfaellen erkannt."),
        "risiko_zusammenfassung": "\n".join(f"- {r}" for r in risks) or "- Keine belastbare Risikozusammenfassung ohne weitere Daten.",
        "fehlende_informationen": anfrage.get("fehlende_infos") or [],
        "empfohlene_naechste_schritte": next_steps,
        "hinweis_kalkulation": "Begleitung, Genehmigungsgebuehren, moegliche Nachtfahrt und Wartezeiten als Pruefpositionen aufnehmen.",
        "hinweis_genehmigung": "Altfaelle, Masse, Achslasten und genaue Lade-/Entladeadresse gegen Genehmigungspflichten pruefen.",
        "hinweis_disposition": "Geeigneten Fahrzeugtyp, Begleitfahrzeuge, Zeitfenster und Personalverfuegbarkeit frueh klaeren.",
    }
