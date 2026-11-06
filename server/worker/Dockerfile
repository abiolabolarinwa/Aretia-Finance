# Image for the one-shot migration runner (and, in phase 2, the indexer worker). Build context is the repository root.
FROM node:24-bookworm-slim AS tools
WORKDIR /app
# Only the Postgres driver the runner needs; the version matches website/package.json.
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund pg@8.23.1
COPY website/scripts/apply-migrations.ts scripts/apply-migrations.ts
COPY website/src/swings/db/migrate.ts src/swings/db/migrate.ts
COPY website/supabase/migrations supabase/migrations
USER node
