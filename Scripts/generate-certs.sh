#!/bin/bash
# Scripts/generate-certs.sh
# Generates self-signed certificates for the GoCD server
set -e

CERTS_DIR="./certs"
mkdir -p "$CERTS_DIR"

echo "Generating certificates in $CERTS_DIR..."

# 1. Generate CA Key and Certificate
openssl genrsa -out "$CERTS_DIR/ca.key" 2048
openssl req -x509 -new -nodes -key "$CERTS_DIR/ca.key" -sha256 -days 3650 \
    -out "$CERTS_DIR/ca.crt" \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=GoCD-CA"

# 2. Generate Server Key
openssl genrsa -out "$CERTS_DIR/server.key" 2048

# 3. Generate Certificate Signing Request (CSR)
openssl req -new -key "$CERTS_DIR/server.key" \
    -out "$CERTS_DIR/server.csr" \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

# 4. Sign the Server Certificate with the CA
openssl x509 -req -in "$CERTS_DIR/server.csr" \
    -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial \
    -out "$CERTS_DIR/server.crt" \
    -days 365 -sha256

echo "✅ Certificates generated successfully in $CERTS_DIR"