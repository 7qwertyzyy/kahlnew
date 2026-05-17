import shutil
import traceback
import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from database.db import get_connection, serialize_list, LIST_FIELDS, row_to_dict
from models.permit import Permit
from services.ai_extractor import extract_permit_data, get_model_name
from services.pdf_extractor import extract_text
from services.risk_calculator import (
    berechne_auflagenstaerke,
    berechne_risikostufe,
    detect_flags,
    extrahiere_strassen,
    extrahiere_strassen_kategorien,
)

DEFAULT_UPLOAD_DIR = (
    Path("/tmp/uploads")
    if os.getenv("VERCEL")
    else Path(__file__).parent.parent / "data" / "uploads"
)
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR") or DEFAULT_UPLOAD_DIR)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter()


def _get_db_columns() -> set[str]:
    """Gibt die tatsächlichen Spaltennamen der permits-Tabelle zurück."""
    with get_connection() as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(permits)")}


def _enrich_and_save(data: dict, file_path: Path, dateityp: str, dokument_volltext: str | None = None) -> Permit:
    # Flags aus Auflagen ableiten (falls KI sie nicht gesetzt hat)
    flags = detect_flags(data.get("auflagen", []))
    for k, v in flags.items():
        if not data.get(k):
            data[k] = v

    # Volltext des Dokuments speichern
    if dokument_volltext:
        data["dokument_volltext"] = dokument_volltext

    # Straßenkennzeichen aus Streckentext extrahieren
    erkannte = extrahiere_strassen(
        data.get("strecke", []),
        data.get("auflagen", []),
        data.get("startort"),
        data.get("zielort"),
    )
    if not data.get("erkannte_strassen"):
        data["erkannte_strassen"] = erkannte

    # Straßen nach Kategorie aufteilen (Autobahnen, Bundesstraßen, Kreisstraßen)
    kategorien = extrahiere_strassen_kategorien(
        data.get("strecke_volltext"),
        data.get("strecke", []),
        data.get("erkannte_strassen", []),
    )
    if not data.get("autobahnen"):
        data["autobahnen"] = kategorien["autobahnen"]
    if not data.get("bundesstrassen"):
        data["bundesstrassen"] = kategorien["bundesstrassen"]
    if not data.get("kreisstrassen"):
        data["kreisstrassen"] = kategorien["kreisstrassen"]

    # Auflagenstärke berechnen
    punkte, stufe = berechne_auflagenstaerke(
        data.get("auflagen", []),
        data.get("begleitfahrzeug_erforderlich", False),
        data.get("polizei_erforderlich", False),
        data.get("nachtfahrt_erforderlich", False),
    )
    data["auflagenstaerke"] = punkte
    data["auflagenstaerke_stufe"] = stufe

    # Risikostufe berechnen
    fehlende = sum(
        1 for f in ["startort", "zielort", "gueltig_bis", "fahrzeug_breite_m", "gesamtgewicht_t"]
        if not data.get(f)
    )
    risikostufe, begruendung = berechne_risikostufe(
        stufe, data.get("gueltig_bis"), data.get("confidence", 0.0), fehlende
    )
    data["risikostufe"] = risikostufe
    data["risiko_begruendung"] = begruendung
    data["dateityp"] = dateityp
    data["original_datei_pfad"] = str(file_path)
    data["extraktions_modell"] = get_model_name()

    now = datetime.now().isoformat()
    data["erstellt_am"] = now
    data["aktualisiert_am"] = now
    data.pop("id", None)

    # Nur Spalten einfügen, die wirklich in der DB existieren
    db_cols = _get_db_columns()
    db_cols.discard("id")

    row = {}
    for k, v in data.items():
        if k not in db_cols:
            continue
        if k in LIST_FIELDS:
            row[k] = serialize_list(v)
        elif k in ("begleitfahrzeug_erforderlich", "polizei_erforderlich", "nachtfahrt_erforderlich"):
            row[k] = 1 if v else 0
        else:
            row[k] = v

    # Fehlende Pflichtspalten mit Defaults auffüllen
    defaults = {
        "kennzeichen": "[]", "strecke": "[]", "erkannte_strassen": "[]",
        "auflagen": "[]", "behoerden": "[]", "besonderheiten": "[]",
        "confidence": 0.0, "status": "needs_review",
        "auflagenstaerke": 0, "auflagenstaerke_stufe": "niedrig",
        "risikostufe": "niedrig",
        "begleitfahrzeug_erforderlich": 0,
        "polizei_erforderlich": 0,
        "nachtfahrt_erforderlich": 0,
        "erstellt_am": now, "aktualisiert_am": now,
    }
    for col, default in defaults.items():
        if col in db_cols and col not in row:
            row[col] = default

    columns = ", ".join(row.keys())
    placeholders = ", ".join("?" * len(row))

    with get_connection() as conn:
        cursor = conn.execute(
            f"INSERT INTO permits ({columns}) VALUES ({placeholders})",
            list(row.values()),
        )
        new_id = cursor.lastrowid
        conn.commit()

    with get_connection() as conn:
        saved = conn.execute("SELECT * FROM permits WHERE id = ?", [new_id]).fetchone()

    if saved is None:
        raise RuntimeError(f"Eintrag {new_id} nach INSERT nicht gefunden")

    return Permit(**row_to_dict(saved))


@router.post("/pdf", response_model=Permit)
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="Nur PDF-Dateien erlaubt")

    save_path = UPLOAD_DIR / file.filename
    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # PDF-Text extrahieren
    text = extract_text(str(save_path))
    if text.startswith("[ERROR]"):
        raise HTTPException(
            status_code=422,
            detail=f"PDF-Textextraktion fehlgeschlagen: {text}. "
                   "Stelle sicher dass PyMuPDF installiert ist (pip install PyMuPDF).",
        )

    # KI-Extraktion (Fehler werden intern abgefangen und als status=error gespeichert)
    data = extract_permit_data(text, file.filename)

    try:
        return _enrich_and_save(data, save_path, "pdf", dokument_volltext=text)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Datenbankfehler beim Speichern: {e}",
        )


@router.post("/batch", response_model=list[Permit])
async def upload_batch(files: list[UploadFile] = File(...)):
    results = []
    for file in files:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            continue

        save_path = UPLOAD_DIR / file.filename
        with open(save_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        text = extract_text(str(save_path))
        if text.startswith("[ERROR]"):
            continue

        data = extract_permit_data(text, file.filename)
        try:
            permit = _enrich_and_save(data, save_path, "pdf", dokument_volltext=text)
            results.append(permit)
        except Exception:
            traceback.print_exc()

    return results
