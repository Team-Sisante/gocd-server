#!/bin/sh
# Scripts/agent-entrypoint.sh
set -e

# Fix Docker socket permissions if mounted
if [ -S /var/run/docker.sock ]; then
    echo "Fixing permissions for /var/run/docker.sock..."
    chmod 666 /var/run/docker.sock
fi

# Set the CA certificate path and merge with system certs
SYSTEM_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"

if [ -f /usr/local/share/ca-certificates/ca.crt ]; then
    echo "Updating system CA certificates with mounted ca.crt..."
    cp /usr/local/share/ca-certificates/ca.crt /usr/local/share/ca-certificates/internal-ca.crt
    update-ca-certificates
fi

# Configure gcloud for the 'go' user
if [ -n "$GCP_PROJECT_ID" ]; then
    if gosu go command -v gcloud >/dev/null 2>&1; then
        echo "Configuring gcloud for project: $GCP_PROJECT_ID"
        gosu go bash -c "gcloud config set project \"$GCP_PROJECT_ID\" --quiet && \
                         gcloud config set core/custom_ca_certs_file \"$SYSTEM_CERT_FILE\" --quiet && \
                         gcloud config set core/disable_usage_reporting true --quiet"
    else
        echo "Skipping gcloud configuration: gcloud command not found."
    fi
fi

if [ -f "/secret/gcp-key.json" ]; then
    echo "Activating GCP service account..."
    gosu go gcloud auth activate-service-account --key-file=/secret/gcp-key.json --quiet || echo "Warning: Failed to activate service account."
fi

# Pre-generate SSH keys for the 'go' user to avoid interactive prompts
if [ ! -f "/home/go/.ssh/google_compute_engine" ]; then
    echo "Pre-generating SSH keys for 'go' user..."
    gosu go mkdir -p /home/go/.ssh
    gosu go ssh-keygen -t rsa -f /home/go/.ssh/google_compute_engine -N "" -q
    echo "SSH keys generated."
fi

# Ensure agent registers with a unique hostname
export AGENT_AUTO_REGISTER_HOSTNAME="${AGENT_AUTO_REGISTER_HOSTNAME:-agent-$(hostname)}"

# Java-specific trust store (GoCD internal communication)
JAVA_HOME="/gocd-agent-java"
KEYTOOL="$JAVA_HOME/bin/keytool"
CACERTS="$JAVA_HOME/lib/security/cacerts"

if [ -f /usr/local/share/ca-certificates/ca.crt ] && [ -f "$KEYTOOL" ] && ! $KEYTOOL -list -alias gocd-ca -keystore $CACERTS -storepass changeit -noprompt > /dev/null 2>&1; then
    echo "Importing CA certificate into Java trust store..."
    $KEYTOOL -importcert -noprompt -trustcacerts -alias gocd-ca -file /usr/local/share/ca-certificates/ca.crt -keystore $CACERTS -storepass changeit
fi

export JAVA_OPTS="-Djavax.net.ssl.trustStore=$CACERTS -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=JKS"

# --- WAIT FOR SERVER BLOCK ---
echo "Waiting for GoCD server at ${GO_SERVER_URL} to be ready..."
SERVER_IP=$(getent hosts gocd-server | awk '{print $1}')
if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(ip route | awk '/default/ { print $3}')
fi
SERVER_URL="http://${SERVER_IP}:8153"

until curl -k -f -s "$SERVER_URL/go/api/v1/health" > /dev/null; do
    echo "Waiting for GoCD server..."
    sleep 5
done
echo "GoCD server is ready!"

# Hand off to the stock GoCD agent entrypoint
echo "Starting GoCD agent as user 'go'..."
exec gosu go /docker-entrypoint.sh "$@"
