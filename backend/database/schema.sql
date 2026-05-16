CREATE TABLE IF NOT EXISTS permits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dateiname TEXT,
    dateityp TEXT DEFAULT 'pdf',
    genehmigungsnummer TEXT,
    antragsnummer TEXT,
    genehmigungsart TEXT,
    kunde TEXT,
    startort TEXT,
    start_adresse TEXT,
    start_plz TEXT,
    start_bundesland TEXT,
    zielort TEXT,
    ziel_adresse TEXT,
    ziel_plz TEXT,
    ziel_bundesland TEXT,
    gueltig_von DATE,
    gueltig_bis DATE,
    fahrzeug_laenge_m REAL,
    fahrzeug_breite_m REAL,
    fahrzeug_hoehe_m REAL,
    gesamtgewicht_t REAL,
    achslast_t REAL,
    kennzeichen TEXT DEFAULT '[]',
    strecke TEXT DEFAULT '[]',
    erkannte_strassen TEXT DEFAULT '[]',
    auflagen TEXT DEFAULT '[]',
    auflagen_kurzfassung TEXT,
    behoerden TEXT DEFAULT '[]',
    besonderheiten TEXT DEFAULT '[]',
    begleitfahrzeug_erforderlich INTEGER DEFAULT 0,
    polizei_erforderlich INTEGER DEFAULT 0,
    nachtfahrt_erforderlich INTEGER DEFAULT 0,
    auflagenstaerke INTEGER DEFAULT 0,
    auflagenstaerke_stufe TEXT DEFAULT 'niedrig',
    risikostufe TEXT DEFAULT 'niedrig',
    risiko_begruendung TEXT,
    ki_zusammenfassung TEXT,
    fahrer_hinweise TEXT,
    dispo_hinweise TEXT,
    confidence REAL DEFAULT 0,
    status TEXT DEFAULT 'needs_review',
    original_datei_pfad TEXT,
    extraktions_modell TEXT,
    erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    geprueft_von TEXT,
    geprueft_am DATETIME,
    kommentare TEXT
);

CREATE TABLE IF NOT EXISTS transport_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Eingabe: Rohdaten
    eingabe_typ TEXT NOT NULL DEFAULT 'freitext',
    eingabe_rohtext TEXT,
    eingabe_datei_pfad TEXT,

    -- KI-extrahierte Felder
    kunde TEXT,
    ansprechpartner TEXT,
    email TEXT,
    telefon TEXT,
    startort TEXT,
    start_adresse TEXT,
    zielort TEXT,
    ziel_adresse TEXT,
    transportgut TEXT,
    laenge_m REAL,
    breite_m REAL,
    hoehe_m REAL,
    gewicht_t REAL,
    achslast_t REAL,
    fahrzeugtyp TEXT,
    anzahl_fahrten INTEGER DEFAULT 1,
    wunschdatum DATE,
    frist_angebot DATE,
    besonderheiten TEXT DEFAULT '[]',

    -- KI-Analyse
    fehlende_infos TEXT,
    schwertransport_relevant INTEGER,
    geschaetzte_komplexitaet TEXT,
    ki_einschaetzung TEXT,

    -- Briefing
    kalkulations_briefing TEXT,
    risiko_zusammenfassung TEXT,
    auflagen_zusammenfassung TEXT,
    empfohlene_naechste_schritte TEXT DEFAULT '[]',
    kundenantwort_entwurf TEXT,

    -- Workflow
    status TEXT DEFAULT 'neu',
    zugewiesen_an TEXT,
    prioritaet TEXT DEFAULT 'normal',
    interne_notizen TEXT,

    -- Legacy/Meta
    anfrage_text TEXT,
    erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transport_request_id INTEGER,
    permit_id INTEGER,
    similarity_score REAL,
    match_grund TEXT,
    empfehlung TEXT,
    erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id),
    FOREIGN KEY (permit_id) REFERENCES permits(id)
);

CREATE TABLE IF NOT EXISTS anfrage_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transport_request_id INTEGER NOT NULL,
    permit_id INTEGER NOT NULL,
    similarity_score REAL,
    match_gruende TEXT DEFAULT '[]',
    permit_status TEXT,
    empfehlung TEXT,
    erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transport_request_id) REFERENCES transport_requests(id),
    FOREIGN KEY (permit_id) REFERENCES permits(id)
);
