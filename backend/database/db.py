import sqlite3
import json
import os
from pathlib import Path

DEFAULT_DB_PATH = (
    Path("/tmp/permits.db")
    if os.getenv("VERCEL")
    else Path(__file__).parent.parent / "data" / "permits.db"
)
DB_PATH = Path(os.getenv("DATABASE_PATH") or DEFAULT_DB_PATH)
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

LIST_FIELDS = [
    "kennzeichen", "strecke", "erkannte_strassen",
    "auflagen", "behoerden", "besonderheiten",
]


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with get_connection() as conn:
        conn.executescript(schema)
        # Migrate existing DB: add new columns if missing
        _migrate(conn)
        conn.commit()


def _migrate(conn: sqlite3.Connection):
    existing = {row[1] for row in conn.execute("PRAGMA table_info(permits)")}
    new_cols = {
        "dateityp": "TEXT DEFAULT 'pdf'",
        "genehmigungsart": "TEXT",
        "start_adresse": "TEXT",
        "start_plz": "TEXT",
        "start_bundesland": "TEXT",
        "ziel_adresse": "TEXT",
        "ziel_plz": "TEXT",
        "ziel_bundesland": "TEXT",
        "achslast_t": "REAL",
        "erkannte_strassen": "TEXT DEFAULT '[]'",
        "auflagen_kurzfassung": "TEXT",
        "begleitfahrzeug_erforderlich": "INTEGER DEFAULT 0",
        "polizei_erforderlich": "INTEGER DEFAULT 0",
        "nachtfahrt_erforderlich": "INTEGER DEFAULT 0",
        "auflagenstaerke": "INTEGER DEFAULT 0",
        "auflagenstaerke_stufe": "TEXT DEFAULT 'niedrig'",
        "risikostufe": "TEXT DEFAULT 'niedrig'",
        "risiko_begruendung": "TEXT",
        "ki_zusammenfassung": "TEXT",
        "fahrer_hinweise": "TEXT",
        "dispo_hinweise": "TEXT",
        "original_datei_pfad": "TEXT",
        "extraktions_modell": "TEXT",
        "erstellt_am": "DATETIME DEFAULT CURRENT_TIMESTAMP",
        "aktualisiert_am": "DATETIME DEFAULT CURRENT_TIMESTAMP",
        "geprueft_von": "TEXT",
        "geprueft_am": "DATETIME",
        "kommentare": "TEXT",
    }
    for col, col_def in new_cols.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE permits ADD COLUMN {col} {col_def}")

    tr_existing = {row[1] for row in conn.execute("PRAGMA table_info(transport_requests)")}
    tr_cols = {
        "eingabe_typ": "TEXT NOT NULL DEFAULT 'freitext'",
        "eingabe_rohtext": "TEXT",
        "eingabe_datei_pfad": "TEXT",
        "ansprechpartner": "TEXT",
        "email": "TEXT",
        "telefon": "TEXT",
        "start_adresse": "TEXT",
        "ziel_adresse": "TEXT",
        "fahrzeugtyp": "TEXT",
        "anzahl_fahrten": "INTEGER DEFAULT 1",
        "frist_angebot": "DATE",
        "besonderheiten": "TEXT DEFAULT '[]'",
        "schwertransport_relevant": "INTEGER",
        "geschaetzte_komplexitaet": "TEXT",
        "ki_einschaetzung": "TEXT",
        "kalkulations_briefing": "TEXT",
        "risiko_zusammenfassung": "TEXT",
        "auflagen_zusammenfassung": "TEXT",
        "empfohlene_naechste_schritte": "TEXT DEFAULT '[]'",
        "kundenantwort_entwurf": "TEXT",
        "status": "TEXT DEFAULT 'neu'",
        "zugewiesen_an": "TEXT",
        "prioritaet": "TEXT DEFAULT 'normal'",
        "interne_notizen": "TEXT",
        "aktualisiert_am": "DATETIME DEFAULT CURRENT_TIMESTAMP",
    }
    for col, col_def in tr_cols.items():
        if col not in tr_existing:
            conn.execute(f"ALTER TABLE transport_requests ADD COLUMN {col} {col_def}")


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for field in LIST_FIELDS:
        val = d.get(field)
        if isinstance(val, str):
            try:
                parsed = json.loads(val)
                d[field] = parsed if isinstance(parsed, list) else [parsed]
            except Exception:
                d[field] = [val] if val else []
        elif val is None:
            d[field] = []
    for bool_field in ["begleitfahrzeug_erforderlich", "polizei_erforderlich", "nachtfahrt_erforderlich"]:
        if bool_field in d:
            d[bool_field] = bool(d[bool_field])
    return d


def serialize_list(val) -> str:
    if isinstance(val, list):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, str):
        try:
            json.loads(val)
            return val
        except Exception:
            return json.dumps([val], ensure_ascii=False)
    return "[]"
