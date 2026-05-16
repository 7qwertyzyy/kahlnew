"""
Matching-Logik: Transportanfrage → ähnliche Genehmigungen
"""
from datetime import date

MATCH_WEIGHTS = {
    "startregion": 0.15,
    "zielregion": 0.15,
    "strassen_overlap": 0.25,
    "breite_aehnlich": 0.10,
    "hoehe_aehnlich": 0.10,
    "gewicht_aehnlich": 0.10,
    "genehmigung_aktiv": 0.10,
    "genehmigungsart": 0.05,
}


def _region_match(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.0
    a, b = a.lower().strip(), b.lower().strip()
    if a == b:
        return 1.0
    # Partial: same first word (city) or contained
    a_parts = set(a.split())
    b_parts = set(b.split())
    overlap = len(a_parts & b_parts)
    if overlap > 0:
        return 0.6
    return 0.0


def _dim_score(req_val: float | None, permit_val: float | None, tight: float, loose: float) -> float:
    if req_val is None or permit_val is None:
        return 0.5
    diff = abs(req_val - permit_val)
    if diff <= tight:
        return 1.0
    if diff <= loose:
        return 0.7
    if diff <= loose * 2:
        return 0.3
    return 0.0


def _strassen_overlap(req_strassen: list[str], permit_strassen: list[str]) -> float:
    if not req_strassen or not permit_strassen:
        return 0.0
    req_set = set(s.upper() for s in req_strassen)
    permit_set = set(s.upper() for s in permit_strassen)
    if not req_set:
        return 0.0
    overlap = len(req_set & permit_set)
    return min(overlap / max(len(req_set), 1), 1.0)


def _is_active(gueltig_bis: str | None) -> float:
    if not gueltig_bis:
        return 0.5
    try:
        ablauf = date.fromisoformat(gueltig_bis)
        return 1.0 if ablauf >= date.today() else 0.3
    except ValueError:
        return 0.5


def berechne_match(request: dict, permit: dict) -> tuple[float, list[str]]:
    gruende = []
    score = 0.0

    start_s = _region_match(request.get("startort"), permit.get("startort"))
    if start_s >= 0.6:
        gruende.append(f"Gleiche Startregion ({permit.get('startort', '?')})")
    score += start_s * MATCH_WEIGHTS["startregion"]

    ziel_s = _region_match(request.get("zielort"), permit.get("zielort"))
    if ziel_s >= 0.6:
        gruende.append(f"Gleiche Zielregion ({permit.get('zielort', '?')})")
    score += ziel_s * MATCH_WEIGHTS["zielregion"]

    req_strassen = request.get("erkannte_strassen", [])
    permit_strassen = permit.get("erkannte_strassen", [])
    strassen_s = _strassen_overlap(req_strassen, permit_strassen)
    if strassen_s > 0 and permit_strassen:
        gemeinsam = set(s.upper() for s in req_strassen) & set(s.upper() for s in permit_strassen)
        if gemeinsam:
            gruende.append(f"Gemeinsame Straßen: {', '.join(sorted(gemeinsam))}")
    score += strassen_s * MATCH_WEIGHTS["strassen_overlap"]

    breite_s = _dim_score(request.get("breite_m"), permit.get("fahrzeug_breite_m"), 0.3, 0.5)
    if request.get("breite_m") and permit.get("fahrzeug_breite_m"):
        diff = abs(request["breite_m"] - permit["fahrzeug_breite_m"])
        if diff <= 0.3:
            gruende.append(f"Breite nur {diff:.2f}m Abweichung")
    score += breite_s * MATCH_WEIGHTS["breite_aehnlich"]

    hoehe_s = _dim_score(request.get("hoehe_m"), permit.get("fahrzeug_hoehe_m"), 0.3, 0.5)
    score += hoehe_s * MATCH_WEIGHTS["hoehe_aehnlich"]

    gewicht_s = _dim_score(request.get("gewicht_t"), permit.get("gesamtgewicht_t"), 5.0, 10.0)
    if request.get("gewicht_t") and permit.get("gesamtgewicht_t"):
        diff = abs(request["gewicht_t"] - permit["gesamtgewicht_t"])
        if diff <= 5:
            gruende.append(f"Gewicht nur {diff:.1f}t Abweichung")
    score += gewicht_s * MATCH_WEIGHTS["gewicht_aehnlich"]

    aktiv_s = _is_active(permit.get("gueltig_bis"))
    if aktiv_s >= 1.0:
        gruende.append(f"Genehmigung noch aktiv bis {permit.get('gueltig_bis', '?')}")
    elif aktiv_s < 0.5:
        gruende.append("Genehmigung abgelaufen (Referenzfall)")
    score += aktiv_s * MATCH_WEIGHTS["genehmigung_aktiv"]

    score += 0.5 * MATCH_WEIGHTS["genehmigungsart"]

    return round(score * 100, 1), gruende


def generiere_empfehlung(score: float, permit: dict, gruende: list[str]) -> str:
    aktiv = _is_active(permit.get("gueltig_bis")) >= 1.0
    if score >= 70 and aktiv:
        return "Sehr ähnlicher Fall — Auflagen direkt übertragbar"
    if score >= 50 and aktiv:
        return "Ähnlicher Fall — Auflagen als Orientierung nutzen"
    if score >= 30 and not aktiv:
        return "Abgelaufener Referenzfall — Auflagen als Hinweis"
    return "Entfernter Vergleichsfall"


def find_matches(request: dict, permits: list[dict], min_score: float = 30.0) -> list[dict]:
    results = []
    for permit in permits:
        score, gruende = berechne_match(request, permit)
        if score >= min_score:
            empfehlung = generiere_empfehlung(score, permit, gruende)
            results.append({
                "permit_id": permit["id"],
                "permit": permit,
                "similarity_score": score,
                "match_grund": gruende,
                "match_gruende": gruende,
                "empfehlung": empfehlung,
                "auflagen_aus_altfall": permit.get("auflagen", [])[:6],
                "risiken_aus_altfall": [permit.get("risiko_begruendung")] if permit.get("risiko_begruendung") else [],
                "begleitpflicht_in_altfall": bool(permit.get("begleitfahrzeug_erforderlich")),
                "polizei_in_altfall": bool(permit.get("polizei_erforderlich")),
                "nachtfahrt_in_altfall": bool(permit.get("nachtfahrt_erforderlich")),
                "erkannte_strassen_altfall": permit.get("erkannte_strassen", []),
            })

    results.sort(key=lambda x: (
        x["similarity_score"],
        _is_active(x["permit"].get("gueltig_bis"))
    ), reverse=True)

    return results
