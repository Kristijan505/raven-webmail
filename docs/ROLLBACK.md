# Rollback

## Goal

Roll back Raven quickly by pinning to a previously known-good image.

## Before every rollout

1. Save a snapshot:

```bash
./scripts/release-snapshot.sh redcode/raven-webmail:hardening-lts
```

2. Record the currently running image digest:

```bash
docker inspect --format='{{.Config.Image}}' wildduck-raven-webmail-1
```

## Rollback steps

1. Update `deploy/.env` and set:

```bash
RAVEN_IMAGE=<known-good-image-or-digest>
```

2. Restart Raven with pinned image:

```bash
cd deploy
docker compose -f docker-compose.raven.yml pull

docker compose -f docker-compose.raven.yml up -d --force-recreate
```

3. Validate rollback:

```bash
RAVEN_BASE_URL="http://127.0.0.1:8635" ./scripts/smoke.sh
```

## Notes

- Keep at least one prior image tag/digest available in your registry.
- If config changed in the failed rollout, restore previous `config.toml` together with image rollback.
