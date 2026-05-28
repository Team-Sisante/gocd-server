# GCP Domain Setup: Subdomain-Based Routing with Cloud Domains

This document outlines the step-by-step process for purchasing a domain in Google Cloud
and setting up an **External Application Load Balancer** to host multiple applications
under **subdomains** (e.g., `staging.humrine.com`, `app.humrine.com`).

## Why Subdomains Instead of Paths?

| | Path-based (`humrine.com/staging`) | Subdomain-based (`staging.humrine.com`) |
|---|---|---|
| Django changes | Requires `FORCE_SCRIPT_NAME`, URL rewrite rules | **None** — each app sees `/` as root |
| SSL certificate | One cert for `humrine.com` | One wildcard cert for `*.humrine.com` |
| App isolation | Apps share a cookie domain | Each subdomain gets its own cookies |
| OAuth callbacks | Must include path prefix in redirect URIs | Standard `/accounts/google/login/callback/` |
| Complexity | High — path stripping, static files, etc. | **Low** — standard reverse proxy |

---

## Part 1: Domain Registration (Cloud Domains)

**Console:** Network Services → Cloud Domains
**URL:** https://console.cloud.google.com/net-services/domains/list

1. Click **Register Domain** and search for your domain (e.g., `humrine.com`).
2. Accept the **Squarespace Terms of Service** if prompted.
3. **DNS Configuration:** Select **"Use Cloud DNS"**.
   - This automatically creates a Cloud DNS Managed Zone for `humrine.com`.
   - Cost: ~$0.20/month for the DNS zone.
4. **Privacy Protection:** Select **"Private Contact Information"** (free, hides WHOIS data).
5. **Contact Information:** Enter your real name, email, phone, and address.
   - Use an email you check regularly — verification depends on it.
6. **Review & Register:** Confirm the annual price (~$12/year for `.com`) and click **Register**.
7. **⚠️ CRITICAL:** Check your email and click the **verification link within 15 days**.
   Failure to verify will suspend the domain.

---

## Part 2: Infrastructure Preparation

### 2.1 Create an Unmanaged Instance Group

**Console:** Compute Engine → Instance groups
**URL:** https://console.cloud.google.com/compute/instanceGroups/list

Your VM must be in an Instance Group for the Load Balancer to route traffic to it.

1. Click **Create instance group**.
2. Select **New unmanaged instance group** (not Managed — you already have a VM).
3. Fill in:
   - **Name:** `humrine-apps-group`
   - **Region:** Your VM's region (e.g., `asia-southeast1`)
   - **Zone:** Your VM's zone (e.g., `asia-southeast1-b`)
   - **Network:** `default` (or whichever VPC your VM uses)
   - **Subnetwork:** Select the subnetwork
   - **VM instances:** Select `gocd-deploy-target`
4. Click **Create**.

### 2.2 Add Named Ports to the Instance Group

After creation, edit the Instance Group to add named ports:

| Port Name     | Port Number | Purpose                        |
|---------------|-------------|--------------------------------|
| `staging`     | `8443`      | Badminton Court staging app    |
| `production`  | `9443`      | Badminton Court production app |

These port aliases let the Load Balancer route to different apps on the same VM.

**Via gcloud CLI (alternative):**
```bash
gcloud compute instance-groups unmanaged set-named-ports humrine-apps-group \
  --named-ports=staging:8443,production:9443 \
  --zone=asia-southeast1-b \
  --project=project-39c0ea08-238b-47b5-915
```

---

## Part 3: External Application Load Balancer Setup

**Console:** Network Services → Load balancing
**URL:** https://console.cloud.google.com/net-services/loadbalancing/list

1. Click **Create Load Balancer**.
2. Select **Application Load Balancer (HTTP/S)** → Start Configuration.
3. Select **From Internet to my VMs** → **Global external Application Load Balancer**.
4. **Name:** `humrine-main-lb`

### 3.1 Frontend Configuration

This is the public entry point for all traffic.

| Setting                    | Value                                          |
|----------------------------|-------------------------------------------------|
| **Name**                   | `humrine-https-frontend`                        |
| **Protocol**               | HTTPS (includes HTTP/2)                         |
| **IP Address**             | Create new static IP → name: `humrine-static-ip` |
| **Certificate repository** | Use Classic Certificates                        |
| **Certificate**            | Create new → Google-managed certificate         |
| **Certificate domains**    | `humrine.com`, `*.humrine.com`                  |
| **HTTP to HTTPS redirect** | ✓ Enabled                                       |

