# Clever Energy Use: APG Day-Ahead Prices + Push Notifications

This project contains:

- An `Express` backend that reads Austrian Power Grid day-ahead spot prices from the APG Transparency API.
- Calculation logic for day-ahead prices (average/min/max/spread/negative-hours/day-delta).
- A PWA webapp for Android/iOS push subscription.
- A scheduled GitHub Actions workflow that triggers checks and sends push notifications on data changes.

## APG API spec

- Swagger UI: `https://transparency.apg.at/api/swagger/index.html`
- OpenAPI JSON: `https://transparency.apg.at/api/swagger/v1/swagger.json`
- Used endpoint: `/v1/EXAAD1P/Data/{language}/{resolution}/{fromlocal}/{tolocal}`

## 1) Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment file:
   ```bash
   cp .env.example .env
   ```
3. Generate VAPID keys:
   ```bash
   npx web-push generate-vapid-keys
   ```
4. Put the generated keys into `.env`.

## 2) Run locally

```bash
npm run dev
```

Open `http://localhost:3000`.

## 3) API endpoints

- `GET /api/spec`
  - Returns APG spec and endpoint contract used by this app.
- `GET /api/data`
  - Fetches APG day-ahead prices and returns the raw series plus calculated stats.
  - Optional query params:
    - `date=YYYY-MM-DD` (defaults to `today + APG_DAY_OFFSET` in Europe/Vienna)
    - `resolution=PT15M|PT60M`
    - `language=English|German`
- `GET /api/status`
  - Returns latest run metadata and subscriber count.
- `POST /api/check`
  - Secure check endpoint used by GitHub Actions.
  - Requires `Authorization: Bearer <CHECK_SECRET>`
  - Optional query params: `date`, `resolution`, `language`
- `POST /api/subscribe` / `POST /api/unsubscribe`
  - Device push subscription management.

## 4) Calculations returned

- `average` (EUR/MWh)
- `min` / `max` (EUR/MWh)
- `spread` (`max-min`)
- `negativeHours`
- `first`, `last`, `dayDelta` (`last-first`)

## 5) Mobile notifications (Android + iOS)

- Android: Chromium-based browsers with Push API support.
- iOS: iOS/iPadOS 16.4+ and installed to Home Screen (PWA).

## 6) GitHub Actions schedule

Workflow file: `.github/workflows/scheduled-check.yml`

Set repository secrets:

- `WEBSITE_CHECK_URL`: Full deployed `/api/check` URL
  - Example: `https://your-domain.com/api/check`
- `WEBSITE_CHECK_SECRET`: Same value as `.env` `CHECK_SECRET`

The workflow runs every 15 minutes and can also be triggered manually.

## 7) Notes

- Runtime data is persisted in `data/state.json` and `data/subscriptions.json`.
- Production requires HTTPS (service worker + push notifications).
