# Azure Deployment Steps

> [!CAUTION]
> **DEPRECATED:** As of 2026-05-05, we have migrated our primary hosting strategy to GCP Compute Engine. 
> This document is maintained for legacy reference only. Please refer to `Docs/Steps - GCP Deployment.md`.

This document outlines the steps for deploying GoCD pipelines to Azure VMs using Azure CLI.

---

## Prerequisites

- Azure CLI installed and authenticated (`az login`)
- Azure VM created with necessary permissions
- GoCD agent with `azure-cli` installed (or install it in `Dockerfile.agent`)
- `deploy-script.sh` prepared in your application repository

---

## Installing Azure CLI in a GoCD Agent

To add Azure CLI support to an agent, add the following to `Dockerfile.agent`:

```dockerfile
RUN apk add --no-cache py3-pip && \
    pip3 install azure-cli --break-system-packages
```

Or for the Ubuntu-based agent:

```dockerfile
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash
```

---

## Pipeline Configuration

Add a deploy stage to your GoCD pipeline in `config/cruise-config.xml`:

```xml
<pipeline name="badminton_court">
  <materials>
    <git url="__GIT_REPO_URL_WITH_CREDENTIALS__" branch="master" />
  </materials>

  <stage name="build">
    <!-- existing build stage -->
  </stage>

  <stage name="deploy">
    <jobs>
      <job name="deploy_to_azure">
        <resources>
          <resource>docker</resource>
          <resource>badminton_court</resource>
        </resources>
        <tasks>
          <exec command="az">
            <arg>vm</arg>
            <arg>run-command</arg>
            <arg>invoke</arg>
            <arg>--resource-group</arg>
            <arg>your-resource-group</arg>
            <arg>--name</arg>
            <arg>badminton-vm</arg>
            <arg>--command-id</arg>
            <arg>RunShellScript</arg>
            <arg>--scripts</arg>
            <arg>@deploy-script.sh</arg>
          </exec>
        </tasks>
      </job>
    </jobs>
  </stage>
</pipeline>
```

---

## Steps

### 1. Prepare the Deploy Script

Create `deploy-script.sh` in your application repository:

```bash
#!/bin/bash
set -e
cd /your-app
git pull origin master
docker-compose --env-file .env.docker down
docker-compose --env-file .env.docker up -d --build
```

### 2. Configure Azure Authentication in the Agent

The GoCD agent needs Azure credentials to run `az` commands. Use a Service Principal:

```bash
az login --service-principal \
  --username $AZURE_CLIENT_ID \
  --password $AZURE_CLIENT_SECRET \
  --tenant $AZURE_TENANT_ID
```

Add these to `.env.docker`:
```dotenv
AZURE_CLIENT_ID=your_client_id
AZURE_CLIENT_SECRET=your_client_secret
AZURE_TENANT_ID=your_tenant_id
```

### 3. Update the Pipeline

Replace the placeholders in `cruise-config.xml`:
- `your-resource-group` → your Azure resource group name
- `badminton-vm` → your Azure VM name

### 4. Run the Pipeline

Trigger the pipeline in GoCD UI. The deploy stage will execute the Azure CLI command
to run the deploy script on the VM.

---

## Azure VM Requirements

The target Azure VM needs:
- SSH access or Azure Run Command permission
- Docker and docker-compose installed
- The application repository cloned at the expected path
- Appropriate firewall rules for the application ports

---

## Notes

- Git credentials are injected at runtime by `entrypoint.js` — never hardcode them
- Test `deploy-script.sh` locally before adding it to the pipeline
- Monitor deployment logs in both GoCD UI and Azure Portal
- Consider adding a health check task after deployment to verify the app is running