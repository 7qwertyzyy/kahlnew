import json
import math
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from database.db import get_connection, row_to_dict, serialize_list, LIST_FIELDS
from models.permit import Permit, PermitUpdate, PermitStatusUpdate, PaginatedPermits, DashboardStats

router = APIRouter()


def _build_permit_row(data: dict) -> dict:
    row = dict(data)
    for f in LIST_FIELDS:
        if f in row:
            row[f] = serialize_list(row[f])
    for bf in ["begleitfahrzeug_erforderlich", "polizei_erforderlich", "nachtfahrt_erforderlich"]:
        if bf in row:
            row[bf] = 1 if row[bf] else 0
    row["aktualisiert_am"] = datetime.now().isoformat()
    return row


@router.get("", response_model=PaginatedPermits)
def list_permits(
    q: Optional[str] = None,
    status: Optional[str] = None,
    valid_from: Optional[str] = None,
    valid_to: Optional[str] = None,
    expiring_days: Optional[int] = None,
    min_width: Optional[float] = None,
    max_width: Optional[float] = None,
    min_height: Optional[float] = None,
    min_weight: Optional[float] = None,
    max_weight: Optional[float] = None,
    start_city: Optional[str] = None,
    destination_city: Optional[str] = None,
    road: Optional[str] = None,
    escort_required: Optional[bool] = None,
    police_required: Optional[bool] = None,
    risk_level: Optional[str] = None,
    sort: str = "erstellt_am",
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=25, ge=1, le=100),
):
    query = "SELECT * FROM permits WHERE 1=1"
    params: list = []

    if q:
        pattern = f"%{q}%"
        query += """ AND (
            genehmigungsnummer LIKE ? OR antragsnummer LIKE ? OR kunde LIKE ?
            OR startort LIKE ? OR zielort LIKE ? OR strecke LIKE ?
            OR erkannte_strassen LIKE ? OR dateiname LIKE ?
        )"""
        params.extend([pattern] * 8)

    if status:
        query += " AND status = ?"
        params.append(status)

    if valid_from:
        query += " AND gueltig_bis >= ?"
        params.append(valid_from)

    if valid_to:
        query += " AND gueltig_von <= ?"
        params.append(valid_to)

    if expiring_days is not None:
        today = date.today().isoformat()
        future = date.fromordinal(date.today().toordinal() + expiring_days).isoformat()
        query += " AND gueltig_bis BETWEEN ? AND ?"
        params.extend([today, future])

    if min_width is not None:
        query += " AND fahrzeug_breite_m >= ?"
        params.append(min_width)

    if max_width is not None:
        query += " AND fahrzeug_breite_m <= ?"
        params.append(max_width)

    if min_height is not None:
        query += " AND fahrzeug_hoehe_m >= ?"
        params.append(min_height)

    if min_weight is not None:
        query += " AND gesamtgewicht_t >= ?"
        params.append(min_weight)

    if max_weight is not None:
        query += " AND gesamtgewicht_t <= ?"
        params.append(max_weight)

    if start_city:
        query += " AND startort LIKE ?"
        params.append(f"%{start_city}%")

    if destination_city:
        query += " AND zielort LIKE ?"
        params.append(f"%{destination_city}%")

    if road:
        query += " AND erkannte_strassen LIKE ?"
        params.append(f"%{road}%")

    if escort_required is not None:
        query += " AND begleitfahrzeug_erforderlich = ?"
        params.append(1 if escort_required else 0)

    if police_required is not None:
        query += " AND polizei_erforderlich = ?"
        params.append(1 if police_required else 0)

    if risk_level:
        query += " AND risikostufe = ?"
        params.append(risk_level)

    allowed_sorts = {"erstellt_am", "aktualisiert_am", "gueltig_bis", "risikostufe", "confidence"}
    sort_col = sort if sort in allowed_sorts else "erstellt_am"
    query += f" ORDER BY {sort_col} DESC"

    with get_connection() as conn:
        total = conn.execute(
            query.replace("SELECT *", "SELECT COUNT(*)"), params
        ).fetchone()[0]

        offset = (page - 1) * limit
        rows = conn.execute(query + f" LIMIT {limit} OFFSET {offset}", params).fetchall()

    items = [Permit(**row_to_dict(r)) for r in rows]
    return PaginatedPermits(
        items=items,
        total=total,
        page=page,
        limit=limit,
        pages=math.ceil(total / limit) if total else 1,
    )


