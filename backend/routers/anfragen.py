import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from database.db import get_connection, row_to_dict, serialize_list
from models.anfrage import AnfrageStatusUpdate, AnfragenStats, TransportAnfrage, TransportAnfrageUpdate
from models.permit import Permit
from services.anfrage_extractor import extract_anfrage_data
from services.briefing_generator import generate_briefing
from services.matcher import find_matches
from services.pdf_extractor import extract_text
from services.reply_generator import generate_customer_reply

router = APIRouter()

DEFAULT_UPLOAD_DIR = (
    Path("/tmp/uploads/anfragen")
    if os.getenv("VERCEL")
    else Path(__file__).parent.parent / "data" / "uploads" / "anfragen"
)
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR") or DEFAULT_UPLOAD_DIR)
LIST_FIELDS = ["besonderheiten", "fehlende_infos", "empfohlene_naechste_schritte"]
JSON_FIELDS = ["kalkulations_briefing"]


@router.get("/stats", response_model=AnfragenStats)
def stats():
    week_start = date.today().isoformat()
    week_end = (date.today() + timedelta(days=7)).isoformat()
    with get_connection() as conn:
        return AnfragenStats(
            total=conn.execute("SELECT COUNT(*) FROM transport_requests").fetchone()[0],
            neu=conn.execute("SELECT COUNT(*) FROM transport_requests WHERE status = 'neu'").fetchone()[0],
            in_bearbeitung=conn.execute("SELECT COUNT(*) FROM transport_requests WHERE status = 'in_bearbeitung'").fetchone()[0],
            dringend=conn.execute("SELECT COUNT(*) FROM transport_requests WHERE prioritaet = 'dringend'").fetchone()[0],
            diese_woche=conn.execute(
                "SELECT COUNT(*) FROM transport_requests WHERE wunschdatum BETWEEN ? AND ?",
                [week_start, week_end],
            ).fetchone()[0],
        )


@router.post("", response_model=TransportAnfrage)
async def create_anfrage(request: Request):
    content_type = request.headers.get("content-type", "")
    data: dict = {}
    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        eingabe_typ = form.get("eingabe_typ")
        if not file:
            raise HTTPException(status_code=422, detail="Datei fehlt")
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        target = UPLOAD_DIR / f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{file.filename}"
        target.write_bytes(await file.read())
        data["eingabe_typ"] = eingabe_typ or "pdf"
        data["eingabe_datei_pfad"] = str(target)
        data["eingabe_rohtext"] = extract_text(str(target)) if target.suffix.lower() == ".pdf" else target.read_text(encoding="utf-8", errors="ignore")
    else:
        data = await request.json()

    if not data:
        raise HTTPException(status_code=422, detail="Anfrage-Daten fehlen")

    data.setdefault("eingabe_typ", "freitext")
    data.setdefault("eingabe_rohtext", data.get("anfrage_text"))

    request_id = _insert_anfrage(data)
    _run_pipeline(request_id, do_extract=data.get("eingabe_typ") != "formular")
    return _get_anfrage_or_404(request_id)


