import json
import re

from services.ki_client import call_ai


EMPTY_ANFRAGE = {
    "kunde": None,
    "ansprechpartner": None,
    "email": None,
    "telefon": None,
    "startort": None,
    "start_adresse": None,
    "zielort": None,
    "ziel_adresse": None,
    "transportgut": None,
    "laenge_m": None,
    "breite_m": None,
    "hoehe_m": None,
    "gewicht_t": None,
    "achslast_t": None,
    "fahrzeugtyp": None,
    "anzahl_fahrten": None,
    "wunschdatum": None,
    "frist_angebot": None,
    "besonderheiten": [],
    "fehlende_infos": [],
    "schwertransport_relevant": None,
    "geschaetzte_komplexitaet": None,
}


PROMPT = """Du bist ein Assistent fuer eine Schwertransport-Spedition. Du liest Kundenanfragen und extrahierst strukturierte Daten.

Extrahiere aus dem folgenden Anfragetext alle erkennbaren Informationen. Wenn ein Feld nicht eindeutig vorhanden ist, setze null. Rate nicht.

Antworte ausschliesslich mit validem JSON:

{
  "kunde": null,
  "ansprechpartner": null,
  "email": null,
  "telefon": null,
  "startort": null,
  "start_adresse": null,
  "zielort": null,
  "ziel_adresse": null,
  "transportgut": null,
  "laenge_m": null,
  "breite_m": null,
  "hoehe_m": null,
  "gewicht_t": null,
  "achslast_t": null,
  "fahrzeugtyp": null,
  "anzahl_fahrten": null,
  "wunschdatum": null,
  "frist_angebot": null,
  "besonderheiten": [],
  "fehlende_infos": [],
  "schwertransport_relevant": null,
  "geschaetzte_komplexitaet": null
}

Regeln fuer fehlende_infos:
- Pruefe ob folgende Infos vorhanden sind. Wenn nicht, fuege sie zur Liste hinzu:
  - "Exakte Ladeadresse" (wenn nur Stadt aber keine Strasse)
  - "Exakte Entladeadresse" (wenn nur Stadt aber keine Strasse)
  - "Achslasten" (wenn nicht genannt)
  - "Technische Zeichnung oder Ladungsdatenblatt" (wenn keine Detailmasse)
  - "Gewuenschter genauer Transporttermin" (wenn nur vage Zeitangabe)
  - "Fahrzeugtyp oder -anforderung" (wenn nicht genannt)
  - "Anzahl Fahrten" (wenn unklar ob einmalig oder mehrfach)
  - "Kontaktdaten" (wenn weder E-Mail noch Telefon)
  - "Ladungsbeschreibung / Transportgut" (wenn unklar was transportiert wird)

Regeln fuer schwertransport_relevant:
- true wenn Breite > 2.55m ODER Hoehe > 4.00m ODER Gewicht > 40t ODER Laenge > 16.5m
- false wenn alle Werte unter diesen Grenzen
- null wenn Masse nicht bekannt

Regeln fuer geschaetzte_komplexitaet:
- "einfach": Standardmasse, kurze Strecke, keine besonderen Anforderungen
- "mittel": leicht uebermassig, normale Strecke
- "komplex": deutlich uebermassig, lange Strecke, besondere Anforderungen
- "sehr_komplex": extrem uebermassig, spezielle Fahrzeuge, Kran, enge Zufahrten etc.

Anfragetext:
{anfrage_text}
"""


