# MDRRMO Emergency Report System
**Powered by FRANZOLUTIONS**

Real-time emergency reporting system built with Node.js, Express, EJS, and Socket.IO.
Icons: **Heroicons** (outlined, inline SVG). Logo: **Shield-check** mark.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template
cp .env.example .env

# 3. Run (production)
npm start

# 4. Run (development, auto-reload)
npm run dev
```

Required env:
- `MONGODB_URI` (or `MONGO_URI` / `DATABASE_URL`)
- `MONGODB_DB` (or `MONGO_DB` / `DB_NAME`; if omitted, DB name is read from URI path)
- `SESSION_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

Open in browser:

| Role       | URL                          |
|------------|------------------------------|
| Landing    | http://localhost:3000        |
| Reporter   | http://localhost:3000/report |
| Dispatcher | http://localhost:3000/dashboard |

---

## Project Structure

```
mdrrmo/
├── server.js          ← Express + Socket.IO server
├── package.json
├── README.md
├── views/
│   ├── index.ejs      ← Role selection landing page
│   ├── report.ejs     ← Citizen emergency report form  (/report)
│   └── dashboard.ejs  ← Dispatcher console            (/dashboard)
└── public/
    └── css/
        └── shared.css ← Design tokens (optional shared styles)
```

---

## API Reference

| Method   | Endpoint                   | Description            |
|----------|----------------------------|------------------------|
| GET      | `/`                        | Landing page           |
| GET      | `/report`                  | Reporter form          |
| GET      | `/dashboard`               | Dispatcher dashboard   |
| POST     | `/api/report`              | Submit a report        |
| POST     | `/api/panic`               | Submit Panic SOS       |
| PATCH    | `/api/report/:id/status`   | Update report status   |
| DELETE   | `/api/reports`             | Clear all reports      |
| GET      | `/api/reports`             | Fetch all reports      |

---

## Features

### /report — Citizen Reporter
- 5-step form with **Heroicons** throughout
- Emergency types: Fire, Flood, Medical, Accident, Landslide, Other
- Severity: Low / Medium / High
- GPS auto-detection
- Photo upload (base64)
- **Panic SOS** button — one tap sends location + phone to dispatchers

### /dashboard — Dispatcher Console
- Sidebar filter by status (All / New / Verifying / Dispatched / Resolved)
- Real-time new report flash (green pulse on card arrival)
- Workflow: New → Verifying → Dispatched → Resolved
- False report flagging
- Credibility scoring (High / Medium / Low)
- Photo thumbnails
- Socket.IO: all dispatcher windows sync instantly

---

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Realtime**: Socket.IO
- **Templating**: EJS
- **Icons**: Heroicons (outlined, inline SVG — no CDN needed)
- **Fonts**: Outfit + JetBrains Mono (Google Fonts)
- **Storage**: In-memory (replace with MongoDB/PostgreSQL for production)
