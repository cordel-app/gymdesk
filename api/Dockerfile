FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY api/package*.json ./api/

RUN npm ci --workspace=api

COPY api/tsconfig.json ./api/
COPY api/src ./api/src

RUN npm run build --workspace=api

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY api/package*.json ./api/

RUN npm ci --workspace=api --omit=dev

COPY --from=builder /app/api/dist ./api/dist

# Migrations run from this image on the VPS (DB is VCN-private; CI can't reach it)
COPY api/knexfile.cjs ./api/
COPY api/src/infra/migrations ./api/src/infra/migrations

WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