**Leave as defaults:**
- Additional certificates: (none)
- SSL policy: GCP default
- HTTP/3 (QUIC) negotiation: Automatic
- Early data (0-RTT): Disabled
- Assign from IP Collection: Unchecked

> **Note:** The certificate status will show "Provisioning" until you point DNS to the
> Load Balancer IP (Part 4). This is normal — it takes 30–60 minutes after DNS is configured.

> **Important:** For wildcard certificates (`*.humrine.com`), Google-managed certs require
> DNS authorization. You may need to use `gcloud` to create the cert with DNS authorization:
> ```bash
> gcloud certificate-manager dns-authorizations create humrine-dns-auth \
>   --domain="humrine.com" \
>   --project=project-39c0ea08-238b-47b5-915
>
> gcloud certificate-manager certificates create humrine-wildcard-cert \
>   --domains="humrine.com,*.humrine.com" \
>   --dns-authorizations=humrine-dns-auth \
>   --project=project-39c0ea08-238b-47b5-915
> ```
> Then add the CNAME record shown in the output to your Cloud DNS zone.
> If the wildcard cert is too complex, you can create individual certs for each subdomain
> (e.g., `staging.humrine.com`, `app.humrine.com`) — Google-managed certs are free.

### 3.2 Backend Configuration

Create a **separate Backend Service** for each application/environment:

#### Backend Service: `badminton-staging-backend`

| Setting           | Value                           |
|-------------------|---------------------------------|
| **Name**          | `badminton-staging-backend`     |
| **Backend type**  | Instance group                  |
| **Protocol**      | HTTPS                           |
| **Instance group**| `humrine-apps-group`            |
| **Named port**    | `staging` (port 8443)           |
| **Balancing mode**| Utilization                     |
| **Max utilization**| 80%                            |
| **Max capacity**  | 100%                            |
| **Logging**       | Enabled                         |

**Health Check:** Create → `staging-health-check`
- Protocol: HTTPS
- Port: 8443
- Request path: `/`

#### Backend Service: `badminton-production-backend`

| Setting           | Value                            |
|-------------------|----------------------------------|
| **Name**          | `badminton-production-backend`   |
| **Backend type**  | Instance group                   |
| **Protocol**      | HTTPS                            |
| **Instance group**| `humrine-apps-group`             |
| **Named port**    | `production` (port 9443)         |
| **Balancing mode**| Utilization                      |
| **Max utilization**| 80%                             |
| **Max capacity**  | 100%                             |
| **Logging**       | Enabled                          |

**Health Check:** Create → `production-health-check`
- Protocol: HTTPS
- Port: 9443
- Request path: `/`

### 3.3 Routing Rules (Host-Based)

Select **"Advanced host and path rule"** mode.

With subdomain routing, each subdomain maps to a different backend service:

| Host                      | Path  | Backend Service                |
|---------------------------|-------|--------------------------------|
| `staging.humrine.com`     | `/*`  | `badminton-staging-backend`    |
| `app.humrine.com`         | `/*`  | `badminton-production-backend` |
| `humrine.com` (default)   | `/*`  | `badminton-production-backend` |

**How to configure in the Console:**

1. **Default service:** Select `badminton-production-backend`
   (handles `humrine.com` and any unmatched hosts)
2. **Add Host Rule #1:**
   - Hosts: `staging.humrine.com`
   - Path matcher → Path: `/*` → Backend: `badminton-staging-backend`
3. **Add Host Rule #2:**
   - Hosts: `app.humrine.com`
   - Path matcher → Path: `/*` → Backend: `badminton-production-backend`

> **Adding more apps later:** To add `pay-sol` or `solvpn`, create new backend services
> with their named ports, then add host rules:
> - `pay.humrine.com` → `pay-sol-backend`
> - `vpn.humrine.com` → `solvpn-backend`

Click **Create** to finalize the Load Balancer.

---

## Part 4: DNS Configuration

**Console:** Network Services → Cloud DNS
**URL:** https://console.cloud.google.com/net-services/dns/zones

### 4.1 Get the Load Balancer IP

After creation, the Load Balancer's Frontend IP is shown on the Load Balancing page.
Note this IP (e.g., `34.120.x.x`).

