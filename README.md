# Clever Energy Use: APG Day-Ahead Prices + Push Notifications

This project contains:

- A `PHP` backend (`api/index.php`) for shared hosting.
- Calculation logic for day-ahead prices (average/min/max/spread/negative-hours/day-delta).
- A PWA webapp for Android/iOS push subscription.
- A scheduled GitHub Actions workflow that triggers checks and sends push notifications on data changes.

## APG API spec

- Swagger UI: `https://transparency.apg.at/api/swagger/index.html`
- OpenAPI JSON: `https://transparency.apg.at/api/swagger/v1/swagger.json`
- Used endpoint: `/v1/EXAAD1P/Data/{language}/PT15M/{fromlocal}/{tolocal}`

## 1) Setup

1. Copy environment file:
   ```bash
   cp .env.example .env
   ```
2. Fill in all values in `.env` (VAPID keys, check secret, etc.).
3. Ensure your host points the web root to the project deploy root (where `index.html` from `public/` is uploaded).
4. Ensure PHP can write into `data/`.
5. Install PHP push library:
   ```bash
   composer install --no-dev
   ```
   This installs `minishlink/web-push`. If `vendor/` is missing, `/api/check` still works but push sending returns a warning.

## 2) API endpoints

- `GET /api/spec`
  - Returns APG spec and endpoint contract used by this app.
- `GET /api/data`
  - Fetches APG day-ahead prices and returns the raw series plus calculated stats.
  - Optional query params:
    - `date=YYYY-MM-DD` (defaults to `today + APG_DAY_OFFSET` in Europe/Vienna; default offset is `0`)
    - `language=English|German`
- `GET /api/status`
  - Returns latest run metadata and subscriber count.
- `POST /api/check`
  - Secure check endpoint used by GitHub Actions.
  - Requires `Authorization: Bearer <WEBSITE_CHECK_SECRET>`
  - Optional query params: `date`, `language`
- `POST /api/subscribe` / `POST /api/unsubscribe`
  - Device push subscription management.
- `POST /api/settings`
  - Updates notification window/digest settings for a subscribed device by endpoint.

## 3) Calculations returned

- `average` (EUR/MWh)
- `min` / `max` (EUR/MWh)
- `spread` (`max-min`)
- `negativeHours`
- `first`, `last`, `dayDelta` (`last-first`)

## 3.1) Automatic per-user notifications on backend runs

Whenever `/api/check` runs, subscribed users are evaluated server-side:

- Daily digest:
  - Sent once per day if `dailyDigestEnabled=true` and current Vienna time is inside that user's active window (Werktag vs Feiertag/Wochenende).
  - Title: `Deine Benachrichtigung über den heutigen Strompreis`
- Cheap energy alert:
  - Sent once per day if `cheapAlertEnabled=true`, current Vienna time is in the user's active window, and current time is inside that user's cheapest 45-minute range.
  - Title: `Der Strom ist ab jetzt billig!`

Delivery history is stored per subscription in `data/subscriptions.json`.

## 4) Mobile notifications (Android + iOS)

- Android: Chromium-based browsers with Push API support.
- iOS: iOS/iPadOS 16.4+ and installed to Home Screen (PWA).

## 5) GitHub Actions schedule

Workflow file: `.github/workflows/scheduled-check.yml`

Set repository secrets:

- `WEBSITE_CHECK_URL`: Full deployed `/api/check` URL
  - Example: `https://your-domain.com/api/check`
- `WEBSITE_CHECK_SECRET`: Same value as `.env` `WEBSITE_CHECK_SECRET`

The workflow runs every 15 minutes and can also be triggered manually.

## 6) Notes

- Runtime data is persisted in `data/state.json` and `data/subscriptions.json`.
- `data/state.json` is pruned automatically to stay small (max 30 history entries, plus byte-size cap).
- APG responses are cached in `data/apg-cache.json` and reused for up to 2 hours before refetch.
- Backend stores today's Austria day type (`Werktag` vs `Feiertag/Wochenende`) in state and reuses it until the Vienna date changes.
- Notification settings (Werktags/Feiertags windows + daily digest toggle) are stored server-side per subscription.
- Production requires HTTPS (service worker + push notifications).
- PHP API router lives in `api/index.php` and routes via `api/.htaccess`.

## 7) Shared hosting deployment (PHP backend + frontend)

Workflow file: `.github/workflows/deploy-shared-hosting.yml`

Set repository secrets:

- `WEBHOSTING_FTP_SERVER`
- `WEBHOSTING_FTP_USERNAME`
- `WEBHOSTING_FTP_PASSWORD`
- `WEBHOSTING_TARGET_DIR` (example: `/public_html/`)

What gets deployed:

- `public/*` to web root (frontend files)
- `api/*` to `/api` (PHP API endpoints)
- `data/.gitkeep` to create `/data`
- `.env.example` and `composer.json` (reference)
