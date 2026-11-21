# CSE312 Multiplayer 3D Web Game

A small, modular multiplayer browser game starter. The browser client uses Vite, JavaScript, and Three.js. Docker Compose runs Nginx, an Express authentication service, an Express/Colyseus game service, and PostgreSQL.

## Run locally

1. Install Docker Desktop with Compose.
2. Copy `.env.example` to `.env` and set strong, unique database passwords (`POSTGRES_PASSWORD` and `APP_DB_PASSWORD`). Keep `.env` and generated signing keys private.
3. Run `docker compose up --build` from this directory.
4. Open `http://localhost:8080`. Register an account, then use the game page. Nginx routes `/api/` to authentication and `/colyseus/` WebSocket traffic to the game server. The Vite build is served by the game server. Set `PUBLIC_ORIGIN` to the exact browser origin including the port.

The first authentication service startup generates an RSA key pair in the Compose `jwt-keys` volume. The game server waits for the auth health check and verifies tokens using only the public key. For HTTPS deployment, terminate TLS at Nginx, set `COOKIE_SECURE=true`, configure `PUBLIC_ORIGIN=https://your-host`, and provide valid TLS certificates and Nginx TLS configuration. HSTS is disabled for local HTTP and enabled when `COOKIE_SECURE=true`.

## Deploy to Render

Use the Blueprint in `render.yaml` from Render's **New + > Blueprint** flow. It creates the private auth service, the public game service (which proxies `/api/*` to auth), a PostgreSQL database, and a generated shared JWT secret. The deployment uses the same game URL for the browser origin and secure cookies; no values from `.env` need to be copied to Render. The Compose deployment continues to use its local RSA key volume.

The Blueprint uses paid plans for the private auth service and persistent database. The game service uses Render's free plan and can spin down while idle; choose a paid web plan in `render.yaml` if you need it continuously available for WebSocket sessions. Keep `.env` local and do not commit it.

For a free trial with separate containers, create both auth and game as **public Free Web Services** instead of creating a private auth service. Configure `AUTH_SERVICE_URL` on the game service to the auth service's public HTTPS URL, and set the same `JWT_SECRET` on both services. Set auth's `PUBLIC_ORIGIN` to the game service URL and leave `TRUST_PROXY_ORIGIN` unset so auth continues enforcing the browser origin. A free Render Postgres database can be used for a short demo, but it expires after 30 days. Free web services can spin down while idle, and the auth service's first request after spin-down may be slow.

## Layout

```text
client/                 Vite and Three.js browser client
server/auth/            Express auth API, PostgreSQL access, JWT signing
server/game/            Express static hosting and Colyseus room
shared/                 Shared protocol constants
nginx/                  Reverse proxy and security headers
database/               Least-privilege database initialization
scripts/                RSA key initialization
docker-compose.yml      Four-service local deployment
```

## Security implemented

- Helmet response headers, CSP, no `X-Powered-By`, and conditional HSTS.
- Authentication uses RS256 JWTs in HttpOnly cookies, strict algorithm/issuer/audience/expiry checks, short token lifetime, bcrypt password hashes, generic login errors, and rate limits.
- State-changing auth routes require an allowed `Origin` and a synchronizer CSRF token obtained from `GET /api/csrf-token`. The token is kept in a readable, SameSite cookie and must be echoed in `X-CSRF-Token`; the session JWT remains HttpOnly. Registration and login are protected too.
- Explicit origin allowlists for HTTP and WebSocket connections. WebSocket room joins require a valid JWT, and game messages are size/frequency limited and validated server-side. The server owns player positions and ignores client identity/position claims.
- PostgreSQL statements are parameterized. The app connects as a non-superuser limited to the application database/schema. Request sizes, fields, and username/email/password formats are constrained; errors returned to clients do not include SQL or stack details.
- User supplied names/messages are validated and displayed using `textContent`; no `innerHTML` or dynamic code execution is used.

## Security checks

Run `npm test` to exercise client game-session behavior: unauthenticated session starts are rejected, logout disconnects the client without stopping the server, and repeated login reuses one room so one chat submission is sent once.

After `docker compose up --build`, run `npm run security-check` from the repository root. The script exercises auth headers, registration/login, parameterized SQL behavior, XSS payload handling, CSRF enforcement, origin rejection, JWT rejection, rate limiting, cookie authentication, size limits, and WebSocket authentication/origin checks against the running local stack. It needs Node.js 20+ on the host. The checks create disposable test accounts in the configured database; stop/reset the local stack with `docker compose down -v` if you want to remove all local data.

These checks cover the local development configuration, not a production penetration test. Production deployment still requires HTTPS, protected environment secrets, key backup/rotation, monitoring, and review of the exact deployment origin and CSP needs. The sample game is a starter: gameplay rules and persistence are not included.
