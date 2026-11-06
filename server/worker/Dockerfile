# Images for the one-shot migration runner (target `tools`) and the indexer worker (target `worker`). Build context is the repository root.
FROM node:24-bookworm-slim AS tools
WORKDIR /app
# Only the Postgres driver the runner needs; the version matches website/package.json.
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund pg@8.23.1
COPY website/scripts/apply-migrations.ts scripts/apply-migrations.ts
COPY website/src/swings/db/migrate.ts src/swings/db/migrate.ts
COPY website/supabase/migrations supabase/migrations
USER node

# The worker: the repo's own TypeScript bundled into one file (esbuild), run with plain node. No node_modules at run time.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm init -y >/dev/null && npm install --no-audit --no-fund esbuild@0.28.2
COPY website/src website/src
RUN npx esbuild website/src/swings/mi/worker/main.ts --bundle --platform=node --format=esm --target=node24 --outfile=/out/worker.mjs

FROM node:24-bookworm-slim AS worker
WORKDIR /app
COPY --from=build /out/worker.mjs worker.mjs
USER node
CMD ["node", "worker.mjs"]