def extract_anfrage_data(text: str) -> dict:
    if not text or not text.strip():
        return _post_process(dict(EMPTY_ANFRAGE))
    try:
        raw = call_ai(PROMPT.format(anfrage_text=text[:50000]), max_tokens=2500)
        data = _parse_json(raw)
    except Exception:
        data = _heuristic_extract(text)
    return _post_process({**EMPTY_ANFRAGE, **data})


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```\s*$", "", raw)
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    return json.loads(match.group(0) if match else raw)


def _heuristic_extract(text: str) -> dict:
    data = dict(EMPTY_ANFRAGE)
    email = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)
    phone = re.search(r"(?:\+?\d[\d\s/().-]{6,}\d)", text)
    route = re.search(r"von\s+([A-ZÄÖÜ][\wÄÖÜäöüß .-]+?)\s+nach\s+([A-ZÄÖÜ][\wÄÖÜäöüß .-]+?)(?:\s+fuer|\s+für|\.|,|$)", text, re.I)
    data["email"] = email.group(0) if email else None
    data["telefon"] = phone.group(0).strip() if phone else None
    if route:
        data["startort"] = route.group(1).strip()
        data["zielort"] = route.group(2).strip()
    for key, patterns in {
        "laenge_m": [r"(\d+(?:[,.]\d+)?)\s*m\s+lang", r"laenge[:\s]+(\d+(?:[,.]\d+)?)"],
        "breite_m": [r"(\d+(?:[,.]\d+)?)\s*m\s+breit", r"breite[:\s]+(\d+(?:[,.]\d+)?)"],
        "hoehe_m": [r"(\d+(?:[,.]\d+)?)\s*m\s+hoch", r"hoehe[:\s]+(\d+(?:[,.]\d+)?)"],
        "gewicht_t": [r"(\d+(?:[,.]\d+)?)\s*t(?:onnen)?", r"gewicht[:\s]+(\d+(?:[,.]\d+)?)"],
        "achslast_t": [r"achslast(?:en)?[:\s]+(\d+(?:[,.]\d+)?)"],
    }.items():
        for pattern in patterns:
            m = re.search(pattern, text, re.I)
            if m:
                data[key] = float(m.group(1).replace(",", "."))
                break
    good = re.search(r"(?:fuer|für)\s+(?:ein|eine|einen)?\s*([A-Za-zÄÖÜäöüß -]*(?:teil|maschine|transformator|anlage|behaelter|behälter))", text, re.I)
    data["transportgut"] = good.group(1).strip() if good else None
    firma = re.search(r"(?:Viele Gruesse|Viele Grüße|Mit freundlichen Gruessen|Mit freundlichen Grüßen),?\s*([\wÄÖÜäöüß .&-]+)", text, re.I)
    data["kunde"] = firma.group(1).strip() if firma else None
    return data


def _post_process(data: dict) -> dict:
    missing = list(data.get("fehlende_infos") or [])
    def add(label: str):
        if label not in missing:
            missing.append(label)

    if data.get("startort") and not data.get("start_adresse"):
        add("Exakte Ladeadresse")
    if data.get("zielort") and not data.get("ziel_adresse"):
        add("Exakte Entladeadresse")
    if data.get("achslast_t") is None:
        add("Achslasten")
    if any(data.get(k) is None for k in ["laenge_m", "breite_m", "hoehe_m", "gewicht_t"]):
        add("Technische Zeichnung oder Ladungsdatenblatt")
    if not data.get("wunschdatum"):
        add("Gewuenschter genauer Transporttermin")
    if not data.get("fahrzeugtyp"):
        add("Fahrzeugtyp oder -anforderung")
    if not data.get("anzahl_fahrten"):
        add("Anzahl Fahrten")
    if not data.get("email") and not data.get("telefon"):
        add("Kontaktdaten")
    if not data.get("transportgut"):
        add("Ladungsbeschreibung / Transportgut")
    data["fehlende_infos"] = missing

    dims = [data.get("breite_m"), data.get("hoehe_m"), data.get("gewicht_t"), data.get("laenge_m")]
    if all(v is not None for v in dims):
        data["schwertransport_relevant"] = (
            data["breite_m"] > 2.55 or data["hoehe_m"] > 4.0 or data["gewicht_t"] > 40 or data["laenge_m"] > 16.5
        )
    if data.get("geschaetzte_komplexitaet") is None:
        if (data.get("breite_m") or 0) >= 4.0 or (data.get("gewicht_t") or 0) >= 80:
            data["geschaetzte_komplexitaet"] = "sehr_komplex"
        elif (data.get("breite_m") or 0) >= 3.2 or (data.get("gewicht_t") or 0) >= 60:
            data["geschaetzte_komplexitaet"] = "komplex"
        elif data.get("schwertransport_relevant"):
            data["geschaetzte_komplexitaet"] = "mittel"
    return data
