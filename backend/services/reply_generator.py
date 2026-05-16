from services.ki_client import call_ai


PROMPT = """Du bist ein Mitarbeiter einer Schwertransport-Spedition und schreibst eine professionelle, freundliche Antwort auf eine Kundenanfrage.

Kontext:
- Firmenname: Kahl Schwerlast
- Zweck: Fehlende Informationen beim Kunden nachfragen ODER Eingang bestaetigen
- Ton: professionell, freundlich, direkt, keine Floskeln

Regeln:
- Wenn fehlende_infos leer ist: Schreibe eine kurze Eingangsbestaetigung mit Hinweis auf Pruefung.
- Wenn fehlende_infos vorhanden: Bedanke dich fuer die Anfrage und frage die fehlenden Infos hoeflich aber konkret nach.
- Verwende "Sie"-Anrede.
- Unterschrift: "Mit freundlichen Gruessen\\nKahl Schwerlast GmbH"
- Maximal 150 Woerter.
- Gib NUR den E-Mail-Text zurueck, kein JSON, keine Erklaerung.

Kundenname: {kunde}
Ansprechpartner: {ansprechpartner}
Fehlende Informationen: {fehlende_infos}
Transportgut: {transportgut}
Strecke: {startort} -> {zielort}
"""


def generate_customer_reply(anfrage: dict) -> str:
    missing = anfrage.get("fehlende_infos") or []
    try:
        return call_ai(
            PROMPT.format(
                kunde=anfrage.get("kunde") or "",
                ansprechpartner=anfrage.get("ansprechpartner") or "",
                fehlende_infos=", ".join(missing),
                transportgut=anfrage.get("transportgut") or "",
                startort=anfrage.get("startort") or "",
                zielort=anfrage.get("zielort") or "",
            ),
            max_tokens=700,
        ).strip()
    except Exception:
        return _fallback(anfrage)


def _fallback(anfrage: dict) -> str:
    name = anfrage.get("ansprechpartner") or "Damen und Herren"
    missing = anfrage.get("fehlende_infos") or []
    route = ""
    if anfrage.get("startort") or anfrage.get("zielort"):
        route = f" von {anfrage.get('startort') or '?'} nach {anfrage.get('zielort') or '?'}"
    lines = [f"Sehr geehrte {name},", "", f"vielen Dank fuer Ihre Anfrage{route}."]
    if missing:
        lines += ["", "Fuer die weitere Pruefung und Kalkulation benoetigen wir noch folgende Informationen:"]
        lines += [f"- {item}" for item in missing]
        lines += ["", "Nach Erhalt der Daten pruefen wir Strecke, Genehmigungssituation und Verfuegbarkeit."]
    else:
        lines += ["", "Wir pruefen die Angaben zur Strecke, Genehmigungssituation und Verfuegbarkeit und melden uns mit den naechsten Schritten."]
    lines += ["", "Mit freundlichen Gruessen", "Kahl Schwerlast GmbH"]
    return "\n".join(lines)
