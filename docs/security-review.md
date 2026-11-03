# Security review and operator checklist

This is an implementation-oriented review of the current application, not an external penetration test or a guarantee of security. Revisit it after significant changes and before public launch.

| OWASP Top 10 risk | Current handling | Residual risk / operator action |
|---|---|---|
| A01: Broken Access Control | Authenticated event, reminder, upload, and export queries are scoped to the current user; foreign event IDs return not found. Account data is deleted through cascading ownership relationships. | Keep authorization-isolation tests in CI. Review every new endpoint and background job for owner scoping. |
| A02: Cryptographic Failures | Passwords use Argon2id; refresh and email tokens are stored hashed; authentication uses short-lived access cookies and rotating refresh cookies. Caddy supplies HTTPS in the production profile; cookies are secure in production. | Enable encrypted VPS/volume storage and encrypted backups. Configure TLS if PostgreSQL or SMTP is external. Application-level encryption for notes and locations is not implemented. |
| A03: Injection | Pydantic validates request bodies; SQLAlchemy uses parameterized expressions; React renders user strings as text and does not use `dangerouslySetInnerHTML`. CSP blocks framing and untrusted scripts. | Continue reviewing new SQL and rendering code. Treat AI-extracted text and notification content as untrusted. |
| A04: Insecure Design | CSRF checks protect mutations; rate limits cover sensitive operations; image bytes are decoded/re-encoded and bounded; extraction returns a draft that is not saved until confirmed. | Email jobs use in-process background tasks and can be lost on a crash. External email/push delivery cannot be exactly-once across crashes. |
| A05: Security Misconfiguration | Startup rejects weak secrets and unsafe production settings. CORS is restricted to the configured frontend origin. The production reverse proxy adds CSP and related headers; API and database ports are not published by Compose. | Set production-only values, restrict VPS ingress to 80/443 and SSH, and do not expose Docker, database, or API ports publicly. Review headers when changing the hosting topology. |
| A06: Vulnerable and Outdated Components | Direct Python and npm dependencies are version-pinned; CI runs `pip-audit` and `npm audit`. The current dependency audits report zero known advisories. | Run both audits during updates. Patch findings deliberately and rebuild/scan container images before deployment. |
| A07: Identification and Authentication Failures | Argon2id, generic login/recovery responses, hashed one-time email tokens, rate limiting, rotating refresh tokens, reuse detection, logout-all, and HttpOnly cookies are implemented. | Email verification and reset delivery are not backed by a durable outbox. TOTP is not implemented. Monitor rate-limit and account recovery behavior. |
| A08: Software and Data Integrity Failures | Dependency lockfile, Alembic migrations, CI builds, and isolated worker process are used. The Claude API is called only by the backend with constrained structured output. | CI actions and base images use version tags; pin actions/images by digest for higher-assurance supply-chain controls. |
| A09: Security Logging and Monitoring Failures | Structured server logs avoid passwords, tokens, full emails, and event contents; an audit log records key account actions. `/healthz` checks database connectivity. | Configure log retention, alerting, disk/backup monitoring, and an external error-tracking service without capturing sensitive payloads. |
| A10: Server-Side Request Forgery | The app does not fetch arbitrary user-supplied URLs. Push endpoints are limited to HTTPS browser-provider hostnames. | Keep the provider allowlist narrow and review any future URL-fetching or import feature. |

## Release checklist

- Replace all example credentials in `.env`; keep the file and age private key outside source control.
- Set `APP_ENV=production`, `COOKIE_SECURE=true`, and an HTTPS `FRONTEND_ORIGIN`.
- Configure a strong database password, SMTP, Anthropic, VAPID, DNS, Caddy, and encrypted storage.
- Verify that the database and application uploads are not public; test backups and a restore before accepting real data.
- Review the privacy policy, AI-provider terms, jurisdictional data retention, and support contact before public launch.
- Re-run backend tests, `ruff`, frontend type-check/build, `npm audit`, and `pip-audit`; run a PostgreSQL-backed CI job and assess container images.
- Perform an independent security test appropriate to the deployment and data sensitivity.