@router.get("", response_model=list[TransportAnfrage])
def list_anfragen(
    status: Optional[str] = None,
    prioritaet: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    query = "SELECT * FROM transport_requests WHERE 1=1"
    params: list = []
    if status:
        query += " AND status = ?"
        params.append(status)
    if prioritaet:
        query += " AND prioritaet = ?"
        params.append(prioritaet)
    if q:
        query += " AND (kunde LIKE ? OR startort LIKE ? OR zielort LIKE ? OR transportgut LIKE ? OR eingabe_rohtext LIKE ?)"
        params.extend([f"%{q}%"] * 5)
    query += " ORDER BY erstellt_am DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_build_anfrage(row) for row in rows]


@router.get("/{request_id}", response_model=TransportAnfrage)
def get_anfrage(request_id: int):
    return _get_anfrage_or_404(request_id)


@router.put("/{request_id}", response_model=TransportAnfrage)
def update_anfrage(request_id: int, data: TransportAnfrageUpdate):
    _ensure_exists(request_id)
    row = _prepare_db_row(data.model_dump(exclude_none=False))
    row.pop("id", None)
    row["aktualisiert_am"] = datetime.now().isoformat()
    set_clause = ", ".join(f"{key} = ?" for key in row.keys())
    with get_connection() as conn:
        conn.execute(f"UPDATE transport_requests SET {set_clause} WHERE id = ?", list(row.values()) + [request_id])
        conn.commit()
    return _get_anfrage_or_404(request_id)


@router.patch("/{request_id}/status", response_model=TransportAnfrage)
def update_status(request_id: int, data: AnfrageStatusUpdate):
    allowed = {"neu", "in_bearbeitung", "angebot_erstellt", "abgeschlossen", "storniert"}
    if data.status not in allowed:
        raise HTTPException(status_code=422, detail=f"Status muss einer von {sorted(allowed)} sein")
    _ensure_exists(request_id)
    with get_connection() as conn:
        conn.execute(
            "UPDATE transport_requests SET status = ?, aktualisiert_am = ? WHERE id = ?",
            [data.status, datetime.now().isoformat(), request_id],
        )
        conn.commit()
    return _get_anfrage_or_404(request_id)


@router.delete("/{request_id}")
def delete_anfrage(request_id: int):
    _ensure_exists(request_id)
    with get_connection() as conn:
        conn.execute("DELETE FROM anfrage_matches WHERE transport_request_id = ?", [request_id])
        conn.execute("DELETE FROM transport_requests WHERE id = ?", [request_id])
        conn.commit()
    return {"deleted": request_id}


@router.post("/{request_id}/extract", response_model=TransportAnfrage)
def extract_again(request_id: int):
    _ensure_exists(request_id)
    _run_extract(request_id)
    return _get_anfrage_or_404(request_id)


@router.post("/{request_id}/match", response_model=TransportAnfrage)
def match_again(request_id: int):
    _ensure_exists(request_id)
    _run_match(request_id)
    return _get_anfrage_or_404(request_id)


@router.post("/{request_id}/briefing", response_model=TransportAnfrage)
def briefing_again(request_id: int):
    _ensure_exists(request_id)
    _run_briefing(request_id)
    return _get_anfrage_or_404(request_id)


@router.post("/{request_id}/reply")
def reply_again(request_id: int):
    anfrage = _get_anfrage_or_404(request_id).model_dump()
    reply = generate_customer_reply(anfrage)
    with get_connection() as conn:
        conn.execute(
            "UPDATE transport_requests SET kundenantwort_entwurf = ?, aktualisiert_am = ? WHERE id = ?",
            [reply, datetime.now().isoformat(), request_id],
        )
        conn.commit()
    return {"kundenantwort_entwurf": reply}


def _insert_anfrage(data: dict) -> int:
    row = _prepare_db_row(data)
    row["aktualisiert_am"] = datetime.now().isoformat()
    keys = list(row.keys())
    with get_connection() as conn:
        cur = conn.execute(
            f"INSERT INTO transport_requests ({', '.join(keys)}) VALUES ({', '.join(['?'] * len(keys))})",
            [row[key] for key in keys],
        )
        conn.commit()
        return cur.lastrowid


def _run_pipeline(request_id: int, do_extract: bool):
    if do_extract:
        _run_extract(request_id)
    else:
        _apply_form_analysis(request_id)
    _run_match(request_id)
    _run_briefing(request_id)
    reply_again(request_id)


def _run_extract(request_id: int):
    anfrage = _get_anfrage_or_404(request_id).model_dump()
    text = anfrage.get("eingabe_rohtext") or anfrage.get("anfrage_text") or ""
    extracted = extract_anfrage_data(text)
    row = _prepare_db_row(extracted)
    row["ki_einschaetzung"] = _first_assessment({**anfrage, **extracted})
    row["aktualisiert_am"] = datetime.now().isoformat()
    set_clause = ", ".join(f"{key} = ?" for key in row.keys())
    with get_connection() as conn:
        conn.execute(f"UPDATE transport_requests SET {set_clause} WHERE id = ?", list(row.values()) + [request_id])
        conn.commit()


def _apply_form_analysis(request_id: int):
    anfrage = _get_anfrage_or_404(request_id).model_dump()
    merged = _complete_analysis(anfrage)
    row = _prepare_db_row({
        "fehlende_infos": merged.get("fehlende_infos", []),
        "schwertransport_relevant": merged.get("schwertransport_relevant"),
        "geschaetzte_komplexitaet": merged.get("geschaetzte_komplexitaet"),
        "ki_einschaetzung": _first_assessment(merged),
    })
    row["aktualisiert_am"] = datetime.now().isoformat()
    set_clause = ", ".join(f"{key} = ?" for key in row.keys())
    with get_connection() as conn:
        conn.execute(f"UPDATE transport_requests SET {set_clause} WHERE id = ?", list(row.values()) + [request_id])
        conn.commit()


def _run_match(request_id: int):
    anfrage = _get_anfrage_or_404(request_id).model_dump()
    request = {**anfrage, "erkannte_strassen": []}
    with get_connection() as conn:
        permits = [row_to_dict(r) for r in conn.execute("SELECT * FROM permits").fetchall()]
        results = find_matches(request, permits)[:10]
        conn.execute("DELETE FROM anfrage_matches WHERE transport_request_id = ?", [request_id])
        for result in results:
            permit = result["permit"]
            conn.execute(
                """INSERT INTO anfrage_matches
                (transport_request_id, permit_id, similarity_score, match_gruende, permit_status, empfehlung)
                VALUES (?, ?, ?, ?, ?, ?)""",
                [
                    request_id,
                    result["permit_id"],
                    result["similarity_score"],
                    serialize_list(result.get("match_gruende") or result.get("match_grund") or []),
                    permit.get("status"),
                    result.get("empfehlung"),
                ],
            )
        conn.commit()


def _run_briefing(request_id: int):
    anfrage = _get_anfrage_or_404(request_id).model_dump()
    matches = anfrage.get("matches", [])
    briefing = generate_briefing(anfrage, matches)
    risiko = briefing.get("risiko_zusammenfassung")
    auflagen = _summarize_auflagen(matches)
    row = {
        "kalkulations_briefing": json.dumps(briefing, ensure_ascii=False),
        "risiko_zusammenfassung": risiko,
        "auflagen_zusammenfassung": auflagen,
        "empfohlene_naechste_schritte": serialize_list(briefing.get("empfohlene_naechste_schritte", [])),
        "aktualisiert_am": datetime.now().isoformat(),
    }
    with get_connection() as conn:
        conn.execute(
            f"UPDATE transport_requests SET {', '.join(f'{k} = ?' for k in row)} WHERE id = ?",
            list(row.values()) + [request_id],
        )
        conn.commit()


def _get_anfrage_or_404(request_id: int) -> TransportAnfrage:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM transport_requests WHERE id = ?", [request_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Anfrage nicht gefunden")
    return _build_anfrage(row)


