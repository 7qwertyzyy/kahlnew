# Kahl Route & Permit Intelligence

Integriertes System aus Streckenplaner, Genehmigungs-Import und Anfrage-Matching.

## Architektur

```text
frontend/   Next.js 16, App Router, TypeScript, Tailwind, Mapbox
backend/    FastAPI, SQLite, Pydantic v2
api/        Vercel Python entrypoint fuer das FastAPI-Backend
```

## Lokal starten

```bat
start.bat
```

Oder manuell:

```bat
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

```bat
cd frontend
npm install
npm run dev
```

| Service | URL |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| API-Dokumentation | http://localhost:8000/docs |

## Environment Variables

Lege lokal diese Dateien aus den Beispielen an:

```bat
copy frontend\.env.example frontend\.env.local
copy backend\.env.example backend\.env
```

Wichtige Variablen:

| Variable | Verwendung |
| --- | --- |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox-Karte im Frontend |
| `NEXT_PUBLIC_ORS_API_KEY` | OpenRouteService-Routing |
| `NEXT_PUBLIC_API_URL` | Lokal `http://localhost:8000`; auf Vercel leer lassen |
| `AI_PROVIDER` | `anthropic`, `openai`, `azure`, `mistral` oder `ollama` |
| `MISTRAL_API_KEY`, `OPENAI_API_KEY`, ... | API-Key passend zum Provider |
| `DATABASE_PATH` | Optionaler SQLite-Pfad |
| `UPLOAD_DIR` | Optionaler Upload-Pfad |
| `BACKEND_CORS_ORIGINS` | Kommagetrennte Origins, falls Backend separat laeuft |

## GitHub vorbereiten

```bat
git init
git add .
git commit -m "Prepare Vercel deployment"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

`.gitignore` schliesst Secrets, `node_modules`, Next-Builds, Python-Caches, lokale SQLite-Dateien und Uploads aus.

## Vercel Deployment

Das Repository ist fuer ein einzelnes Vercel-Projekt vorbereitet:

- Root Directory: Repository-Root
- Install Command: `npm --prefix frontend ci`
- Build Command: `npm --prefix frontend run build`
- Output Directory: `frontend/.next`
- API Routes: `/api/*` wird auf `api/index.py` und damit auf FastAPI geroutet

In Vercel unter Project Settings -> Environment Variables setzen:

```text
NEXT_PUBLIC_MAPBOX_TOKEN=...
NEXT_PUBLIC_ORS_API_KEY=...
AI_PROVIDER=mistral
MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-large-latest
```

`NEXT_PUBLIC_API_URL` auf Vercel nicht setzen, wenn Frontend und Backend im gleichen Vercel-Projekt laufen. Dann ruft das Frontend automatisch `/api/...` auf derselben Domain auf.

## Wichtiger Hinweis zu Daten

Auf Vercel ist das Dateisystem fuer Serverless Functions nicht dauerhaft. SQLite und Uploads werden deshalb standardmaessig unter `/tmp` abgelegt und koennen bei neuen Deployments oder kalten Starts verloren gehen. Fuer produktive Nutzung sollte die Datenhaltung auf einen persistenten Dienst umgestellt werden, z. B. Postgres, Turso/LibSQL, Supabase oder Neon plus Object Storage fuer Uploads.

## Seiten

| Pfad | Funktion |
| --- | --- |
| `/` | Dashboard mit Stats und ablaufenden Genehmigungen |
| `/planer` | Streckenplaner mit Mapbox-Karte |
| `/genehmigungen` | Genehmigungsliste mit Suche und Filter |
| `/genehmigungen/upload` | PDF hochladen und KI-Extraktion |
| `/genehmigungen/[id]` | Detailansicht, Bearbeitung und Pruefung |
| `/anfrage` | Anfrage-Matcher gegen die Genehmigungsdatenbank |
