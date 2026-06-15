# GoCD Server Setup Guide

This guide provides detailed instructions for setting up and configuring the GoCD server environment.

---

## Repository Structure

```
C:\repo\
    gocd-server\                        # This repository
        config\
            cruise-config.xml           # GoCD pipeline configuration template
        certs\                          # SSL certificates (git-ignored)
        Scripts\
            entrypoint.js               # GoCD server boot script (Node.js)
            agent-entrypoint.sh         # GoCD agent boot script
            generate-certs.ps1          # Certificate generation
            setup-base-image.ps1        # One-time SolVPN base image setup
            build_base_image.sh         # Used by GoCD to rebuild base image
            go.ps1                      # Main build/run script
            validate.ps1                # Environment validation
            gocd-menu.ps1               # Interactive management menu
        Dockerfile                      # GoCD server image
        Dockerfile.agent                # GoCD agent image (agent-1, agent-2)
        Dockerfile.agent.solvpn         # GoCD agent image (agent-3, pulls base)
        Dockerfile.agent.solvpn.base    # SolVPN build tools base image
        docker-compose.yml
        apps.json                       # Pipeline app registry
        package.json                    # npm scripts
        .env.docker                     # Environment variables (git-ignored)
    pearl-hello-world\                  # Adjacent repo (agent-1)
    badminton_court\                    # Adjacent repo (agent-2)
    solvpn\                             # Adjacent repo (agent-3)
```

---

## Initial Setup

### 1. Clone and Navigate

```bash
git clone https://github.com/xmione/gocd-server.git
cd gocd-server
```

### 2. Install Dependencies

- Docker Desktop (Windows) with Linux containers enabled
- **Cloud Shell Note:** Docker and Node.js are pre-installed.
- Node.js 18+ and npm
- PowerShell 7+

### 3. Generate Certificates

```powershell
.\Scripts\generate-certs.ps1
```

Creates `certs/server.crt`, `certs/server.key`, `certs/ca.crt`, and `certs/keystore.p12`.

### 4. Configure Environment Variables

Create `.env.docker` in the gocd-server root:

```dotenv
# .env.docker
GOCD_ADMIN_PASSWORD=your_admin_password
GITHUB_TOKEN=your_github_personal_access_token
GIT_REPO_PROTOCOL=https
GIT_REPO_DOMAIN=github.com
GIT_REPO_USERNAME=xmione
GIT_REPO_REPONAME=badminton_court
GIT_PEARL_HELLO_WORLD_REPONAME=pearl-hello-world
GIT_SOLVPN_REPONAME=solvpn
```

> **Important:** `GITHUB_TOKEN` must have `repo` and `write:packages` scopes.
> See `Docs/Steps - Github Token and Environment Variables.md` for details.

### 5. Set Up SolVPN Build Base Image (One-Time)

The SolVPN agent requires a pre-built base image containing the MinGW cross-compiler
and a cross-compiled OpenSSL for Windows. This compilation takes 3-5 minutes and
must not run on every `go.ps1` option 1.6 call (which wipes all Docker cache).

There are two scripts involved — they do the same job but in different environments:

| Script | Runs On | Triggered By | Purpose |
|---|---|---|---|
| `Scripts/setup-base-image.ps1` | Your Windows host | You manually (`npm run setup-base-image`) | **Bootstrap** — first time after cloning, before GoCD exists |
| `Scripts/build_base_image.sh` | GoCD agent container (Linux) | GoCD `solvpn-base-image` pipeline (manual trigger) | **Automation** — future rebuilds once GoCD is running |

**The workflow is: `setup-base-image.ps1` first, then `build_base_image.sh` forever after.**

Run this once after cloning:

```powershell
npm run setup-base-image
```

This reads `GITHUB_TOKEN` and `GIT_REPO_USERNAME` from `.env.docker`, builds the
base image from `Dockerfile.agent.solvpn.base`, and pushes it to
`ghcr.io/xmione/solvpn-build-base:latest`.

After this, `docker-compose` pulls the pre-built image in seconds instead of
recompiling OpenSSL every time.

