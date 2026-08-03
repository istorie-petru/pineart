# Multi-stage: the build stage carries the compilers Pillow and argon2-cffi need
# to build wheels; the runtime stage does not. That is the difference between a
# ~1GB image and a ~250MB one, and it removes a compiler toolchain from the
# thing that faces the network.
FROM python:3.12-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim AS runtime

# libwebp and libjpeg are runtime shared libraries Pillow links against; without
# them the image builds fine and then fails on the first thumbnail.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebp7 libjpeg62-turbo libtiff6 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home artboard

COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ARTBOARD_DATA_DIR=/data

WORKDIR /app
COPY --chown=artboard:artboard . .

USER artboard
EXPOSE 8000

# Migrations run at container start rather than in the image build: the database
# lives in a volume that does not exist at build time, and an upgrade should
# apply new migrations without a separate manual step.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