def _ensure_exists(request_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM transport_requests WHERE id = ?", [request_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Anfrage nicht gefunden")


def _build_anfrage(row) -> TransportAnfrage:
    data = dict(row)
    for field in LIST_FIELDS:
        data[field] = _json_list(data.get(field))
    for field in JSON_FIELDS:
        data[field] = _json_obj(data.get(field))
    data["schwertransport_relevant"] = None if data.get("schwertransport_relevant") is None else bool(data["schwertransport_relevant"])
    data["matches"] = _load_matches(data["id"])
    data["match_count"] = len(data["matches"])
    return TransportAnfrage(**data)


def _load_matches(request_id: int) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT p.*,
                      am.id AS match_id,
                      am.permit_id AS match_permit_id,
                      am.similarity_score AS match_similarity_score,
                      am.match_gruende AS match_gruende_json,
                      am.empfehlung AS match_empfehlung
               FROM anfrage_matches am
               JOIN permits p ON p.id = am.permit_id
               WHERE am.transport_request_id = ?
               ORDER BY am.similarity_score DESC""",
            [request_id],
        ).fetchall()
    matches = []
    for row in rows:
        permit = row_to_dict(row)
        matches.append({
            "id": row["match_id"],
            "permit_id": row["match_permit_id"],
            "permit": Permit(**permit).model_dump(),
            "similarity_score": row["match_similarity_score"] or 0,
            "match_gruende": _json_list(row["match_gruende_json"]),
            "empfehlung": row["match_empfehlung"],
            "auflagen_aus_altfall": permit.get("auflagen", [])[:6],
            "risiken_aus_altfall": [permit.get("risiko_begruendung")] if permit.get("risiko_begruendung") else [],
            "begleitpflicht_in_altfall": bool(permit.get("begleitfahrzeug_erforderlich")),
            "polizei_in_altfall": bool(permit.get("polizei_erforderlich")),
            "nachtfahrt_in_altfall": bool(permit.get("nachtfahrt_erforderlich")),
            "erkannte_strassen_altfall": permit.get("erkannte_strassen", []),
        })
    return matches


def _prepare_db_row(data: dict) -> dict:
    allowed = {
        "eingabe_typ", "eingabe_rohtext", "eingabe_datei_pfad", "kunde", "ansprechpartner", "email", "telefon",
        "startort", "start_adresse", "zielort", "ziel_adresse", "transportgut", "laenge_m", "breite_m",
        "hoehe_m", "gewicht_t", "achslast_t", "fahrzeugtyp", "anzahl_fahrten", "wunschdatum", "frist_angebot",
        "besonderheiten", "fehlende_infos", "schwertransport_relevant", "geschaetzte_komplexitaet",
        "ki_einschaetzung", "kalkulations_briefing", "risiko_zusammenfassung", "auflagen_zusammenfassung",
        "empfohlene_naechste_schritte", "kundenantwort_entwurf", "status", "zugewiesen_an", "prioritaet",
        "interne_notizen", "anfrage_text", "aktualisiert_am",
    }
    row = {k: v for k, v in data.items() if k in allowed}
    for field in LIST_FIELDS:
        if field in row:
            row[field] = serialize_list(row[field])
    if isinstance(row.get("kalkulations_briefing"), dict):
        row["kalkulations_briefing"] = json.dumps(row["kalkulations_briefing"], ensure_ascii=False)
    if "schwertransport_relevant" in row and row["schwertransport_relevant"] is not None:
        row["schwertransport_relevant"] = 1 if row["schwertransport_relevant"] else 0
    return row


def _json_list(value) -> list:
    if not value:
        return []
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        return [value]


def _json_obj(value):
    if not value:
        return None
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except Exception:
        return None


def _first_assessment(anfrage: dict) -> str:
    relevance = "genehmigungsrelevant" if anfrage.get("schwertransport_relevant") else "noch zu pruefen"
    return f"Erste KI-Einschaetzung: {relevance}, Komplexitaet {anfrage.get('geschaetzte_komplexitaet') or 'unklar'}."


def _complete_analysis(anfrage: dict) -> dict:
    data = dict(anfrage)
    missing = []
    if data.get("startort") and not data.get("start_adresse"):
        missing.append("Exakte Ladeadresse")
    if data.get("zielort") and not data.get("ziel_adresse"):
        missing.append("Exakte Entladeadresse")
    if data.get("achslast_t") is None:
        missing.append("Achslasten")
    if any(data.get(k) is None for k in ["laenge_m", "breite_m", "hoehe_m", "gewicht_t"]):
        missing.append("Technische Zeichnung oder Ladungsdatenblatt")
    if not data.get("wunschdatum"):
        missing.append("Gewuenschter genauer Transporttermin")
    if not data.get("fahrzeugtyp"):
        missing.append("Fahrzeugtyp oder -anforderung")
    if not data.get("anzahl_fahrten"):
        missing.append("Anzahl Fahrten")
    if not data.get("email") and not data.get("telefon"):
        missing.append("Kontaktdaten")
    if not data.get("transportgut"):
        missing.append("Ladungsbeschreibung / Transportgut")
    data["fehlende_infos"] = missing
    dims = [data.get("breite_m"), data.get("hoehe_m"), data.get("gewicht_t"), data.get("laenge_m")]
    if all(value is not None for value in dims):
        data["schwertransport_relevant"] = data["breite_m"] > 2.55 or data["hoehe_m"] > 4.0 or data["gewicht_t"] > 40 or data["laenge_m"] > 16.5
    if not data.get("geschaetzte_komplexitaet"):
        if (data.get("breite_m") or 0) >= 4.0 or (data.get("gewicht_t") or 0) >= 80:
            data["geschaetzte_komplexitaet"] = "sehr_komplex"
        elif (data.get("breite_m") or 0) >= 3.2 or (data.get("gewicht_t") or 0) >= 60:
            data["geschaetzte_komplexitaet"] = "komplex"
        elif data.get("schwertransport_relevant"):
            data["geschaetzte_komplexitaet"] = "mittel"
        else:
            data["geschaetzte_komplexitaet"] = "einfach"
    return data


def _summarize_auflagen(matches: list[dict]) -> str:
    parts = []
    if any(m.get("begleitpflicht_in_altfall") for m in matches):
        parts.append("Begleitfahrzeug in Altfaellen erkannt")
    if any(m.get("polizei_in_altfall") for m in matches):
        parts.append("Polizeibeteiligung in Altfaellen erkannt")
    if any(m.get("nachtfahrt_in_altfall") for m in matches):
        parts.append("Nachtfahrtpflicht in Altfaellen erkannt")
    return "; ".join(parts)
