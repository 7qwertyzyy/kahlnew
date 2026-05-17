"""
Berechnet Auflagenstärke (Punkte) und Risikostufe für eine Genehmigung.
"""
import re

CONDITION_KEYWORDS = {
    "nachtfahrt": 10,
    "nacht": 8,
    "begleitfahrzeug": 15,
    "begleitpflicht": 15,
    "vorausfahrzeug": 10,
    "polizei": 25,
    "polizeieskorte": 25,
    "brücke": 20,
    "brückenauflage": 20,
    "tunnel": 15,
    "tunnelauflage": 15,
    "wetter": 10,
    "wind": 10,
    "sichtweite": 10,
    "streckenabweichung": 10,
    "keine abweichung": 10,
    "voranmeldung": 10,
    "anmeldepflicht": 10,
    "mehrere behörden": 15,
    "engstelle": 15,
    "engstellen": 15,
    "geschwindigkeit": 5,
    "tempo": 5,
    "sonntagsfahrverbot": 8,
    "feiertag": 8,
    "lichtzeichenanlage": 8,
    "ampel": 8,
    "fahrverbot": 10,
}


def berechne_auflagenstaerke(auflagen: list[str], begleitfahrzeug: bool, polizei: bool, nachtfahrt: bool) -> tuple[int, str]:
    punkte = 0
    text = " ".join(auflagen).lower()

    for keyword, score in CONDITION_KEYWORDS.items():
        if keyword in text:
            punkte += score

    if begleitfahrzeug and "begleitfahrzeug" not in text and "begleitung" not in text:
        punkte += 15
    if polizei and "polizei" not in text:
        punkte += 25
    if nachtfahrt and "nacht" not in text:
        punkte += 10

    punkte = min(punkte, 150)

    if punkte <= 20:
        stufe = "niedrig"
    elif punkte <= 45:
        stufe = "mittel"
    elif punkte <= 75:
        stufe = "hoch"
    elif punkte <= 110:
        stufe = "kritisch"
    else:
        stufe = "sehr kritisch"

    return punkte, stufe


def berechne_risikostufe(
    auflagenstaerke_stufe: str,
    gueltig_bis: str | None,
    confidence: float,
    fehlende_felder: int,
) -> tuple[str, str]:
    from datetime import date

    begruendung_parts = []

    stufe_gewicht = {
        "niedrig": 0,
        "mittel": 1,
        "hoch": 2,
        "kritisch": 3,
        "sehr kritisch": 4,
    }
    risiko_punkte = stufe_gewicht.get(auflagenstaerke_stufe, 0)

    if gueltig_bis:
        try:
            ablauf = date.fromisoformat(gueltig_bis)
            heute = date.today()
            tage_verbleibend = (ablauf - heute).days
            if tage_verbleibend < 0:
                risiko_punkte += 2
                begruendung_parts.append("Genehmigung abgelaufen")
            elif tage_verbleibend <= 14:
                risiko_punkte += 1
                begruendung_parts.append(f"Läuft in {tage_verbleibend} Tagen ab")
        except ValueError:
            pass
    else:
        begruendung_parts.append("Kein Ablaufdatum")

    if confidence < 0.5:
        risiko_punkte += 1
        begruendung_parts.append(f"Niedrige KI-Konfidenz ({confidence:.0%})")

    if fehlende_felder >= 3:
        risiko_punkte += 1
        begruendung_parts.append(f"{fehlende_felder} Pflichtfelder fehlen")

    if auflagenstaerke_stufe in ("hoch", "kritisch", "sehr kritisch"):
        begruendung_parts.append(f"Auflagenstärke: {auflagenstaerke_stufe}")

    if risiko_punkte <= 0:
        risikostufe = "niedrig"
    elif risiko_punkte <= 2:
        risikostufe = "mittel"
    elif risiko_punkte <= 4:
        risikostufe = "hoch"
    else:
        risikostufe = "kritisch"

    begruendung = " | ".join(begruendung_parts) if begruendung_parts else "Keine besonderen Risiken erkannt"
    return risikostufe, begruendung


def detect_flags(auflagen: list[str]) -> dict:
    text = " ".join(auflagen).lower()
    return {
        "begleitfahrzeug_erforderlich": any(k in text for k in ["begleitfahrzeug", "vorausfahrzeug", "begleitung", "begleit"]),
        "polizei_erforderlich": any(k in text for k in ["polizei", "eskorte"]),
        "nachtfahrt_erforderlich": any(k in text for k in ["nachtfahrt", "nachts", "20:00", "21:00", "22:00", "23:00"]),
    }


def extrahiere_strassen(strecke: list[str], auflagen: list[str], startort: str | None, zielort: str | None) -> list[str]:
    combined = " ".join(strecke + auflagen + [startort or "", zielort or ""])
    pattern = r'\b(A\d{1,3}|B\d{1,3}|E\d{1,3}|L\d{1,4}|K\d{1,4})\b'
    found = re.findall(pattern, combined, re.IGNORECASE)
    return sorted(set(s.upper() for s in found))


def normalisiere_strassenkennzeichen(raw: str) -> str:
    """Normalize road identifier: 'A 57' -> 'A57', 'B 75' -> 'B75'."""
    return re.sub(r'^([AaBbEeLlKk])\s+(\d+)', lambda m: m.group(1).upper() + m.group(2), raw.strip())


def extrahiere_strassen_kategorien(
    strecke_volltext: str | None,
    strecke: list[str],
    erkannte_strassen: list[str],
) -> dict:
    """
    Derives autobahnen, bundesstrassen, kreisstrassen from available route data.
    Returns dict with keys: autobahnen, bundesstrassen, kreisstrassen.
    """
    combined = " ".join(filter(None, [strecke_volltext] + strecke + erkannte_strassen))
    pattern = r'\b([AaBbKkLlEe])\s*(\d{1,4})\b'
    matches = re.findall(pattern, combined)

    autobahnen: list[str] = []
    bundesstrassen: list[str] = []
    kreisstrassen: list[str] = []
    seen: set[str] = set()

    for prefix, number in matches:
        normalized = prefix.upper() + number
        if normalized in seen:
            continue
        seen.add(normalized)
        if prefix.upper() == "A":
            autobahnen.append(normalized)
        elif prefix.upper() == "B":
            bundesstrassen.append(normalized)
        elif prefix.upper() in ("K", "L"):
            kreisstrassen.append(normalized)

    return {
        "autobahnen": autobahnen,
        "bundesstrassen": bundesstrassen,
        "kreisstrassen": kreisstrassen,
    }
