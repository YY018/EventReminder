# Deployment and operations

## Local Docker Compose

Requirements: Docker Engine with the Compose plugin. Copy `.env.example` to `.env`, then set `POSTGRES_PASSWORD` to a long URL-safe random string and `APP_SECRET` to at least 32 random bytes. Generate secrets with:

```sh
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "import secrets; print(secrets.token_hex(32))"
```

Start the application:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

Open `http://localhost:8080`; API documentation is at `http://localhost:8080/api/docs`. Compose waits for PostgreSQL, runs Alembic migrations before starting the API, starts one reminder worker, and keeps PostgreSQL data and private uploads in named volumes. Image extraction, email, and push require their corresponding credentials; without Anthropic credentials, extraction offers manual entry.

The compose stack is a local-development setup by default. It binds the frontend to loopback and does not publish PostgreSQL or the API port. The API is reached through the same-origin `/api` reverse-proxy path.

## Vercel frontend with a Docker backend

Vercel is configured to build the Vite frontend from the repository root using `vercel.json`. The FastAPI API and the APScheduler reminder worker should remain separate Docker services on a container host, with a managed PostgreSQL database and durable private upload storage. Vercel serverless functions are request-driven and are not a replacement for the continuously running APScheduler worker. Do not deploy the Compose PostgreSQL service to Vercel.

1. Import [YY018/EventReminder](https://github.com/YY018/EventReminder) in Vercel and keep **Root Directory** at the repository root (`./`). The root `vercel.json` installs/builds under `frontend/` and serves `frontend/dist/`; the rewrite supports client-side routes. This source repository is public; do not place secrets in it.
2. Deploy the backend Docker image as a web service and a separate worker service on a container platform. Use a managed PostgreSQL database. The web service runs `alembic upgrade head` before serving; start the worker after the API deployment/migration completes, and give both services the same database URL and application secrets. Mount persistent private storage for retained uploads.
3. Assign related custom hostnames, for example `app.example.com` to Vercel and `api.example.com` to the backend. Both should be HTTPS and under the same registrable domain. The authentication cookies are `SameSite=Lax`; unrelated default domains such as `*.vercel.app` and `*.onrender.com` are cross-site and may prevent cookie authentication in browsers.
4. Set Vercel Production environment variables:
   - `VITE_API_BASE_URL=https://api.example.com`
   - `VITE_VAPID_PUBLIC_KEY=<your VAPID public key>` (if web push is enabled)
5. Set backend Production environment variables:
   - `APP_ENV=production`, `COOKIE_SECURE=true`, and `FRONTEND_ORIGIN=https://app.example.com`
   - A strong unique `APP_SECRET`, TLS-enabled `DATABASE_URL`, and durable `UPLOAD_DIR`
   - SMTP, Anthropic, VAPID private key, and VAPID claim email as needed
6. Configure the API host's CORS allow-origin to exactly `https://app.example.com` (the application reads `FRONTEND_ORIGIN`) and allow credentialed requests. Configure the custom `api.example.com` domain on the backend host. Then redeploy the Vercel frontend so its build contains the API URL, and verify `https://api.example.com/healthz`, sign-up/login, event CRUD, exports, and reminder delivery.

Do not put secrets in Vercel's build logs, Git, or chat; enter them only in the respective provider's encrypted environment-variable settings. Vercel hosts the frontend and serves it globally from its CDN; Docker provides a portable way to run the backend and persistent worker, but does not itself make the app run at the edge.

## VPS with Caddy and HTTPS

1. Provision a maintained Linux VPS with an encrypted disk/volume, Docker Engine and Compose, and a DNS `A`/`AAAA` record for the application domain. Allow inbound TCP 80/443 and restricted SSH only.
2. Copy `.env.example` to `.env`. Set a unique `APP_SECRET`, long URL-safe `POSTGRES_PASSWORD`, `APP_ENV=production`, `COOKIE_SECURE=true`, `APP_DOMAIN`, and `FRONTEND_ORIGIN=https://<your-domain>`. Configure SMTP, Anthropic, VAPID, and the backup settings. Never commit or publish `.env`.
3. Generate the frontend with the correct VAPID public key and launch Caddy's production profile:

   ```sh
   docker compose --profile production up --build -d
   docker compose ps
   curl --fail https://<your-domain>/api/healthz
   ```

   Caddy obtains and renews a public TLS certificate. The frontend image proxies `/api/` to FastAPI on the private Compose network. Do not publish the `api` or `db` ports. Changing `VAPID_PUBLIC_KEY` requires rebuilding the frontend image.
4. Monitor `https://<your-domain>/api/healthz`, container restarts, structured API/worker logs, available disk, certificate renewal, and backup age. Configure host-level alerting and log retention. The service does not ship with a third-party error-tracking integration.

For an external managed PostgreSQL database, set the API/worker `DATABASE_URL` to a TLS-enabled connection string and apply migrations during deployment. Configure the database provider's encryption-at-rest and network allowlists. The included Compose database is for a self-hosted database; protect its underlying host volume with encrypted storage.

## Encrypted daily database backups

Install Docker Compose and [`age`](https://age-encryption.org/) on the backup host. Generate an age identity once, store its private identity offline (not on the VPS), and put only its public recipient in `BACKUP_AGE_RECIPIENT`. Set `BACKUP_DIR` to a protected persistent host directory. The backup script streams `pg_dump` directly into age encryption, writes a mode-restricted file atomically, and prunes backups older than 30 days.

Run a manual backup from the project directory:

```sh
bash ops/backup.sh
```

Schedule it daily (for example, 02:00 UTC) with cron or a systemd timer. Alert if the script exits unsuccessfully or if the latest backup is older than 26 hours. Copy encrypted backups to a separate host or object-storage account with restricted access; test restores regularly.

Restore requires the private age identity and overwrites database objects. Stop the API and worker, then run:

```sh
export AGE_IDENTITY_FILE=/secure/offline-mounted/age-identity.txt
bash ops/restore.sh /secure/backups/eventreminder-YYYYMMDDTHHMMSSZ.dump.age
docker compose up -d api worker
```

The restore script prompts for confirmation and uses `pg_restore --clean`. Restore uploads separately from a protected private-upload backup if original images are retained; database-only backups do not contain the upload volume. Store that volume backup encrypted and restore it to the same private mount before restarting the app.

## Data-at-rest and incident response

TLS terminates at Caddy and continues over the private Docker network. The application does not implement field-level encryption for event notes or locations; enable host/provider volume encryption and keep encrypted backups. If your threat model requires database operators to be unable to read event text, design and review a key-management and searchable-encryption approach before deployment. For suspected credential compromise, rotate `APP_SECRET` with a planned session invalidation, revoke/rotate SMTP, Anthropic, and VAPID credentials as applicable, inspect audit and service logs, and restore only from verified backups.
