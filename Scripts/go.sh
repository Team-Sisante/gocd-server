#!/bin/bash
# Scripts/go.sh
# Linux/Cloud Shell equivalent to go.ps1
set -e

echo "Running Scripts/go.sh..."

# 0. Validation
if [ ! -f ".env.docker" ]; then
    echo "❌ ERROR: .env.docker not found. Please create it based on Docs/Steps - Github Token and Environment Variables.md"
    exit 1
fi

# 0.1 Registry Authentication
echo "Authenticating with GitHub Container Registry..."
GH_TOKEN=$(grep '^GITHUB_TOKEN=' .env.docker | cut -d '=' -f2- | tr -d '\r' | sed 's/^"//;s/"$//')
GH_USER=$(grep '^GIT_REPO_USERNAME=' .env.docker | cut -d '=' -f2- | tr -d '\r' | sed 's/^"//;s/"$//')

if [ -z "$GH_TOKEN" ] || [ -z "$GH_USER" ]; then
    echo "⚠️  WARNING: GITHUB_TOKEN or GIT_REPO_USERNAME not found in .env.docker. Registry pulls may fail."
else
    echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
fi

# 1. Generate Keystore
CERTS_DIR="./certs"
KEYSTORE_PATH="$CERTS_DIR/keystore.p12"

if [ ! -f "$CERTS_DIR/server.crt" ]; then
    echo "Certificates not found. Please run ./Scripts/generate-certs.sh first."
    exit 1
fi

echo "Generating PKCS12 keystore..."
openssl pkcs12 -export \
    -in "$CERTS_DIR/server.crt" \
    -inkey "$CERTS_DIR/server.key" \
    -out "$KEYSTORE_PATH" \
    -name gocd-server \
    -password pass:changeit

echo "✅ Keystore generated at $KEYSTORE_PATH"

# 2. Deep Clean
echo "Stopping and removing containers and volumes..."
docker compose down -v --remove-orphans

echo "Performing complete system cleanup..."
docker system prune -a --volumes -f

# 3. Build and Run
echo "Rebuilding the image from scratch..."
docker compose build --no-cache

echo "Starting the container with a clean state..."
docker compose up -d

# 4. Validation
echo "Waiting for GoCD server to be ready..."
until curl -s -o /dev/null -f http://localhost:8153/go/api/v1/health; do
    printf '.'
    sleep 5
done

echo -e "\n✅ SUCCESS: GoCD environment is up in Cloud Shell."