@router.get("/expiring", response_model=list[Permit])
def expiring_permits(days: int = 30):
    today = date.today().isoformat()
    future = date.fromordinal(date.today().toordinal() + days).isoformat()
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM permits WHERE gueltig_bis BETWEEN ? AND ? ORDER BY gueltig_bis ASC",
            [today, future],
        ).fetchall()
    return [Permit(**row_to_dict(r)) for r in rows]


@router.get("/stats", response_model=DashboardStats)
def stats():
    today = date.today().isoformat()
    future_30 = date.fromordinal(date.today().toordinal() + 30).isoformat()
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) FROM permits").fetchone()[0]
        active = conn.execute(
            "SELECT COUNT(*) FROM permits WHERE gueltig_bis >= ? AND status = 'verified'",
            [today]
        ).fetchone()[0]
        expiring = conn.execute(
            "SELECT COUNT(*) FROM permits WHERE gueltig_bis BETWEEN ? AND ?",
            [today, future_30]
        ).fetchone()[0]
        needs_review = conn.execute(
            "SELECT COUNT(*) FROM permits WHERE status = 'needs_review'"
        ).fetchone()[0]
        expired = conn.execute(
            "SELECT COUNT(*) FROM permits WHERE gueltig_bis < ?", [today]
        ).fetchone()[0]
        critical = conn.execute(
            "SELECT COUNT(*) FROM permits WHERE risikostufe = 'kritisch'"
        ).fetchone()[0]

    return DashboardStats(
        total_permits=total,
        active_permits=active,
        expiring_soon=expiring,
        needs_review=needs_review,
        expired=expired,
        critical_risk=critical,
    )


@router.get("/{permit_id}", response_model=Permit)
def get_permit(permit_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM permits WHERE id = ?", [permit_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Genehmigung nicht gefunden")
    return Permit(**row_to_dict(row))


@router.put("/{permit_id}", response_model=Permit)
def update_permit(permit_id: int, data: PermitUpdate):
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM permits WHERE id = ?", [permit_id]).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Genehmigung nicht gefunden")

        row = _build_permit_row(data.model_dump(exclude_none=False))
        row.pop("id", None)
        row.pop("erstellt_am", None)

        set_clause = ", ".join(f"{k} = ?" for k in row.keys())
        conn.execute(
            f"UPDATE permits SET {set_clause} WHERE id = ?",
            list(row.values()) + [permit_id],
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM permits WHERE id = ?", [permit_id]).fetchone()
    return Permit(**row_to_dict(updated))


@router.patch("/{permit_id}/status", response_model=Permit)
def update_status(permit_id: int, data: PermitStatusUpdate):
    allowed = {"needs_review", "verified", "error"}
    if data.status not in allowed:
        raise HTTPException(status_code=422, detail=f"Status muss einer von {allowed} sein")

    with get_connection() as conn:
        existing = conn.execute("SELECT id FROM permits WHERE id = ?", [permit_id]).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Genehmigung nicht gefunden")

        now = datetime.now().isoformat()
        if data.status == "verified":
            conn.execute(
                "UPDATE permits SET status = ?, geprueft_von = ?, geprueft_am = ?, aktualisiert_am = ? WHERE id = ?",
                [data.status, data.geprueft_von or "System", now, now, permit_id],
            )
        else:
            conn.execute(
                "UPDATE permits SET status = ?, aktualisiert_am = ? WHERE id = ?",
                [data.status, now, permit_id],
            )
        conn.commit()
        row = conn.execute("SELECT * FROM permits WHERE id = ?", [permit_id]).fetchone()
    return Permit(**row_to_dict(row))


@router.delete("/{permit_id}")
def delete_permit(permit_id: int):
    with get_connection() as conn:
        existing = conn.execute("SELECT id FROM permits WHERE id = ?", [permit_id]).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Genehmigung nicht gefunden")
        conn.execute("DELETE FROM permits WHERE id = ?", [permit_id])
        conn.commit()
    return {"deleted": permit_id}


@router.get("/{permit_id}/document")
def download_document(permit_id: int):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT original_datei_pfad, dateiname FROM permits WHERE id = ?", [permit_id]
        ).fetchone()
    if not row or not row["original_datei_pfad"]:
        raise HTTPException(status_code=404, detail="Originaldatei nicht verfügbar")
    from pathlib import Path
    path = Path(row["original_datei_pfad"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Datei nicht auf dem Server gefunden")
    return FileResponse(str(path), filename=row["dateiname"] or path.name)
