#!/bin/bash
set -e
exec > /var/log/startup-script.log 2>&1

echo "=== Startup script starting at $(date) ==="

# Wait up for any apt process to finish (GCP guest agent, auto-updates, etc.)
echo "Waiting for apt lock to be released..."
for i in $(seq 1 30); do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    echo "  apt is busy (attempt $i/30), waiting 10s..."
    sleep 10
  else
    echo "  apt lock is free."
    break
  fi
done

# Now safe to run apt
export DEBIAN_FRONTEND=noninteractive

# Force apt to use IPv4 – avoids network unreachable errors on some GCP zones
echo 'Acquire::ForceIPv4 "true";' | tee /etc/apt/apt.conf.d/99force-ipv4

# Update system
echo "Updating package lists..."
apt-get update
# Skip full upgrade to save time - only install what's needed
# apt-get upgrade -y  # REMOVED: Takes 10-15 minutes, not necessary for fresh VM
apt-get clean

# Install required packages
echo "Installing essential packages..."
apt-get install -y ca-certificates curl git gnupg lsb-release cloud-guest-utils

# Install Docker
echo "Installing Docker..."
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
echo "Docker installed."

# Configure Docker DNS (MTU is handled by docker-compose network)
echo "Configuring Docker DNS for reliable registry access on GCP..."
echo '{"dns":["8.8.8.8"]}' | sudo tee /etc/docker/daemon.json
echo "Docker daemon.json configured."

systemctl enable docker --now
echo "Docker started."

echo "Ensuring filesystem utilizes full 30GB disk..."
growpart /dev/sda 1 || echo "Partition already max size"
resize2fs /dev/sda1 || echo "Filesystem already max size"
df -h /

echo "Enabling 4GB swap space for stability..."
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "Swap space enabled."

# Install Node.js 18.x
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
echo "Node.js installed."

# Install gcloud CLI (optional)
echo "Installing gcloud CLI..."
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
apt-get update
apt-get install -y google-cloud-cli
echo "gcloud CLI installed."

# Create the SSH user (from VM_SSH_USER environment variable)
SSH_USER="xmione"
if ! id -u "$SSH_USER"; then
  useradd -m -s /bin/bash "$SSH_USER"
  echo "$SSH_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$SSH_USER
fi
usermod -aG docker "$SSH_USER"

# Set up the application directory
REPO_DIR="/opt/badminton_court"
mkdir -p "$REPO_DIR"
chown -R "$SSH_USER:$SSH_USER" "$REPO_DIR"

# Verify critical tools
echo ""
echo "=== Verifying installed tools ==="
for tool in git docker node npm gcloud; do
  if command -v $tool; then
    echo "  ✓ $tool is installed"
  else
    echo "  ✗ WARNING: $tool is MISSING"
  fi
done

echo "=== Startup script finished at $(date) ==="
