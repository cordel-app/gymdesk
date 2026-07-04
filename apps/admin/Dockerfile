FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY apps/admin/package*.json ./apps/admin/

RUN npm ci --workspace=apps/admin

COPY apps/admin ./apps/admin

# NEXT_PUBLIC_* are baked into the bundle at build time
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=/en/sign-in
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=/en/sign-up
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/en
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/en
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL \
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL

RUN npm run build --workspace=apps/admin

FROM node:20-alpine AS runner
WORKDIR /app
# Runtime env (set at podman run): CLERK_SECRET_KEY, BACKEND_URL
ENV NODE_ENV=production PORT=8081 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/admin/.next/standalone ./
COPY --from=builder /app/apps/admin/.next/static ./apps/admin/.next/static

EXPOSE 8081
CMD ["node", "apps/admin/server.js"]
