#!/bin/bash
# Scripts/build_base_image.sh
# Builds and pushes the solvpn-build-base image to ghcr.io.
# This script is run by the solvpn-base-image GoCD pipeline.
# It only runs when Dockerfile.agent.solvpn.base changes.
set -e

echo "========================================================"
echo "Building SolVPN Base Image"
echo "========================================================"

IMAGE="ghcr.io/xmione/solvpn-build-base"
TAG="${GO_PIPELINE_COUNTER:-latest}"

echo "[BASE] Logging in to ghcr.io..."
echo "$GITHUB_TOKEN" | docker login ghcr.io -u xmione --password-stdin

echo "[BASE] Building image: $IMAGE:$TAG"
docker build \
    -t "$IMAGE:$TAG" \
    -t "$IMAGE:latest" \
    -f Dockerfile.agent.solvpn.base \
    .

echo "[BASE] Pushing image: $IMAGE:$TAG"
docker push "$IMAGE:$TAG"
docker push "$IMAGE:latest"

echo "[BASE] Base image published successfully."
echo "[BASE] $IMAGE:latest"
echo "========================================================"
echo "BASE IMAGE BUILD SUCCESSFUL"
echo "========================================================"