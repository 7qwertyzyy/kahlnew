import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database.db import init_db
from routers import permits, upload, matching, health, anfragen, routes

app = FastAPI(title="Kahl Genehmigungs-API", version="0.1.0")

default_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
env_origins = [
    origin.strip()
    for origin in os.getenv("BACKEND_CORS_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=default_origins + env_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, tags=["health"])
app.include_router(upload.router, prefix="/api/upload", tags=["upload"])
app.include_router(permits.router, prefix="/api/permits", tags=["permits"])
app.include_router(matching.router, prefix="/api/matching", tags=["matching"])
app.include_router(anfragen.router, prefix="/api/anfragen", tags=["anfragen"])
app.include_router(routes.router, prefix="/api/routes", tags=["routes"])


@app.on_event("startup")
def startup():
    init_db()
