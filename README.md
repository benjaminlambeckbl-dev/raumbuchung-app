# Raumbuchung App

Standalone Node.js Version des Raumbuchungssystems (ohne n8n).

## Lokal starten

```bash
npm install
npm start
# → http://localhost:3000
```

## Railway Deployment

1. GitHub Repo erstellen und Code pushen
2. railway.app → New Project → Deploy from GitHub
3. Unter **Settings → Volumes**: Volume mounten auf `/app/data` (Datenpersistenz)
4. Optional: `DATA_FILE=/app/data/db.json` als Environment Variable setzen

## Echtzeit-Sync

Alle Browser-Clients verbinden sich via **Server-Sent Events** auf `/api/events`.
Buchungen und Stornierungen erscheinen sofort bei allen Nutzern.

## Datenspeicher

JSON-Datei unter `data/db.json`. Für Railway: Volume auf `/app/data` mounten,
damit Daten bei Restarts erhalten bleiben.
