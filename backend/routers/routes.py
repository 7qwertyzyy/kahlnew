"""
POST /api/routes/find-similar — Suche nach ähnlichen Genehmigungen für eine berechnete Route.
"""
import json
import re
from datetime import date
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from database.db import get_connection, row_to_dict

router = APIRouter()


class RouteMatchRequest(BaseModel):
    start_city: Optional[str] = None
    start_plz: Optional[str] = None
    destination_city: Optional[str] = None
    destination_plz: Optional[str] = None
    roads: list[str] = []
    width_m: Optional[float] = None
    height_m: Optional[float] = None
    weight_t: Optional[float] = None
    length_m: Optional[float] = None


def _normalize_road(road: str) -> str:
    return re.sub(r'^([A-Za-z])\s+(\d)', lambda m: m.group(1).upper() + m.group(2), road.strip())


def _parse_json_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(v) for v in parsed]
        except Exception:
            pass
    return []


def _is_active(gueltig_bis: str | None) -> bool:
    if not gueltig_bis:
        return False
    try:
        return date.fromisoformat(gueltig_bis) >= date.today()
    except ValueError:
        return False


def _city_matches(query: str | None, permit_city: str | None) -> bool:
    if not query or not permit_city:
        return False
    q = query.lower().strip()
    p = permit_city.lower().strip()
    return q == p or p in q or q in p


def _plz_prefix_matches(plz_a: str | None, plz_b: str | None, length: int = 2) -> bool:
    if not plz_a or not plz_b or len(plz_a) < length or len(plz_b) < length:
        return False
    return plz_a[:length] == plz_b[:length]


def _build_match_reasons(
    req: RouteMatchRequest,
    permit: dict,
    gemeinsame_strassen: set[str],
    score: float,
) -> list[str]:
    reasons = []

    if gemeinsame_strassen:
        total = len(req.roads)
        cnt = len(gemeinsame_strassen)
        sorted_roads = ", ".join(sorted(gemeinsame_strassen))
        reasons.append(f"{cnt} von {total} Straßen stimmen überein ({sorted_roads})")

    if _city_matches(req.start_city, permit.get("startort")):
        reasons.append(f"Gleicher Startort {permit.get('startort', '')}")
    elif _plz_prefix_matches(req.start_plz, permit.get("start_plz")):
        reasons.append("Ähnliche Startregion (PLZ-Bereich)")

    if _city_matches(req.destination_city, permit.get("zielort")):
        reasons.append(f"Gleicher Zielort {permit.get('zielort', '')}")
    elif _plz_prefix_matches(req.destination_plz, permit.get("ziel_plz")):
        reasons.append("Ähnliche Zielregion (PLZ-Bereich)")

    if req.width_m and permit.get("fahrzeug_breite_m"):
        diff = abs(req.width_m - permit["fahrzeug_breite_m"])
        if diff <= 0.5:
            reasons.append(f"Fahrzeugbreite nur {diff:.2f} m Abweichung")

    if req.weight_t and permit.get("gesamtgewicht_t"):
        diff = abs(req.weight_t - permit["gesamtgewicht_t"])
        if diff <= 30:
            reasons.append(f"Gesamtgewicht nur {diff:.0f} t Abweichung")

    if req.height_m and permit.get("fahrzeug_hoehe_m"):
        diff = abs(req.height_m - permit["fahrzeug_hoehe_m"])
        if diff <= 0.5:
            reasons.append(f"Fahrzeughöhe nur {diff:.2f} m Abweichung")

    if _is_active(permit.get("gueltig_bis")):
        reasons.append(f"Genehmigung aktiv bis {permit.get('gueltig_bis', '')}")

    return reasons


