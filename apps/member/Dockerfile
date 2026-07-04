FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY apps/member/package*.json ./apps/member/

RUN npm ci --workspace=apps/member

COPY apps/member ./apps/member

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

RUN npm run build --workspace=apps/member

FROM node:20-alpine AS runner
WORKDIR /app
# Runtime env (set at podman run): CLERK_SECRET_KEY, BACKEND_URL
ENV NODE_ENV=production PORT=8082 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/member/.next/standalone ./
COPY --from=builder /app/apps/member/.next/static ./apps/member/.next/static

EXPOSE 8082
CMD ["node", "apps/member/server.js"]
