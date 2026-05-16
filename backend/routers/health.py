from fastapi import APIRouter
from database.db import get_connection

router = APIRouter()


@router.get("/health")
def health():
    try:
        with get_connection() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "error", "db": str(e)}
