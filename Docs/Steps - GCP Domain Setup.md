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

## Automated Setup (Recommended)

Instead of following the manual steps below, you can run everything automatically via
the gocd-server menu:

```
npm run menu → option 6.30 (Setup Load Balancer)
```

Or directly:
```bash
node Scripts/setup-load-balancer.js
```

This script is **idempotent** — it checks if each resource exists before creating it,
so you can safely re-run it. It creates: Instance Group, Health Checks, Backend Services,
Static IP, SSL Certificate, URL Map (routing rules), HTTPS Proxy, Forwarding Rules,
HTTP→HTTPS redirect, Firewall Rule, and DNS A records.

**Prerequisites:**
- Domain `humrine.com` must already be registered (Part 1 below)
- `gcloud` CLI must be authenticated with project access
- Required env vars: `GCP_PROJECT_ID`, `GCP_ZONE`, `GCP_VM_NAME`

After running the script, you still need to:
1. Wait for the SSL certificate to become ACTIVE (30–60 min after DNS propagates)
2. Update Django `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` (Part 6 below)
3. Update OAuth callback URLs (Part 6 below)

---

## Manual Steps (Reference)

The sections below document each step in detail for manual setup or debugging.

---

## Resource Inventory

All resource names used in this setup. Reference this table when recreating or debugging.

| Resource Type              | Name                             | Details                              |
|----------------------------|----------------------------------|--------------------------------------|
| **Domain**                 | `humrine.com`                    | Registered via Cloud Domains         |
| **Cloud DNS Zone**         | `humrine-com`                    | Auto-created with domain registration|
| **GCP Project**            | `project-39c0ea08-238b-47b5-915` | GoCD-App-Hosting                    |
| **VM Instance**            | `gocd-deploy-target`             | Region: `asia-southeast1-b`          |
| **Instance Group**         | `humrine-apps-group`             | Unmanaged, zone: `asia-southeast1-b` |
| **Named Port (staging)**   | `staging`                        | Port `8443`                          |
| **Named Port (production)**| `production`                     | Port `9443`                          |
| **Load Balancer**          | `humrine-main-lb`                | Global external Application LB       |
| **Frontend Rule**          | `humrine-https-frontend`         | HTTPS on port 443                    |
| **Static IP**              | `humrine-static-ip`              | Reserved global static IP            |
| **SSL Certificate**        | `humrine-managed-cert`           | Google-managed for `humrine.com`     |
| **Backend (staging)**      | `badminton-staging-backend`      | Routes to named port `staging:8443`  |
| **Backend (production)**   | `badminton-production-backend`   | Routes to named port `production:9443`|
| **Health Check (staging)** | `staging-health-check`           | HTTPS on port `8443`, path `/`       |
| **Health Check (production)**| `production-health-check`      | HTTPS on port `9443`, path `/`       |
| **Firewall Rule**          | `allow-lb-health-checks`         | TCP `8443`,`9443` from LB ranges    |

---

## Part 1: Domain Registration (Cloud Domains)

**Console:** Network Services → Cloud Domains
**URL:** https://console.cloud.google.com/net-services/domains/list

> **Already completed?** If you already registered `humrine.com`, skip to Part 2.

### Step 1.1: Search for a Domain
1. Click **Register Domain**.
2. In the search bar, type `humrine.com` and press Enter.
3. Select `humrine.com` from the results and click the **Add to cart** icon.

### Step 1.2: DNS Configuration
1. When asked "Select your DNS provider", select **"Use Cloud DNS"**.
   - This automatically creates a Cloud DNS Managed Zone named `humrine-com`.
   - Cost: ~$0.20/month for the DNS zone.
2. If prompted, accept the **Squarespace Terms of Service** (Squarespace is the registrar partner).

### Step 1.3: Privacy & Contact Info
1. **Privacy protection:** Select **"Private Contact Information"** (free).
   - This hides your personal details from the public WHOIS database.
2. **Contact information:** Fill in your real name, email, phone, and address.
   - Use an email you check regularly — domain verification depends on it.

### Step 1.4: Review & Register
1. Review the summary:
   - **Domain:** `humrine.com`
   - **Price:** ~$12/year
   - **Auto-renew:** Enabled by default (recommended)
2. Click **Register**.

### Step 1.5: Verify Your Email
**⚠️ CRITICAL:** Within a few minutes, you will receive a verification email at the address
you provided. **Click the verification link within 15 days.** If you don't verify, the
domain will be suspended and your apps will stop working.

