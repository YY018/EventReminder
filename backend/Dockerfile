FROM python:3.12.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip==25.0.1 \
    && python -m pip install -r requirements.txt \
    && useradd --system --uid 10001 --create-home app \
    && mkdir -p /data/uploads \
    && chown -R app:app /app /data/uploads

COPY --chown=app:app backend/app ./app
COPY --chown=app:app backend/migrations ./migrations
COPY --chown=app:app backend/alembic.ini ./alembic.ini

USER app
EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
