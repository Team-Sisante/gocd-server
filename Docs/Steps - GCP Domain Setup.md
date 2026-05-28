# GCP Architecture Reference: Path-Based Routing with Cloud Domains

This document outlines the step-by-step process for purchasing a domain in Google Cloud and setting up an **External Application Load Balancer** to host multiple applications under a single domain using path-based routing (e.g., `domain.com/app1`, `domain.com/app2`).

---

## Part 1: Domain Registration (Cloud Domains)
1.  **Search & Selection:** Use **Cloud Domains** to search for an available domain (e.g., `humrine.com`).
2.  **DNS Configuration:** Select **"Use Cloud DNS"**. This creates a managed zone automatically and allows seamless integration with the Load Balancer and SSL certificates.
3.  **Privacy Protection:** Enable **"Private Contact Information"** to redact your personal details from the public WHOIS database (included for free).
4.  **Verification:** **Crucial:** Once registered, check your email and click the verification link within 15 days to prevent domain suspension.

---

## Part 2: Infrastructure Preparation
Before creating the Load Balancer, you must group your existing VM(s) so the balancer can find them.

1.  **Identify App Ports:** Note the ports your apps use on the VM (e.g., Staging: `8443`, Production: `9443`).
2.  **Create an Unmanaged Instance Group:**
    *   Go to **Compute Engine > Instance Groups**.
    *   Select **New unmanaged instance group**.
    *   Select your **Region** and **Zone**.
    *   Select your existing **VM instance** (e.g., `gocd-deploy-target`).
3.  **Define Named Ports:**
    *   In the Instance Group settings, add **Named Ports** (e.g., `staging: 8443` and `production: 9443`). These "names" act as aliases that the Load Balancer uses to find the right port.

---

## Part 3: External Application Load Balancer Setup

### 1. Frontend Configuration (The "Entry Point")
*   **Protocol:** HTTPS (Port 443).
*   **IP Address:** Reserve a **Static External IP** (do not use Ephemeral).
*   **Certificate:** Select **Use Classic Certificates** -> **Create Google-managed certificate** for your domain.
*   **HTTP to HTTPS Redirect:** **Enabled**. (Forces all traffic to be secure).

### 2. Backend Configuration (The "App Connections")
Create a **Backend Service** for each unique application/port:
*   **Backend Type:** Instance Group.
*   **Protocol:** HTTP (or HTTPS if your app on the VM handles its own SSL).
*   **Named Port:** Select the name you created in the Instance Group (e.g., `production`).
*   **Health Check:** Create a mandatory HTTP health check for the specific port (e.g., 9443).
*   **Balancing Mode:** Utilization (80% Max, 100% Capacity, Per Instance).
*   **Logging:** **Enabled** (highly recommended for debugging).

### 3. Routing Rules (The "URL Map")
Use **Host and Path Rules** to define the URL structure:
*   **Host Rule:** `humrine.com`
*   **Default Service (Catch-all):** Set this to your primary Production backend.
*   **Path Rules:**
    *   `/staging/*` -> `badminton-staging-backend` (Port 8443)
    *   `/badminton_court/*` -> `badminton-production-backend` (Port 9443)
    *   `/pay-sol/*` -> (Appropriate Backend)

---

## Part 4: Final Steps to Go Live

### 1. Update Cloud DNS
Once the Load Balancer is created, copy its **Frontend IP Address**.
*   Go to **Network Services > Cloud DNS**.
*   In your Managed Zone, create an **A Record**.
*   Leave the DNS name blank (for the root) and paste the Load Balancer IP into the IPv4 field.

### 2. Configure VPC Firewall
Google's Load Balancer and Health Checkers must be allowed to talk to your VM.
*   Create a Firewall Rule allowing **Ingress**.
*   **Source IP Ranges:** `35.191.0.0/16` and `130.211.0.0/22`.
*   **Protocols/Ports:** TCP `8443`, `9443`, etc.

### 3. Wait for SSL Provisioning
It can take **30-60 minutes** for a Google-managed certificate to become active after the DNS A-record is created. The status will change from "Provisioning" to "Active" once Google verifies your DNS points to their IP.