---

## Part 2: Infrastructure Preparation

### Step 2.1: Create an Unmanaged Instance Group

**Console:** Compute Engine → Instance groups
**URL:** https://console.cloud.google.com/compute/instanceGroups/list

> **Already created?** If `humrine-apps-group` already exists in the list, skip to Step 2.2.

Your VM must be inside an Instance Group before the Load Balancer can route traffic to it.

1. Click **Create instance group**.
2. At the top of the page, you will see options like "New managed instance group" and
   "New unmanaged instance group". **Select "New unmanaged instance group"**.
   - Do NOT select "Managed" — that creates new VMs from a template.
     You already have a VM (`gocd-deploy-target`).
3. Fill in the form:

   | Field              | Value                     |
   |--------------------|---------------------------|
   | **Name**           | `humrine-apps-group`      |
   | **Description**    | (optional) `Instance group for humrine.com apps` |
   | **Region**         | `asia-southeast1`         |
   | **Zone**           | `asia-southeast1-b`       |
   | **Network**        | `default`                 |
   | **Subnetwork**     | Select the available subnetwork |
   | **VM instances**   | Select `gocd-deploy-target` from the dropdown |

4. Click **Create**.

### Step 2.2: Add Named Ports to the Instance Group

Named ports tell the Load Balancer which port number corresponds to which app.

1. In the Instance Groups list, click on `humrine-apps-group`.
2. Click **Edit** at the top.
3. Scroll down to **Port mapping** (or "Named ports").
4. Click **Add port** and add these two entries:

   | Port Name     | Port Number |
   |---------------|-------------|
   | `staging`     | `8443`      |
   | `production`  | `9443`      |

5. Click **Save**.

**gcloud CLI alternative:**
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

> **Starting over?** If a previous attempt failed (e.g., URL map validation error),
> the Load Balancer was NOT saved. You can start fresh from this section.
> Your static IP and SSL certificate from the previous attempt still exist and can be reused.

### Step 3.1: Start the Load Balancer Wizard

1. Click **Create Load Balancer**.
2. Under "Type of load balancer", select **Application Load Balancer (HTTP/S)**.
3. Click **Start Configuration**.
4. Select **From Internet to my VMs** (public-facing).
5. Select **Global external Application Load Balancer**.
6. Click **Continue**.
7. Fill in:

   | Field    | Value             |
   |----------|-------------------|
   | **Name** | `humrine-main-lb` |

### Step 3.2: Frontend Configuration

Click **Frontend configuration** in the left sidebar.

1. Click **Add Frontend IP and port** (or it may already show "New Frontend IP and port").
2. Fill in the form:

   | Field                       | Value / Action                              |
   |-----------------------------|---------------------------------------------|
   | **Name**                    | `humrine-https-frontend`                    |
   | **Description**             | (optional) `HTTPS entry point for humrine.com` |
   | **Protocol**                | Select **HTTPS (includes HTTP/2)**          |
   | **Port**                    | `443` (auto-filled when HTTPS is selected)  |
   | **IP address**              | Select `humrine-static-ip` from dropdown. If it doesn't exist, click **Create IP Address**, name it `humrine-static-ip`, and click **Reserve**. **Write down this IP — you'll need it for DNS.** |
   | **Certificate repository**  | Select **Use Classic Certificates**         |
   | **Certificate**             | Select `humrine-managed-cert` from dropdown. If it doesn't exist, click **Create a new certificate** (see Step 3.2a below). |
   | **Additional certificates** | (leave empty)                               |
   | **SSL policy**              | `GCP default`                               |
   | **HTTP/3 (QUIC) negotiation** | `Automatic (default)`                     |
   | **Early data (0-RTT)**      | `Disabled`                                  |
   | **Assign from IP Collection** | Leave **unchecked**                        |
   | **Enable HTTP to HTTPS redirect** | **✓ Check this box**                  |

3. Click **Done**.

#### Step 3.2a: Create SSL Certificate (only if `humrine-managed-cert` doesn't exist)

If you need to create the certificate:

1. Click **Create a new certificate**.
2. Fill in:

   | Field           | Value                                       |
   |-----------------|---------------------------------------------|
   | **Name**        | `humrine-managed-cert`                      |
   | **Description** | (optional) `Google-managed cert for humrine.com` |
   | **Create mode** | Select **Create Google-managed certificate** |
   | **Domains**     | `humrine.com`                               |

