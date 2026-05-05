# GCP Deployment Steps

This document outlines the steps for deploying GoCD pipelines to a GCP Compute Engine VM (e2-micro).

---

## Prerequisites

- GCP Project with Compute Engine API enabled.
- e2-micro VM created with a **Static External IP**.
- Firewalls configured for ports `80`, `443`, and application ports (e.g., `9292`).
- GoCD agent with `google-cloud-sdk` installed.
- Service Account with `Compute Instance Admin` permissions.

> [!TIP]
> **Finding your Project ID:** You can find your Project ID in the GCP Console Dashboard under "Project info" or by running `gcloud config get-value project` in your terminal.
>
> **If Project is (unset):** If `gcloud config get-value project` returns `(unset)`, your CLI isn't pointed at a project yet. Find your ID with `gcloud projects list` and then run:
> ```bash
> gcloud config set project [YOUR_PROJECT_ID]
> ```
>
> **Renaming Projects:** To distinguish this from other generic "My First Project" entries, rename it:
> ```bash
> gcloud projects update project-39c0ea08-238b-47b5-915 --name="GoCD-App-Hosting"
> ```
---

## Installing GCloud CLI in a GoCD Agent

Add the following to your `Dockerfile.agent`:

```dockerfile
RUN apk add --no-cache python3 curl bash && \
    curl -sSL https://sdk.cloud.google.com | bash
ENV PATH $PATH:/root/google-cloud-sdk/bin
```

---

## Pipeline Configuration

Add a deploy stage to your pipeline in `config/cruise-config.xml`:

```xml
<pipeline name="badminton_court">
  <stage name="deploy_to_gcp">
    <jobs>
      <job name="remote_deploy">
        <tasks>
          <exec command="gcloud">
            <arg>compute</arg>
            <arg>ssh</arg>
            <arg>__GCP_VM_NAME__</arg>
            <arg>--quiet</arg>
            <arg>--zone</arg>
            <arg>__GCP_ZONE__</arg>
            <arg>--command</arg>
            <arg>cd /app && git pull && docker compose up -d --build</arg>
          </exec>
        </tasks>
      </job>
    </jobs>
  </stage>
</pipeline>
```

---

## Authentication Workflow

> [!IMPORTANT]
> **Organization Policy Alert:** If you see an error stating `iam.disableServiceAccountKeyCreation` is enforced, GCP is blocking the creation of JSON keys for security.
> 
> **Why is this disabled?**
> - **Static Risk:** JSON keys never expire and are hard to rotate.
> - **Leakage:** They are frequently leaked in Git history or logs.
> - **Exfiltration:** A stolen key can be used from anywhere in the world, whereas modern alternatives (Workload Identity) bind permissions to specific running instances.
> 
> Google enforces this "Secure by Default" policy to prevent high-impact security breaches.
> 
> **Option A: Disable the Policy (If you have permissions)**
> 1. Grant yourself the Policy Admin role at the **Organization** level (this role is not supported at the project level):
> ```bash
> # 1. Find your Organization ID
> gcloud organizations list
> 
> # 2. Bind the role to your account using the ORG_ID from above
> gcloud organizations add-iam-policy-binding [ORGANIZATION_ID] \
>     --member="user:your-email@gmail.com" \
>     --role="roles/orgpolicy.policyAdmin"
> ```
> 2. Disable the enforcement for your specific project:
> ```bash
> gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=project-39c0ea08-238b-47b5-915
> ```
> *Note: If you still get a permission error, you may need to perform this in the GCP Console under "Organization Policies".*
> 
> **Option B: Workload Identity Federation (Recommended)**
> Instead of a static key, you can configure GCP to trust your GoCD environment (if it's running on a supported provider like GitHub Actions, AWS, or OIDC). 
> 
> If you are running GoCD locally/on-prem and *must* use a key, you will need to ask your Org Policy Admin to grant an exception for your project or use **Option A**.

### Why not use the "Default Service Account"?
You will notice a `Compute Engine default service account` already exists. While you *can* use it, we recommend creating a dedicated one for two reasons:
1. **Security (PoLP)**: The default account often has the `Editor` role. If your key is leaked, an attacker has full control over the entire project. A dedicated account should only have `Compute Instance Admin`.
2. **Auditability**: Logs will clearly show that "gocd-deployer" performed the action, rather than a generic system account.

### Why it has "No Keys"
Service accounts are "keyless" by default because GCP expects internal workloads to use the **Metadata Server**. Since your GoCD agents are running **outside** of GCP, they require a manual JSON key to authenticate.

### 1. Provisioning via CLI

**Create Service Account & Key:**
```bash
# Create account
gcloud iam service-accounts create gocd-deployer --display-name="GoCD Deployer"

# Grant permissions
gcloud projects add-iam-policy-binding project-39c0ea08-238b-47b5-915 \
    --member="serviceAccount:gocd-deployer@project-39c0ea08-238b-47b5-915.iam.gserviceaccount.com" \
    --role="roles/compute.instanceAdmin.v1"

# Generate JSON Key
gcloud iam service-accounts keys create gcp-key.json \
    --iam-account=gocd-deployer@project-39c0ea08-238b-47b5-915.iam.gserviceaccount.com

mv gcp-key.json secrets/
```

### 2. Authentication in Pipeline
The agent must authenticate before running `gcloud` commands. This is usually handled in the GoCD task:
```bash
gcloud auth activate-service-account --key-file=/secret/gcp-key.json
gcloud config set project project-39c0ea08-238b-47b5-915
```

### 3. SSH Keys
GCloud handles SSH key generation and propagation automatically when you run `gcloud compute ssh`. The first run will generate a key pair in `/root/.ssh/`.

---

## SQLite Data Safety

Since we are using Compute Engine:
- Ensure the app's Docker volume maps to a persistent directory on the VM host (e.g., `/mnt/state/db`).
- The VM's 30GB persistent disk ensures the SQLite file survives container restarts.

---

## Notes
- Use `--force-with-lease` if your deployment script involves git resets.
- Monitor deployment via `gcloud compute instances get-serial-port-output`.

### 4. First-Time SSH Initialization
The first time a GoCD agent connects to a new VM, it needs to generate a local SSH key pair. Run this one-time command inside your agent container (or add it as a task) to ensure keys exist:
```bash
gcloud compute config-ssh --quiet
```
This prevents the pipeline from hanging while waiting for a user to "Press Enter" to generate keys.