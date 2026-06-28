#!/usr/bin/env bash
set -e

NEON_PROJECT_ID="empty-scene-34709397"
BACKEND_ENV="apps/backoffice/backend/.env"
FRONTEND_ENV="apps/backoffice/frontend/.env"

echo ""
echo "── Gymdesk local setup ──────────────────────────"
echo ""

# ── 1. Clerk ─────────────────────────────────────────
echo "Step 1/3 — Clerk"

if ! command -v clerk &>/dev/null; then
  echo "  Installing Clerk CLI..."
  npm install -g clerk
fi

if ! clerk auth status &>/dev/null; then
  echo "  Please log in to Clerk:"
  clerk auth login
fi

echo "  Pulling Clerk keys → backend..."
cd apps/backoffice/backend
clerk env pull --file .env
cd ../../..

echo "  Pulling Clerk keys → frontend..."
cd apps/backoffice/frontend
clerk env pull --file .env
cd ../../..

# ── 2. Neon ──────────────────────────────────────────
echo ""
echo "Step 2/3 — Neon database"

if ! command -v neonctl &>/dev/null; then
  echo "  Installing Neon CLI..."
  npm install -g neonctl
fi

if ! neonctl me &>/dev/null 2>&1; then
  echo "  Please log in to Neon:"
  neonctl auth
fi

echo "  Fetching database connection string..."
DB_URL=$(neonctl connection-string \
  --project-id "$NEON_PROJECT_ID" \
  --database-name neondb \
  --role-name neondb_owner \
  --pooled \
  2>/dev/null)

# Write DATABASE_URL into backend .env (replace if exists, append if not)
if grep -q "^DATABASE_URL=" "$BACKEND_ENV" 2>/dev/null; then
  # Use a temp file to avoid sed delimiter conflicts with the URL
  grep -v "^DATABASE_URL=" "$BACKEND_ENV" > "$BACKEND_ENV.tmp"
  echo "DATABASE_URL=$DB_URL" >> "$BACKEND_ENV.tmp"
  mv "$BACKEND_ENV.tmp" "$BACKEND_ENV"
else
  echo "DATABASE_URL=$DB_URL" >> "$BACKEND_ENV"
fi

echo "  DATABASE_URL written to $BACKEND_ENV"

# ── 3. Static non-secret values ──────────────────────
echo ""
echo "Step 3/3 — Static config"

fill_if_missing() {
  local file="$1" key="$2" value="$3"
  if ! grep -q "^$key=" "$file" 2>/dev/null; then
    echo "$key=$value" >> "$file"
    echo "  Added $key to $file"
  fi
}

fill_if_missing "$BACKEND_ENV"  "PORT"          "3001"
fill_if_missing "$BACKEND_ENV"  "FRONTEND_URL"  "http://localhost:3000"

fill_if_missing "$FRONTEND_ENV" "NEXT_PUBLIC_BACKEND_URL"                    "http://localhost:3001"
fill_if_missing "$FRONTEND_ENV" "NEXT_PUBLIC_CLERK_SIGN_IN_URL"              "/en/sign-in"
fill_if_missing "$FRONTEND_ENV" "NEXT_PUBLIC_CLERK_SIGN_UP_URL"              "/en/sign-up"
fill_if_missing "$FRONTEND_ENV" "NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL" "/en"
fill_if_missing "$FRONTEND_ENV" "NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL" "/en"

echo ""
echo "── Done! ────────────────────────────────────────"
echo "  Run 'npm run dev:backend' and 'npm run dev:frontend' to start."
echo ""
