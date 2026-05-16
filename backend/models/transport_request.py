from pydantic import BaseModel
from typing import Optional


class TransportRequest(BaseModel):
    kunde: Optional[str] = None
    startort: str
    zielort: str
    laenge_m: Optional[float] = None
    breite_m: Optional[float] = None
    hoehe_m: Optional[float] = None
    gewicht_t: Optional[float] = None
    achslast_t: Optional[float] = None
    transportgut: Optional[str] = None
    wunschdatum: Optional[str] = None


class MatchResult(BaseModel):
    permit_id: int
    similarity_score: float
    match_grund: list[str]
    empfehlung: str
