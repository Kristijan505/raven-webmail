# Base image pinned by digest for reproducible builds: the :24-alpine3.23 tag is
# mutable and can silently change what "prod" is built from between rebuilds.
# Refresh with:  docker buildx imagetools inspect node:24-alpine3.23  (copy the
# top-level Digest) — keep both FROM lines in sync.
FROM node:24-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS build

WORKDIR /opt/raven

COPY package*.json ./
COPY app/package*.json ./app/

RUN npm ci
RUN npm ci --prefix app

COPY . .

RUN npm run build \
  && printf '{"type":"module"}\n' > app/build/package.json
RUN npm prune --omit=dev \
  && rm -rf app/node_modules

FROM node:24-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime

ENV NODE_ENV=production
WORKDIR /opt/raven

COPY --from=build /opt/raven/package*.json ./
COPY --from=build /opt/raven/raven.js ./
COPY --from=build /opt/raven/config.sample.toml ./
COPY --from=build /opt/raven/server/dist ./server/dist
COPY --from=build /opt/raven/app/build ./app/build
COPY --from=build /opt/raven/node_modules ./node_modules

RUN addgroup -S raven && adduser -S -G raven raven \
  && chown -R raven:raven /opt/raven

USER raven

EXPOSE 8635

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8635/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "raven.js", "start", "-c", "/config/config.toml"]
