# GCP Architecture Reference: Path-Based Routing with Cloud Domains

This document outlines the step-by-step process for purchasing a domain in Google Cloud and setting up an **External Application Load Balancer** for path-based routing.

---

## Part 1: Domain Registration
*   **Console Location:** `Network Services > Cloud Domains`
*   **URL:** `https://console.cloud.google.com/net-services/domains/list`

1.  **Search & Selection:** Search for your domain (e.g., `humrine.com`).
2.  **DNS Configuration:** Select **"Use Cloud DNS"**. This creates a managed zone automatically.
3.  **Privacy Protection:** Enable **"Private Contact Information"** (Free).
4.  **Verification:** **Crucial:** Click the verification link sent to your registrant email within 15 days.

---

## Part 2: Infrastructure Preparation
*   **Console Location:** `Compute Engine > Instance groups`
*   **URL:** `https://console.cloud.google.com/compute/instanceGroups/list`

1.  **Create Unmanaged Instance Group:**
    *   Select **New unmanaged instance group**.
    *   Select your existing **VM instance** (e.g., `gocd-deploy-target`).
2.  **Define Named Ports:**
    *   Edit the group and add **Named Ports** (e.g., `staging: 8443` and `production: 9443`). These aliases allow the Load Balancer to find the right backend port.

---

## Part 3: External Application Load Balancer Setup
*   **Console Location:** `Network Services > Load balancing`
*   **URL:** `https://console.cloud.google.com/net-services/loadbalancing/list`

### 1. Frontend Configuration (Standard HTTPS Entry)
*   **Protocol:** HTTPS (Port 443).
*   **IP Address:** Select **Reserve a Static External IP**.
*   **Certificate:** Select **Use Classic Certificates** -> **Create Google-managed certificate** for `domain.com`.
*   **HTTP to HTTPS Redirect:** **Enabled**.

### 2. Backend Configuration (App Links)
Create a **Backend Service** for each unique port (Staging/Production):
*   **Named Port:** Match the alias created in Part 2 (e.g., `production`).
*   **Health Check:** Create a mandatory HTTP check for the specific app port.
*   **Balancing Mode:** Utilization (80% Max, 100% Capacity, Per Instance).
*   **Logging:** **Enabled**.

### 3. Routing Rules (The URL Map)
*   **Default Service:** Set to your primary Production backend.
*   **Path Rules (Longest Prefix Match):**
    *   `/staging/*` -> `badminton-staging-backend`
    *   `/badminton_court/*` -> `badminton-production-backend`

---

## Part 4: Final Steps to Go Live

### 1. Update Cloud DNS
*   **Console Location:** `Network Services > Cloud DNS`
*   **URL:** `https://console.cloud.google.com/net-services/dns/zones`
1.  Copy the Load Balancer's **Frontend IP Address**.
2.  In your Managed Zone, create an **A Record** pointing the root domain to this IP.

### 2. Configure VPC Firewall
*   **Console Location:** `VPC network > Firewall`
*   **URL:** `https://console.cloud.google.com/networking/firewalls/list`
1.  Allow Ingress from Source IP Ranges: `35.191.0.0/16` and `130.211.0.0/22`.
2.  Allow Protocols/Ports: TCP `8443`, `9443`.