3. Click **Create**.
4. The certificate will show status **"Provisioning"** — this is normal. It will
   become "Active" after you point DNS to the Load Balancer IP (Part 4).

> **Note about wildcard certs:** The Console UI only supports single-domain managed certs.
> For a wildcard (`*.humrine.com`), you'd need the `gcloud` CLI:
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
> If this is too complex, you can create individual certs per subdomain — they're free.

### Step 3.3: Backend Configuration — Staging

Click **Backend configuration** in the left sidebar.

1. Click the **Backend services & backend buckets** dropdown.
2. Select **Create a backend service**.
3. Fill in the form:

   | Field              | Value / Action                          |
   |--------------------|-----------------------------------------|
   | **Name**           | `badminton-staging-backend`             |
   | **Description**    | (optional) `Staging app on port 8443`   |
   | **Backend type**   | `Instance group`                        |
   | **Protocol**       | `HTTPS`                                 |

4. In the **Backends** section:
   - Click **Add backend**.
   - **Instance group:** Select `humrine-apps-group (asia-southeast1-b)`.
   - **Port numbers:** Enter `8443`.
   - **Balancing mode:** `Utilization`
   - **Maximum backend utilization:** `80%`
   - **Maximum capacity:** `100%`

5. **Health check:** Click the dropdown → **Create a health check**.

   | Field              | Value                     |
   |--------------------|---------------------------|
   | **Name**           | `staging-health-check`    |
   | **Protocol**       | `HTTPS`                   |
   | **Port**           | `8443`                    |
   | **Request path**   | `/`                       |

   Click **Save** on the health check.

6. **Logging:** Toggle **Enable logging** to **ON**.
7. Click **Create** on the backend service.

### Step 3.4: Backend Configuration — Production

1. Click the **Backend services & backend buckets** dropdown again.
2. Select **Create a backend service**.
3. Fill in the form:

   | Field              | Value / Action                            |
   |--------------------|-------------------------------------------|
   | **Name**           | `badminton-production-backend`            |
   | **Description**    | (optional) `Production app on port 9443`  |
   | **Backend type**   | `Instance group`                          |
   | **Protocol**       | `HTTPS`                                   |

4. In the **Backends** section:
   - Click **Add backend**.
   - **Instance group:** Select `humrine-apps-group (asia-southeast1-b)`.
   - **Port numbers:** Enter `9443`.
   - **Balancing mode:** `Utilization`
   - **Maximum backend utilization:** `80%`
   - **Maximum capacity:** `100%`

5. **Health check:** Click the dropdown → **Create a health check**.

   | Field              | Value                        |
   |--------------------|------------------------------|
   | **Name**           | `production-health-check`    |
   | **Protocol**       | `HTTPS`                      |
   | **Port**           | `9443`                       |
   | **Request path**   | `/`                          |

   Click **Save** on the health check.

6. **Logging:** Toggle **Enable logging** to **ON**.
7. Click **Create** on the backend service.

### Step 3.5: Routing Rules (Host-Based)

Click **Routing rules** in the left sidebar.

1. Select **"Advanced host and path rule"** mode (not "Simple host and path rule").

2. **Set the default backend service:**
   - Select `badminton-production-backend` as the default.
   - This handles `humrine.com` and any unmatched hosts/paths.

3. **Add Host Rule #1 (Staging):**
   - Click **Add host and path rule**.
   - **Hosts:** Enter `staging.humrine.com`
   - Under the path matcher, set:
     - **Path:** `/*`
     - **Backend:** Select `badminton-staging-backend`

4. **Add Host Rule #2 (Production app):**
   - Click **Add host and path rule**.
   - **Hosts:** Enter `app.humrine.com`
   - Under the path matcher, set:
     - **Path:** `/*`
     - **Backend:** Select `badminton-production-backend`

**Summary of routing rules:**

| Host                      | Path  | Backend Service                |
|---------------------------|-------|--------------------------------|
| `staging.humrine.com`     | `/*`  | `badminton-staging-backend`    |
| `app.humrine.com`         | `/*`  | `badminton-production-backend` |
| (default — all others)    | `/*`  | `badminton-production-backend` |

### Step 3.6: Review and Create

1. Click **Review and finalize** in the left sidebar.
2. Verify the summary matches the resource inventory table at the top of this document.
3. Click **Create**.
4. Wait for the Load Balancer to be created (may take 1–2 minutes).
5. **Write down the Frontend IP address** shown on the Load Balancing page — you need
   it for the DNS step next.