### 4.2 Create DNS Records

Open your Cloud DNS managed zone for `humrine.com` and add these records:

| Type | DNS Name             | TTL | Value (IPv4)        |
|------|----------------------|-----|---------------------|
| A    | `humrine.com`        | 300 | `<LB Frontend IP>`  |
| A    | `staging.humrine.com`| 300 | `<LB Frontend IP>`  |
| A    | `app.humrine.com`    | 300 | `<LB Frontend IP>`  |

All subdomains point to the **same Load Balancer IP** — the LB handles routing
based on the `Host` header.

> **Adding more subdomains later:** Just add another A record pointing to the same IP,
> and add the corresponding host rule in the Load Balancer.

### 4.3 Wait for SSL Certificate Provisioning

After DNS is configured, the Google-managed SSL certificate will transition from
"Provisioning" to "Active". This typically takes **30–60 minutes**.

Check status:
```bash
gcloud compute ssl-certificates describe humrine-managed-cert \
  --project=project-39c0ea08-238b-47b5-915
```

---

## Part 5: Firewall Rules

**Console:** VPC Network → Firewall
**URL:** https://console.cloud.google.com/networking/firewalls/list

Google's Load Balancer health checkers must be allowed to reach your VM.

Create a firewall rule:

| Setting              | Value                                    |
|----------------------|------------------------------------------|
| **Name**             | `allow-lb-health-checks`                 |
| **Direction**        | Ingress                                  |
| **Source IP ranges**  | `35.191.0.0/16`, `130.211.0.0/22`       |
| **Protocols/Ports**  | TCP: `8443`, `9443`                      |
| **Target tags**      | `gocd-deploy-target`                     |

**Via gcloud CLI:**
```bash
gcloud compute firewall-rules create allow-lb-health-checks \
  --project=project-39c0ea08-238b-47b5-915 \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:8443,tcp:9443 \
  --source-ranges=35.191.0.0/16,130.211.0.0/22 \
  --target-tags=gocd-deploy-target
```

---

## Part 6: Application Configuration

### 6.1 Update Django Settings

Update your environment variables so Django accepts requests from the new subdomains:

```
ALLOWED_HOSTS=localhost,127.0.0.1,staging.humrine.com,app.humrine.com,humrine.com,<VM_IP>
CSRF_TRUSTED_ORIGINS=https://staging.humrine.com,https://app.humrine.com,https://humrine.com
APP_DOMAIN=staging.humrine.com   # (or app.humrine.com for production)
```

### 6.2 Update OAuth Callback URLs

In each social provider's developer console, add the new subdomain callback URLs:

- **Google:** `https://staging.humrine.com/accounts/google/login/callback/`
- **Facebook:** `https://staging.humrine.com/accounts/facebook/login/callback/`
- **Twitter:** `https://staging.humrine.com/accounts/twitter/login/callback/`

(Repeat for `app.humrine.com` for production.)

### 6.3 Update Django Site Domain

Run on the VM (or via the staging pipeline):
```bash
python manage.py setup_site
```
This reads `APP_DOMAIN` from the environment and updates the Django `Site` object.

---

## Cleanup: Remove Old Path-Based Resources

If you created any resources during the path-based routing attempt, clean them up:

```bash
# Delete the failed URL map (if it exists)
gcloud compute url-maps delete humrine-main-lb \
  --project=project-39c0ea08-238b-47b5-915 --quiet 2>/dev/null

# List and review any leftover backend services
gcloud compute backend-services list \
  --project=project-39c0ea08-238b-47b5-915
```

> **Note:** The static IP (`humrine-static-ip`) and SSL certificate (`humrine-managed-cert`)
> can be reused — do NOT delete them.

---

## Quick Reference: Adding a New App

To add a new application (e.g., `pay-sol`) under `pay.humrine.com`:

1. **Named Port:** Add `pay-sol: <port>` to the Instance Group
2. **Backend Service:** Create `pay-sol-backend` pointing to the named port
3. **Health Check:** Create for the new port
4. **Host Rule:** Add `pay.humrine.com` → `pay-sol-backend` in the Load Balancer
5. **DNS:** Add an A record for `pay.humrine.com` → Load Balancer IP
6. **SSL:** If not using a wildcard cert, create a new Google-managed cert for `pay.humrine.com`
7. **Django:** Add `pay.humrine.com` to `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS`
