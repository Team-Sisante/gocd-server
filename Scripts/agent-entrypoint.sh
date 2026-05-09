#!/bin/sh
# Scripts/agent-entrypoint.sh
set -e

# Ensure agent registers with a unique hostname (supports scaling)
export AGENT_AUTO_REGISTER_HOSTNAME="${AGENT_AUTO_REGISTER_HOSTNAME:-agent-$(hostname)}"

# Set the CA certificate path directly without using update-ca-certificates
if [ -f /usr/local/share/ca-certificates/ca.crt ]; then
    # Use the mounted CA certificate directly
    export SSL_CERT_FILE=/usr/local/share/ca-certificates/ca.crt
    export CURL_CA_BUNDLE=/usr/local/share/ca-certificates/ca.crt
    echo "Using mounted CA certificate: $SSL_CERT_FILE"
else
    # Fallback to system certificates
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
    export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    echo "Using system CA certificate: $SSL_CERT_FILE"
fi

# Use the known Java location in GoCD agent container
JAVA_HOME="/gocd-agent-java"
KEYTOOL="$JAVA_HOME/bin/keytool"
CACERTS="$JAVA_HOME/lib/security/cacerts"

# Import the CA certificate into Java's trust store if not already imported
if [ -f /usr/local/share/ca-certificates/ca.crt ] && [ -f "$KEYTOOL" ] && ! $KEYTOOL -list -alias gocd-ca -keystore $CACERTS -storepass changeit -noprompt > /dev/null 2>&1; then
    echo "Importing CA certificate into Java trust store..."
    $KEYTOOL -importcert -noprompt -trustcacerts -alias gocd-ca -file /usr/local/share/ca-certificates/ca.crt -keystore $CACERTS -storepass changeit
fi

# Set Java to use the system trust store
export JAVA_OPTS="-Djavax.net.ssl.trustStore=$CACERTS -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=JKS"

# --- WAIT FOR SERVER BLOCK ---
echo "Waiting for GoCD server at ${GO_SERVER_URL} to be ready..."

# Get the IP address of the gocd-server container
SERVER_IP=$(getent hosts gocd-server | awk '{print $1}')
if [ -z "$SERVER_IP" ]; then
    echo "Could not resolve gocd-server hostname, using default network gateway"
    SERVER_IP=$(ip route | awk '/default/ { print $3}')
fi

# Use the IP address directly for the health check
SERVER_URL="http://${SERVER_IP}:8153"
echo "Using server IP: $SERVER_URL"

MAX_RETRIES=30
RETRY_INTERVAL=10

for i in $(seq 1 $MAX_RETRIES); do
    if curl -f -s "$SERVER_URL/go/api/v1/health" > /dev/null; then
        echo "GoCD server is ready!"
        break
    else
        echo "Attempt $i/$MAX_RETRIES: GoCD server not ready, waiting ${RETRY_INTERVAL}s..."
        sleep $RETRY_INTERVAL
    fi
    
    if [ $i -eq $MAX_RETRIES ]; then
        echo "ERROR: GoCD server did not become ready after $MAX_RETRIES attempts."
        exit 1
    fi
done
# --- END OF WAIT FOR SERVER BLOCK ---

# Hand off to the stock GoCD agent entrypoint
echo "Starting GoCD agent..."
exec /docker-entrypoint.sh "$@"