---

## Part 4: DNS Configuration

**Console:** Network Services → Cloud DNS
**URL:** https://console.cloud.google.com/net-services/dns/zones

### Step 4.1: Get the Load Balancer Frontend IP

1. Go to **Network Services → Load Balancing**.
2. Click on `humrine-main-lb`.
3. Note the **Frontend IP address** (e.g., `34.120.x.x`). This is the `humrine-static-ip`
   you reserved.

### Step 4.2: Add DNS Records

1. Go to **Network Services → Cloud DNS**.
2. Click on your managed zone (`humrine-com`).
3. Click **Add Standard** to create each record:

**Record 1: Root domain**

| Field                | Value                    |
|----------------------|--------------------------|
| **DNS name**         | (leave blank — for `humrine.com` root) |
| **Resource record type** | `A`                  |
| **TTL**              | `300`                    |
| **IPv4 Address**     | `<your LB Frontend IP>`  |

Click **Create**.

**Record 2: Staging subdomain**

| Field                | Value                    |
|----------------------|--------------------------|
| **DNS name**         | `staging`                |
| **Resource record type** | `A`                  |
| **TTL**              | `300`                    |
| **IPv4 Address**     | `<your LB Frontend IP>` (same IP as above) |

Click **Create**.

**Record 3: App subdomain**

| Field                | Value                    |
|----------------------|--------------------------|
| **DNS name**         | `app`                    |
| **Resource record type** | `A`                  |
| **TTL**              | `300`                    |
| **IPv4 Address**     | `<your LB Frontend IP>` (same IP as above) |

Click **Create**.

> **Key insight:** All subdomains point to the **same Load Balancer IP**. The Load Balancer
> reads the `Host` header in each HTTP request to determine which backend to route to.

### Step 4.3: Wait for SSL Certificate Provisioning

After DNS records are configured, the Google-managed certificate will transition from
**"Provisioning"** to **"Active"**. This typically takes **30–60 minutes**.

Check status in the Console:
- Go to **Network Services → Load Balancing** → click `humrine-main-lb` → check certificate status.

Or via gcloud CLI:
```bash
gcloud compute ssl-certificates describe humrine-managed-cert \
  --project=project-39c0ea08-238b-47b5-915
```

---

## Part 5: Firewall Rules

**Console:** VPC Network → Firewall
**URL:** https://console.cloud.google.com/networking/firewalls/list

> **Why is this needed?** Google's Load Balancer sends health check probes from specific
> IP ranges. If these are blocked by the firewall, the LB thinks your app is down and
> returns 502 errors.

### Step 5.1: Create Firewall Rule for Health Checks

1. Click **Create Firewall Rule**.
2. Fill in:

   | Field                | Value                              |
   |----------------------|------------------------------------|
   | **Name**             | `allow-lb-health-checks`           |
   | **Description**      | (optional) `Allow GCP LB health check probes` |
   | **Network**          | `default`                          |
   | **Priority**         | `1000`                             |
   | **Direction**        | `Ingress`                          |
   | **Action on match**  | `Allow`                            |
   | **Targets**          | `Specified target tags`            |
   | **Target tags**      | `gocd-deploy-target`               |
   | **Source filter**     | `IPv4 ranges`                     |
   | **Source IP ranges**  | `35.191.0.0/16`, `130.211.0.0/22` |
   | **Protocols and ports** | Select **Specified protocols and ports** |
   | **TCP**              | `8443,9443`                        |

3. Click **Create**.

**gcloud CLI alternative:**
```bash
gcloud compute firewall-rules create allow-lb-health-checks \
  --project=project-39c0ea08-238b-47b5-915 \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:8443,tcp:9443 \
  --source-ranges=35.191.0.0/16,130.211.0.0/22 \
  --target-tags=gocd-deploy-target \
  --description="Allow GCP LB health check probes"
```

---

## Part 6: Application Configuration

After the Load Balancer and DNS are set up, update your app's configuration.

### Step 6.1: Update Django Environment Variables

Update these variables in your GitHub Variables (staging/production environments)
and in the corresponding `.env` files:

**For staging:**
```
APP_DOMAIN=staging.humrine.com
ALLOWED_HOSTS=localhost,127.0.0.1,staging.humrine.com,humrine.com,<VM_IP>
CSRF_TRUSTED_ORIGINS=https://staging.humrine.com,https://humrine.com
```