> **When to rerun:** Only when `Dockerfile.agent.solvpn.base` changes (e.g. you upgrade
> the OpenSSL version or add new build tools). For automated rebuilds, trigger the
> `solvpn-base-image` pipeline in the GoCD UI instead.

### 6. Build and Run

```bash
npm run menu
```

Select **option 1.6** to fully clean and recreate all Docker containers.

---

## npm Scripts

| Command | Description |
|---|---|
| `npm run menu` | Opens the interactive GoCD management menu |
| `npm run go` | Recreates Docker containers |
| `npm run validate` | Validates the GoCD environment |
| `npm run setup-base-image` | Builds and pushes the SolVPN base image to ghcr.io |
| `npm run geterror` | Fetches Docker container errors |
| `npm run pfs` | Prints the project folder structure |
| `npm run encryptenvfiles` | Encrypts .env files |
| `npm run decryptenvfiles` | Decrypts .env files |

---

## Configuration Files

### cruise-config.xml

Located at `config/cruise-config.xml`. This is the GoCD pipeline configuration template. It uses placeholders that are replaced at container boot time by `Scripts/entrypoint.js`.

**Placeholders replaced at boot:**

| Placeholder | Replaced With |
|---|---|
| `__SERVER_ID__` | Persistent UUID from `/godata/.server-id` |
| `__GIT_REPO_URL_WITH_CREDENTIALS__` | `badminton_court` authenticated Git URL |
| `__PEARL_REPO_URL_WITH_CREDENTIALS__` | `pearl-hello-world` authenticated Git URL |
| `__SOLVPN_REPO_URL_WITH_CREDENTIALS__` | `solvpn` authenticated Git URL |

**To add a new pipeline**, add its Git URL placeholder to `cruise-config.xml` and add the corresponding env var to `.env.docker`. Then update `entrypoint.js` to inject the new URL.

### entrypoint.js

Located at `Scripts/entrypoint.js`. Runs at container boot as the GoCD server entrypoint. Written in Node.js for cross-platform compatibility.

**Boot sequence:**
1. Generates or loads a persistent server UUID from `/godata/.server-id`
2. Always recreates `cruise-config.xml` from the mounted template
3. Injects server ID and all Git URLs into the config
4. Hashes and writes the admin password to `password.properties`
5. Fixes file permissions on `/godata/config`
6. Hands off to the GoCD server process via `gosu`

### docker-compose.yml

Defines four services:

| Service | Dockerfile | Purpose |
|---|---|---|
| `gocd-server` | `Dockerfile` | GoCD server, ports 8153/8154 |
| `gocd-agent-1` | `Dockerfile.agent` | Runs `pearl-hello-world` pipeline |
| `gocd-agent-2` | `Dockerfile.agent` | Runs `badminton_court` pipeline |
| `gocd-agent-3` | `Dockerfile.agent.solvpn` | Runs `solvpn-deployment` pipeline |

### Dockerfile

Based on `gocd/gocd-server:v25.4.0` (Wolfi/glibc-based). Installs:
- `uuidgen`, `gosu`, `libxml2-utils`, `jq`, `apache2-utils`
- Node.js 18 LTS from the official nodejs.org tarball (required due to GLIBC compatibility)

> **Note:** Do NOT install Node.js via `apk` on this image — the Wolfi base has a glibc
> version incompatible with Alpine's Node.js binaries. Always use the tarball install.

### Dockerfile.agent

Based on `gocd/gocd-agent-alpine:v25.4.0`. Used by agent-1 and agent-2. Installs:
- `ca-certificates`, `openssl`, `curl`, `docker`, `gnupg`, `jq`, `docker-compose`
- Node.js, npm
- GitHub CLI (`gh`)

### Dockerfile.agent.solvpn

Based on `ghcr.io/xmione/solvpn-build-base:latest` (pre-built). Used by agent-3.
Adds the GoCD agent layer (GitHub CLI, docker, npm) on top of the pre-built base.
Builds fast because the slow tooling is already baked into the base image.

### Dockerfile.agent.solvpn.base

The slow base image for agent-3. Contains:
- MinGW cross-compiler (`mingw-w64-gcc`)
- OpenSSL cross-compiled for Windows (builds from source, ~3-5 minutes)
- Python 3, pip, flet
- zip utility

