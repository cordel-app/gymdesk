FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY apps/admin/package*.json ./apps/admin/
# #1037 stage 4 — `@gymdesk/charts` is a workspace this app depends on, so its
# manifest has to be in place before `npm ci` and its source before the build.
COPY shared/charts/package*.json ./shared/charts/

RUN npm ci --workspace=apps/admin --workspace=shared/charts

COPY shared ./shared
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

# #1114: the browser title's two configurable parts — the environment label and
# the brand — composed with this app's own role by `src/lib/appTitle.ts`. Empty
# by default: a build whose environment did not set them reads `Admin` alone,
# which is accurate, rather than claiming a brand or an environment it is not in.
ARG NEXT_PUBLIC_APP_ENV_LABEL=
ARG NEXT_PUBLIC_APP_BRAND_NAME=
ENV NEXT_PUBLIC_APP_ENV_LABEL=$NEXT_PUBLIC_APP_ENV_LABEL \
    NEXT_PUBLIC_APP_BRAND_NAME=$NEXT_PUBLIC_APP_BRAND_NAME

RUN npm run build --workspace=apps/admin

FROM node:20-alpine AS runner
WORKDIR /app
# Runtime env (set at podman run): CLERK_SECRET_KEY, BACKEND_URL
ENV NODE_ENV=production PORT=8081 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/admin/.next/standalone ./
COPY --from=builder /app/apps/admin/.next/static ./apps/admin/.next/static

EXPOSE 8081
CMD ["node", "apps/admin/server.js"]