**For production:**
```
APP_DOMAIN=app.humrine.com
ALLOWED_HOSTS=localhost,127.0.0.1,app.humrine.com,humrine.com,<VM_IP>
CSRF_TRUSTED_ORIGINS=https://app.humrine.com,https://humrine.com
```

Then re-run the staging/production pipelines to deploy with the new settings.

### Step 6.2: Update OAuth Callback URLs

In each social provider's developer console, add the subdomain callback URLs:

**For staging (`staging.humrine.com`):**

| Provider   | Console URL | Callback URL |
|------------|-------------|--------------|
| **Google** | https://console.cloud.google.com/apis/credentials | `https://staging.humrine.com/accounts/google/login/callback/` |
| **Facebook** | https://developers.facebook.com | `https://staging.humrine.com/accounts/facebook/login/callback/` |
| **Twitter** | https://developer.twitter.com | `https://staging.humrine.com/accounts/twitter/login/callback/` |

**For production (`app.humrine.com`):**

| Provider   | Callback URL |
|------------|--------------|
| **Google** | `https://app.humrine.com/accounts/google/login/callback/` |
| **Facebook** | `https://app.humrine.com/accounts/facebook/login/callback/` |
| **Twitter** | `https://app.humrine.com/accounts/twitter/login/callback/` |

### Step 6.3: Update Django Site Domain

After deploying with the new `APP_DOMAIN`, run on the VM:
```bash
sudo docker exec badminton-staging-web-staging-1 python manage.py setup_site
```
This reads `APP_DOMAIN` from the container's environment and updates the Django `Site`
object, which `django-allauth` uses to build callback URLs.

---

## Cleanup: Remove Old Path-Based Resources

If you created any resources during the earlier path-based routing attempt, clean them up.

> **Do NOT delete:** `humrine-static-ip` and `humrine-managed-cert` — reuse them.

Check for leftover resources:
```bash
# List URL maps (the failed LB may not have been saved)
gcloud compute url-maps list \
  --project=project-39c0ea08-238b-47b5-915

# List backend services
gcloud compute backend-services list \
  --project=project-39c0ea08-238b-47b5-915

# List health checks
gcloud compute health-checks list \
  --project=project-39c0ea08-238b-47b5-915
```

Delete any orphaned resources from the failed attempt:
```bash
# Example: delete a leftover backend service
gcloud compute backend-services delete <name> \
  --global \
  --project=project-39c0ea08-238b-47b5-915 --quiet

# Example: delete a leftover health check
gcloud compute health-checks delete <name> \
  --project=project-39c0ea08-238b-47b5-915 --quiet
```

---

## Quick Reference: Adding a New App

To add a new application (e.g., `pay-sol` running on port `8444`) under `pay.humrine.com`:

| Step | What to Do | Where |
|------|-----------|-------|
| 1    | Add named port `pay-sol: 8444` to `humrine-apps-group` | Compute Engine → Instance groups |
| 2    | Create backend service `pay-sol-backend` (port `8444`, health check) | Load Balancing → Edit `humrine-main-lb` |
| 3    | Add host rule: `pay.humrine.com` → `pay-sol-backend` | Load Balancing → Routing rules |
| 4    | Add A record: `pay` → LB Frontend IP | Cloud DNS → `humrine-com` zone |
| 5    | Create/update SSL cert for `pay.humrine.com` | Load Balancing → Frontend (or use wildcard) |
| 6    | Add `pay.humrine.com` to `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` | GitHub Variables / `.env` files |
| 7    | Add OAuth callback URLs for `pay.humrine.com` | Provider developer consoles |

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| **502 Bad Gateway** | Health check failing, firewall blocking LB probes | Check firewall rule `allow-lb-health-checks` exists; verify health check port matches app port |
| **SSL cert stuck on "Provisioning"** | DNS not pointing to LB IP yet | Add/verify A record in Cloud DNS → must point to `humrine-static-ip` |
| **ERR_CONNECTION_REFUSED** | App not running on the expected port | SSH to VM and check `sudo docker ps` — verify the container is up on the right port |
| **URL map validation error** | Path rule conflict with default service | Use host-based (subdomain) routing instead of path-based routing |
| **OAuth "redirect_uri_mismatch"** | Callback URL at provider doesn't match actual domain | Update redirect URIs in provider console to use the subdomain |
