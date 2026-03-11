# Operations

## 1) Build and run (standalone)

```bash
cd deploy
cp .env.example .env
cp config.toml.example config.toml
# edit config.toml values before first start

docker compose -f docker-compose.raven.yml build

docker compose -f docker-compose.raven.yml up -d
```

## 2) Smoke check

Unauthenticated:

```bash
RAVEN_BASE_URL="http://127.0.0.1:8635" ./scripts/smoke.sh
```

Authenticated (recommended):

```bash
RAVEN_BASE_URL="https://webmail.example.com" \
RAVEN_SMOKE_USER="admin@example.com" \
RAVEN_SMOKE_PASS="your-password" \
./scripts/smoke.sh
```

## 3) Security scan (container image)

```bash
./scripts/scan-trivy.sh redcode/raven-webmail:hardening-lts
```

## 4) Capture rollback snapshot before rollout

```bash
./scripts/release-snapshot.sh redcode/raven-webmail:hardening-lts
```

The command writes a timestamped file into `release-snapshots/`.
