from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class PermitBase(BaseModel):
    dateiname: Optional[str] = None
    dateityp: Optional[str] = "pdf"
    genehmigungsnummer: Optional[str] = None
    antragsnummer: Optional[str] = None
    genehmigungsart: Optional[str] = None
    kunde: Optional[str] = None
    startort: Optional[str] = None
    start_adresse: Optional[str] = None
    start_plz: Optional[str] = None
    start_bundesland: Optional[str] = None
    zielort: Optional[str] = None
    ziel_adresse: Optional[str] = None
    ziel_plz: Optional[str] = None
    ziel_bundesland: Optional[str] = None
    gueltig_von: Optional[str] = None
    gueltig_bis: Optional[str] = None
    fahrzeug_laenge_m: Optional[float] = None
    fahrzeug_breite_m: Optional[float] = None
    fahrzeug_hoehe_m: Optional[float] = None
    gesamtgewicht_t: Optional[float] = None
    achslast_t: Optional[float] = None
    kennzeichen: list[str] = Field(default_factory=list)
    strecke: list[str] = Field(default_factory=list)
    erkannte_strassen: list[str] = Field(default_factory=list)
    autobahnen: list[str] = Field(default_factory=list)
    bundesstrassen: list[str] = Field(default_factory=list)
    kreisstrassen: list[str] = Field(default_factory=list)
    anschlussstellen: list[str] = Field(default_factory=list)
    strassen_sequenz: list[str] = Field(default_factory=list)
    strecke_volltext: Optional[str] = None
    dokument_volltext: Optional[str] = None
    auflagen_volltext: Optional[str] = None
    start_location_name: Optional[str] = None
    ziel_location_name: Optional[str] = None
    auflagen: list[str] = Field(default_factory=list)
    auflagen_kurzfassung: Optional[str] = None
    behoerden: list[str] = Field(default_factory=list)
    besonderheiten: list[str] = Field(default_factory=list)
    begleitfahrzeug_erforderlich: bool = False
    polizei_erforderlich: bool = False
    nachtfahrt_erforderlich: bool = False
    auflagenstaerke: Optional[int] = 0
    auflagenstaerke_stufe: Optional[str] = "niedrig"
    risikostufe: Optional[str] = "niedrig"
    risiko_begruendung: Optional[str] = None
    ki_zusammenfassung: Optional[str] = None
    fahrer_hinweise: Optional[str] = None
    dispo_hinweise: Optional[str] = None
    confidence: float = 0.0
    status: str = "needs_review"
    kommentare: Optional[str] = None


class PermitCreate(PermitBase):
    pass


class PermitUpdate(PermitBase):
    pass


class PermitStatusUpdate(BaseModel):
    status: str
    geprueft_von: Optional[str] = None


class Permit(PermitBase):
    id: int
    original_datei_pfad: Optional[str] = None
    extraktions_modell: Optional[str] = None
    erstellt_am: Optional[str] = None
    aktualisiert_am: Optional[str] = None
    geprueft_von: Optional[str] = None
    geprueft_am: Optional[str] = None

    class Config:
        from_attributes = True


class PaginatedPermits(BaseModel):
    items: list[Permit]
    total: int
    page: int
    limit: int
    pages: int


class DashboardStats(BaseModel):
    total_permits: int
    active_permits: int
    expiring_soon: int
    needs_review: int
    expired: int
    critical_risk: int
