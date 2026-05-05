#!/bin/bash
# Scripts/setup-base-image.sh
# Linux equivalent to setup-base-image.ps1
# Builds and pushes the SolVPN build base image to ghcr.io
set -e

echo "========================================================"
echo "SolVPN Build Base Image Setup (Linux)"
echo "========================================================"

# 1. Load Credentials
if [ ! -f ".env.docker" ]; then
    echo "❌ ERROR: .env.docker not found."
    exit 1
fi

GH_TOKEN=$(grep '^GITHUB_TOKEN=' .env.docker | cut -d '=' -f2- | tr -d '\r' | sed 's/^"//;s/"$//')
GH_USER=$(grep '^GIT_REPO_USERNAME=' .env.docker | cut -d '=' -f2- | tr -d '\r' | sed 's/^"//;s/"$//')

if [ -z "$GH_TOKEN" ] || [ -z "$GH_USER" ]; then
    echo "❌ ERROR: GITHUB_TOKEN or GIT_REPO_USERNAME missing in .env.docker"
    exit 1
fi

BASE_IMAGE_NAME="gocd-server-gocd-agent-3"
TARGET_IMAGE="ghcr.io/$GH_USER/solvpn-build-base:latest"

# 2. Login
echo "Logging into ghcr.io..."
echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin

# 3. Build
echo "Building base image from Dockerfile.agent.solvpn.base..."
docker build -t "$BASE_IMAGE_NAME" -f Dockerfile.agent.solvpn.base .

# 4. Tag and Push
echo "Pushing $TARGET_IMAGE..."
docker tag "$BASE_IMAGE_NAME" "$TARGET_IMAGE"
docker push "$TARGET_IMAGE"

echo "✅ SUCCESS: Base image is now available in GHCR."