FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY apps/backoffice/backend/package*.json ./apps/backoffice/backend/

RUN npm ci --workspace=apps/backoffice/backend

COPY apps/backoffice/backend/tsconfig.json ./apps/backoffice/backend/
COPY apps/backoffice/backend/src ./apps/backoffice/backend/src

RUN npm run build --workspace=apps/backoffice/backend

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY apps/backoffice/backend/package*.json ./apps/backoffice/backend/

RUN npm ci --workspace=apps/backoffice/backend --omit=dev

COPY --from=builder /app/apps/backoffice/backend/dist ./apps/backoffice/backend/dist

WORKDIR /app/apps/backoffice/backend
EXPOSE 3001
CMD ["node", "dist/index.js"]
