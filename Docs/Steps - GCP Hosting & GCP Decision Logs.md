# GCP Hosting & GoCD Decision Log

## 1. Current State
- We run GoCD locally via Docker (docker-compose.yml) with agents that deploy apps as containers on the same host.
- Our pipelines (`pearl-hello-world`, `badminton_court`, `solvpn-deployment`) work, but the apps are only reachable on the local network (e.g., `http://<host-ip>:9292`).

## 2. Goal
- Make the deployed applications publicly accessible on the internet.
- Use a **free public IP** and reliable hosting solution.
- Enable future use of **Google AdSense** to monetize the apps (especially `badminton_court`).
- Ensure that Python web apps using **SQLite** (like `badminton_court`) do not suffer data loss.

## 3. Chosen Path: GCP Compute Engine (Always Free)
After evaluating free public IP options, we chose the **Google Cloud Platform (GCP) Always Free Tier** with a **Compute Engine e2-micro VM** as our hosting target.

### Why GCP Compute Engine?
1. **Static Public IP** – The VM gets a permanent, static public IP at no cost, making the apps reachable worldwide.
2. **Persistent Storage** – The always-free tier includes a 30 GB persistent disk. Unlike ephemeral serverless platforms, this disk survives restarts, so our SQLite databases are safe.
3. **Always Free** – The e2-micro instance (2 vCPU, 1 GB RAM) is free every month with no expiration, unlike AWS's 12-month limit.
4. **Google AdSense Compatible** – Hosting on GCP aligns naturally with AdSense policies. No policy conflicts.
5. **Full Control** – A traditional VM lets us install Docker, update the OS, and run any stack we want – just like our local setup.

## 4. How We Will Deploy to GCP
We will make our GoCD pipelines deploy the apps to the GCP Compute Engine VM.

### Plan:
- **Create a GCP VM** with the e2-micro machine type, 30 GB disk, and a static IP.
- **Install Docker** (and Docker Compose if needed) on the VM.
- **Register the VM as a GoCD agent** (or simply deploy via SSH/Docker commands from an existing agent).
- **Update our pipelines** so that the build/run steps target the GCP VM’s Docker socket instead of the local host. For example:
  - Use SSH tasks to run `docker run -d -p 80:9292 pearl-hello-world` on the VM.
  - Use Docker Compose on the VM for the `badminton_court` app.
- **Open firewall rules** on GCP to allow HTTP/HTTPS traffic to the VM.
- **(Optional) Set up a reverse proxy** (Nginx) on the VM for SSL and clean domains if we bring custom domains later.

## 5. AdSense Integration
- Once the apps are live on the VM and have meaningful content, we will apply for Google AdSense.
- We will add the AdSense ad code to the web app templates without modification.
- We will strictly follow the Google Publisher Policies (no click fraud, no prohibited content, no deceptive ad placement).

## 6. SQLite Data Safety
- Because we use Compute Engine, the SQLite file lives on the VM’s persistent disk. This means:
  - Database survives application restarts and container rebuilds.
  - No complex Litestream or volume mount workarounds needed.
- We will set up a simple backup script (e.g., cron job) to copy the SQLite file to Google Cloud Storage for additional safety.

## 7. What We Did NOT Choose
- We did **not** choose Oracle Cloud or AWS; GCP is our single cloud provider.
- We did **not** choose serverless options (Cloud Run, App Engine) because they require extra work for SQLite persistence and often fall outside the free tier.
- We are not moving the GoCD **server** itself to the cloud at this time; it can remain local, but the agents and deployment targets will shift to GCP.

## 8. Decision Summary
| Decision | Choice | Reason |
|----------|--------|--------|
| Public hosting platform | **GCP Compute Engine e2-micro** | Free forever, persistent disk, static IP, AdSense friendly |
| SQLite database persistence | **VM persistent disk** | No code changes, data survives restarts |
| Deployment method | **GoCD pipelines targeting GCP VM Docker socket** | Leverages existing pipeline logic |
| Monetization | **Google AdSense** | Aligns with GCP, straightforward approval process |

This document serves as the definitive record of our infrastructure decisions as of `2026-05-05`.