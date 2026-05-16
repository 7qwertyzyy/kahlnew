from pydantic import BaseModel, Field
from typing import Optional


class KalkulationsBriefing(BaseModel):
    zusammenfassung: Optional[str] = None
    anfrage_bewertung: Optional[str] = None
    strecken_einschaetzung: Optional[str] = None
    genehmigungshinweis: Optional[str] = None
    erkenntnisse_aus_altfaellen: Optional[str] = None
    risiko_zusammenfassung: Optional[str] = None
    fehlende_informationen: list[str] = Field(default_factory=list)
    empfohlene_naechste_schritte: list[str] = Field(default_factory=list)
    hinweis_kalkulation: Optional[str] = None
    hinweis_genehmigung: Optional[str] = None
    hinweis_disposition: Optional[str] = None


class MinimalPermit(BaseModel):
    id: int
    genehmigungsnummer: Optional[str] = None
    startort: Optional[str] = None
    zielort: Optional[str] = None
    fahrzeug_breite_m: Optional[float] = None
    fahrzeug_hoehe_m: Optional[float] = None
    gesamtgewicht_t: Optional[float] = None
    gueltig_bis: Optional[str] = None
    risikostufe: Optional[str] = None
    auflagen: list[str] = Field(default_factory=list)
    erkannte_strassen: list[str] = Field(default_factory=list)
    begleitfahrzeug_erforderlich: bool = False
    polizei_erforderlich: bool = False
    nachtfahrt_erforderlich: bool = False
    risiko_begruendung: Optional[str] = None
    status: Optional[str] = None

    class Config:
        extra = "ignore"


class AnfrageMatch(BaseModel):
    id: int
    permit_id: int
    permit: Optional[MinimalPermit] = None
    similarity_score: float = 0.0
    match_gruende: list[str] = Field(default_factory=list)
    empfehlung: Optional[str] = None
    auflagen_aus_altfall: list[str] = Field(default_factory=list)
    risiken_aus_altfall: list[str] = Field(default_factory=list)
    begleitpflicht_in_altfall: bool = False
    polizei_in_altfall: bool = False
    nachtfahrt_in_altfall: bool = False
    erkannte_strassen_altfall: list[str] = Field(default_factory=list)


class TransportAnfrageBase(BaseModel):
    eingabe_typ: str = "freitext"
    eingabe_rohtext: Optional[str] = None
    eingabe_datei_pfad: Optional[str] = None
    kunde: Optional[str] = None
    ansprechpartner: Optional[str] = None
    email: Optional[str] = None
    telefon: Optional[str] = None
    startort: Optional[str] = None
    start_adresse: Optional[str] = None
    zielort: Optional[str] = None
    ziel_adresse: Optional[str] = None
    transportgut: Optional[str] = None
    laenge_m: Optional[float] = None
    breite_m: Optional[float] = None
    hoehe_m: Optional[float] = None
    gewicht_t: Optional[float] = None
    achslast_t: Optional[float] = None
    fahrzeugtyp: Optional[str] = None
    anzahl_fahrten: Optional[int] = None
    wunschdatum: Optional[str] = None
    frist_angebot: Optional[str] = None
    besonderheiten: list[str] = Field(default_factory=list)
    fehlende_infos: list[str] = Field(default_factory=list)
    schwertransport_relevant: Optional[bool] = None
    geschaetzte_komplexitaet: Optional[str] = None
    ki_einschaetzung: Optional[str] = None
    status: str = "neu"
    zugewiesen_an: Optional[str] = None
    prioritaet: str = "normal"
    interne_notizen: Optional[str] = None


class TransportAnfrageCreate(TransportAnfrageBase):
    pass


class TransportAnfrageUpdate(TransportAnfrageBase):
    pass


class AnfrageStatusUpdate(BaseModel):
    status: str


class TransportAnfrage(TransportAnfrageBase):
    id: int
    kalkulations_briefing: Optional[KalkulationsBriefing] = None
    risiko_zusammenfassung: Optional[str] = None
    auflagen_zusammenfassung: Optional[str] = None
    empfohlene_naechste_schritte: list[str] = Field(default_factory=list)
    kundenantwort_entwurf: Optional[str] = None
    erstellt_am: Optional[str] = None
    aktualisiert_am: Optional[str] = None
    matches: list[AnfrageMatch] = Field(default_factory=list)
    match_count: int = 0

    class Config:
        from_attributes = True


class AnfragenStats(BaseModel):
    total: int
    neu: int
    in_bearbeitung: int
    dringend: int
    diese_woche: int