This is built once by `npm run setup-base-image` and pushed to `ghcr.io`.

---

## Pipelines

### pearl-hello-world

- **Agent:** gocd-agent-1
- **Branch:** master
- **What it does:** Builds and runs the pearl-hello-world Docker container on port 9292

### badminton_court

- **Pipelines:**
    - `badminton_court-artifacts`: Builds and pushes Docker images to GHCR with `:latest` and `:sha-<short-sha>` tags.
    - `badminton_court-staging/production`: Fetches SHA-tagged images and deploys using `IMAGE_TAG`.
- **Agent:** gocd-agent-2
- **Branch:** master
- **What it does:** Implements artifact promotion by building immutable images and deploying specific versions.

### humrine_site

- **Pipelines:**
    - `humrine_site-artifacts`: Builds and pushes Docker images to GHCR with `:latest` and `:sha-<short-sha>` tags.
    - `humrine_site-staging/production`: Fetches SHA-tagged images and deploys using `IMAGE_TAG`.
- **Agent:** gocd-agent-2
- **Branch:** master
- **What it does:** Implements artifact promotion by building immutable images and deploying specific versions.

### solvpn-deployment

- **Agent:** gocd-agent-3
- **Branch:** feature-stats-logging
- **Stages:**

| Stage | Job | Description |
|---|---|---|
| `Build_and_Package` | `compile_windows_dist` | Cross-compiles DLLs, generates certs, packages Python scripts |
| `Create_Installer` | `build_installer` | Creates a zip package with setup.bat for Windows distribution |
| `Publish_Release` | `publish_github_release` | Creates a versioned GitHub Release and uploads the zip |

### solvpn-base-image

- **Agent:** Any agent with `docker` and `linux` resources
- **Trigger:** Manual only
- **What it does:** Rebuilds and pushes `ghcr.io/xmione/solvpn-build-base:latest`
- **When to run:** Only when `Dockerfile.agent.solvpn.base` changes

---

## Agent Resources

| Resource Tag | Used By | Purpose |
|---|---|---|
| `docker` | All agents | Docker-related tasks |
| `linux` | All agents | General Linux tasks |
| `pearl-hello-world` | agent-1 | Routes pearl pipeline jobs |
| `badminton_court` | agent-2 | Routes badminton pipeline jobs |
| `solvpn` | agent-3 | Routes solvpn pipeline jobs |

---

## Security

- SSL enabled on ports 8153 (HTTP) and 8154 (HTTPS)
- Password file authentication via `cd.go.authentication.passwordfile` plugin
- Admin password is hashed with bcrypt (`htpasswd -nbB`) at container boot
- Git credentials are injected at boot from environment variables — never stored in config files
- `.env.docker` is git-ignored

---

## Monitoring and Logs

```powershell
# All services
docker-compose logs -f

# GoCD server only
docker logs gocd-server

# View entrypoint.js boot logs
docker logs gocd-server 2>&1 | findstr "entrypoint.js"

# Validate environment
npm run validate
```

GoCD Web UI: `http://localhost:8153` or `https://localhost:8154`

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `URL does not seem to be valid` | Unresolved placeholder in cruise-config.xml | Check all env vars in `.env.docker` are set and non-empty |
| `GLIBC_2.43 not found` | Wrong Node.js binary for gocd-server image | Use Node 18 LTS tarball in `Dockerfile`, not `apk install nodejs` |
| `htpasswd: not found` | `apache2-utils` not installed | Add `apache2-utils` to `Dockerfile` |
| `libssl not found` (mingw) | Windows OpenSSL missing for cross-compiler | Run `npm run setup-base-image` to rebuild base image |
| `cruise-config.xml` has stale placeholders | Old volume persisted | `entrypoint.js` now always recreates the file — ensure containers are fully stopped and recreated |
| Agent not picking up jobs | Agent not registered | Check agent resources match pipeline resource requirements |
| `setup-base-image` fails | `GITHUB_TOKEN` missing `write:packages` scope | Regenerate token with correct scopes |