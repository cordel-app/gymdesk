FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace root files
COPY package*.json ./
COPY backend/package*.json ./backend/

RUN npm ci --workspace=backend

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src

RUN npm run build --workspace=backend

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY backend/package*.json ./backend/

RUN npm ci --workspace=backend --omit=dev

COPY --from=builder /app/backend/dist ./backend/dist

WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "dist/index.js"]
