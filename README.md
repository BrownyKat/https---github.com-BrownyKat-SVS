# SVS Emergency Reporting System

Smart Verification System (SVS) is a server-rendered emergency reporting platform for citizens, dispatchers, and admins. It is built with Node.js, Express, EJS, MongoDB via Mongoose, and Pusher for realtime updates.

## Stack

- Backend: Node.js, Express
- Views: EJS
- Styling: Tailwind CDN on public pages plus custom CSS in templates
- Database: MongoDB with Mongoose
- Realtime: Pusher
- Push notifications: Firebase Admin
- File storage: Supabase Storage for uploaded report photos
- Deployment: Vercel-compatible via `api/index.js` rewrite adapter

## What The App Does

- Citizens can send a one-tap SOS alert or submit a detailed emergency report
- Dispatchers can log in, claim reports, update status, pass reports, review media, and manage profile details
- Admins can manage dispatchers, review reports, publish alerts, and export data
- Citizens can track a submitted report using its report ID
- Mobile devices can register push tokens for alert delivery

## Main Routes

### Public

- `/` -> SOS entry page
- `/sos` -> SOS alert page
- `/report` -> detailed report form
- `/track` -> public report tracking page
- `/about` -> public information page
- `/faq` -> FAQ and feedback page

### Auth

- `/dispatcher/login`
- `/dispatcher/reset`
- `/login` -> admin login

### Protected

- `/dashboard` -> dispatcher dashboard
- `/dispatcher/profile`
- `/admin` -> admin console

## Main API Routes

### Public API

- `GET /api/ping`
- `GET /api/health`
- `GET /api/alerts/latest`
- `GET /api/alerts`
- `GET /api/report-track/:id`
- `GET /api/reverse-geocode`
- `POST /api/report`
- `POST /api/panic`
- `POST /api/device-tokens/register`
- `POST /api/device-tokens/unregister`

### Dispatcher/Admin API

- `GET /api/reports`
- `GET /api/report/:id/media`
- `GET /api/dispatchers/active`
- `PATCH /api/report/:id/status`
- `PATCH /api/report/:id/details`
- `POST /api/report/:id/claim`
- `POST /api/report/:id/pass`
- `GET /api/call/:id/signal`
- `POST /api/call/:id/offer`
- `POST /api/call/:id/answer`
- `POST /api/call/:id/candidate`
- `DELETE /api/call/:id`
- `DELETE /api/reports`

### Admin API

- `GET /api/admin/live`
- `GET /api/admin/dispatchers/status`

## Core Models

- `Report`
- `Counter`
- `Admin`
- `Dispatcher`
- `AuditLog`
- `Alert`
- `DeviceToken`
- `Session`
- `LoginAttempt`
- `FaqFeedback`

## Realtime Events

The app uses Pusher to broadcast operational events such as:

- new reports
- report updates
- report assignment changes
- audit log creation
- admin alert creation, update, and deletion
- report clear actions

## Environment Variables

### Required

- `MONGODB_URI` or `MONGO_URI` or `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `DISPATCHER_USERNAME` or `DEFAULT_DISPATCHER_USERNAME`
- `DISPATCHER_PASSWORD` or `DEFAULT_DISPATCHER_PASSWORD`

### Common Optional

- `MONGODB_DB`
- `MONGODB_DIRECT_URI`
- `CORS_ORIGIN`
- `COOKIE_SECURE`
- `BASE_URL`
- `APP_URL`
- `PUBLIC_APP_URL`

### Realtime

- `PUSHER_APP_ID`
- `PUSHER_KEY`
- `PUSHER_SECRET`
- `PUSHER_CLUSTER`
- `PUSHER_CHANNEL`

### Supabase

- `SUPABASE_URL`
- `SUPABASE_BUCKET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `SUPABASE_ALERTS_TABLE`
- `SUPABASE_DEVICE_TOKENS_TABLE`

### Firebase Push

- `FIREBASE_SERVICE_ACCOUNT_JSON`

or:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

## Local Development

```bash
npm install
npm run dev
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/report`
- `http://localhost:3000/track`
- `http://localhost:3000/dashboard`
- `http://localhost:3000/admin`

## Production / Vercel Notes

- `vercel.json` rewrites all public and API routes through `api/index.js`
- `api/index.js` restores the original route so the Express app can run in Vercel serverless mode
- public tracking also server-renders `/track?id=...` so report lookup works reliably in Vercel
- cookies are role-based:
  - `auth_token_dispatcher`
  - `auth_token_admin`

## Project Structure

```text
.
|-- api/
|   |-- index.js
|   |-- panic.js
|   |-- report.js
|   `-- reverse-geocode.js
|-- models/
|-- views/
|   |-- partials/
|   |-- about.ejs
|   |-- admin.ejs
|   |-- dashboard.ejs
|   |-- dispatcher-login.ejs
|   |-- faq.ejs
|   |-- index.ejs
|   |-- report.ejs
|   |-- sos.ejs
|   `-- track.ejs
|-- server.js
|-- vercel.json
`-- package.json
```

## Notes

- This repo currently uses Pusher, not Socket.IO
- Public pages mix Tailwind utility classes with custom CSS depending on the page
- Admin alerts can be mirrored to mobile clients and stored in Supabase
- Report photos are uploaded to Supabase Storage and MongoDB stores the resulting URL
