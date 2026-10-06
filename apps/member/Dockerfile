FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY apps/member/package*.json ./apps/member/
# #1037 stage 4 — `@gymdesk/charts` is a workspace this app depends on, so its
# manifest has to be in place before `npm ci` and its source before the build.
COPY shared/charts/package*.json ./shared/charts/

RUN npm ci --workspace=apps/member --workspace=shared/charts

COPY shared ./shared
COPY apps/member ./apps/member

# NEXT_PUBLIC_* are baked into the bundle at build time
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=/en/sign-in
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=/en/sign-up
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/en
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/en
# #1073: the Google OAuth client ids the native sign-in button is initialised
# with. Empty by default, which is a build whose native button is not rendered at
# all rather than one that fails when tapped.
ARG NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID=
ARG NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID=
ENV NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID \
    NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL \
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL

# #1114: the browser title's two configurable parts — the environment label and
# the brand — composed with this app's own role by `src/lib/appTitle.ts`. Empty
# by default: a build whose environment did not set them reads `Members` alone,
# which is accurate, rather than claiming a brand or an environment it is not in.
ARG NEXT_PUBLIC_APP_ENV_LABEL=
ARG NEXT_PUBLIC_APP_BRAND_NAME=
ENV NEXT_PUBLIC_APP_ENV_LABEL=$NEXT_PUBLIC_APP_ENV_LABEL \
    NEXT_PUBLIC_APP_BRAND_NAME=$NEXT_PUBLIC_APP_BRAND_NAME

RUN npm run build --workspace=apps/member

FROM node:20-alpine AS runner
WORKDIR /app
# Runtime env (set at podman run): CLERK_SECRET_KEY, BACKEND_URL
ENV NODE_ENV=production PORT=8082 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/member/.next/standalone ./
COPY --from=builder /app/apps/member/.next/static ./apps/member/.next/static
# #1073: `next build` does not fold `public/` into the standalone output, so the
# manifest and the app icons the layout links to 404 without this line — which is
# what they did before the directory existed at all.
COPY --from=builder /app/apps/member/public ./apps/member/public

EXPOSE 8082
CMD ["node", "apps/member/server.js"]