def _berechne_score(req: RouteMatchRequest, permit: dict) -> tuple[float, set[str]]:
    score = 0.0
    req_roads_normalized = {_normalize_road(r) for r in req.roads}

    # 1. Straßenüberschneidung (max 35 Punkte)
    permit_roads = set()
    for field in ("autobahnen", "bundesstrassen", "erkannte_strassen"):
        for road in _parse_json_list(permit.get(field)):
            permit_roads.add(_normalize_road(road))

    gemeinsame = req_roads_normalized & permit_roads
    if req_roads_normalized:
        overlap_ratio = len(gemeinsame) / len(req_roads_normalized)
        score += overlap_ratio * 35

    # 2. Start/Ziel ähnlich (max 25 Punkte)
    if _city_matches(req.start_city, permit.get("startort")):
        score += 15
    elif _plz_prefix_matches(req.start_plz, permit.get("start_plz")):
        score += 8

    if _city_matches(req.destination_city, permit.get("zielort")):
        score += 10
    elif _plz_prefix_matches(req.destination_plz, permit.get("ziel_plz")):
        score += 5

    # 3. Fahrzeugmaße ähnlich (max 25 Punkte)
    if req.width_m and permit.get("fahrzeug_breite_m"):
        diff = abs(req.width_m - permit["fahrzeug_breite_m"])
        if diff <= 0.1:
            score += 10
        elif diff <= 0.3:
            score += 7
        elif diff <= 0.5:
            score += 4

    if req.weight_t and permit.get("gesamtgewicht_t"):
        diff = abs(req.weight_t - permit["gesamtgewicht_t"])
        if diff <= 5:
            score += 10
        elif diff <= 15:
            score += 6
        elif diff <= 30:
            score += 3

    if req.height_m and permit.get("fahrzeug_hoehe_m"):
        diff = abs(req.height_m - permit["fahrzeug_hoehe_m"])
        if diff <= 0.2:
            score += 5
        elif diff <= 0.5:
            score += 3

    # 4. Genehmigung aktiv (max 15 Punkte)
    if _is_active(permit.get("gueltig_bis")):
        score += 15
    else:
        score += 3  # abgelaufen trotzdem als Referenz relevant

    return score, gemeinsame


def _build_route_summary(permit: dict) -> str:
    start = permit.get("startort") or "?"
    ziel = permit.get("zielort") or "?"
    autobahnen = _parse_json_list(permit.get("autobahnen"))
    if autobahnen:
        via = ", ".join(autobahnen[:5])
        return f"{start} → {ziel} via {via}"
    return f"{start} → {ziel}"


def _key_conditions(permit: dict) -> list[str]:
    conditions = []
    if permit.get("nachtfahrt_erforderlich"):
        conditions.append("Nachtfahrt erforderlich")
    if permit.get("begleitfahrzeug_erforderlich"):
        conditions.append("Begleitfahrzeug erforderlich")
    if permit.get("polizei_erforderlich"):
        conditions.append("Polizeieskorte erforderlich")
    auflagen = _parse_json_list(permit.get("auflagen"))
    for a in auflagen[:3]:
        text = str(a).strip()
        if text and text not in conditions:
            conditions.append(text[:120])
    return conditions[:5]


@router.post("/find-similar")
def find_similar_routes(request: RouteMatchRequest) -> dict:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM permits").fetchall()

    permits = [row_to_dict(r) for r in rows]
    results = []

    for permit in permits:
        score, gemeinsame = _berechne_score(request, permit)
        if score < 25:
            continue

        reasons = _build_match_reasons(request, permit, gemeinsame, score)
        aktiv = _is_active(permit.get("gueltig_bis"))

        results.append({
            "permit_id": permit["id"],
            "permit_number": permit.get("genehmigungsnummer") or f"#{permit['id']}",
            "similarity_score": round(score),
            "status": "aktiv" if aktiv else "abgelaufen",
            "valid_until": permit.get("gueltig_bis"),
            "start_city": permit.get("startort"),
            "destination_city": permit.get("zielort"),
            "route_summary": _build_route_summary(permit),
            "width_m": permit.get("fahrzeug_breite_m"),
            "height_m": permit.get("fahrzeug_hoehe_m"),
            "weight_t": permit.get("gesamtgewicht_t"),
            "length_m": permit.get("fahrzeug_laenge_m"),
            "match_reasons": reasons,
            "key_conditions": _key_conditions(permit),
            "roads_sequence": _parse_json_list(permit.get("autobahnen")) or _parse_json_list(permit.get("erkannte_strassen")),
            "auflagenstaerke_stufe": permit.get("auflagenstaerke_stufe"),
            "risikostufe": permit.get("risikostufe"),
        })

    results.sort(key=lambda x: x["similarity_score"], reverse=True)
    return {"matches": results[:10]}
