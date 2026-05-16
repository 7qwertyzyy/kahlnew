from fastapi import APIRouter
from models.permit import Permit
from models.transport_request import TransportRequest, MatchResult
from database.db import get_connection, row_to_dict
from services.matcher import find_matches

router = APIRouter()


class MatchResponse(MatchResult):
    permit: Permit


@router.post("/find")
def find_matching_permits(request: TransportRequest) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM permits").fetchall()

    permits = [row_to_dict(r) for r in rows]
    req_dict = request.model_dump()
    req_dict["erkannte_strassen"] = []

    results = find_matches(req_dict, permits)
    return [
        {
            "permit": Permit(**r["permit"]).model_dump(),
            "similarity_score": r["similarity_score"],
            "match_grund": r["match_grund"],
            "empfehlung": r["empfehlung"],
        }
        for r in results[:10]
    ]
