# Steps - Github Token and Environment Variables

The app uses `.env.docker` variables for GitHub authentication, GoCD admin password,
and Git repository configuration.

---

## Required Environment Variables

Create `.env.docker` in the root of the `gocd-server` directory:

```dotenv
# .env.docker

# GoCD admin password
GOCD_ADMIN_PASSWORD=your_admin_password

# GitHub Personal Access Token (must have: repo, write:packages scopes)
GITHUB_TOKEN=your_github_token

# Git repository settings (shared across all pipelines)
GIT_REPO_PROTOCOL=https
GIT_REPO_DOMAIN=github.com
GIT_REPO_USERNAME=xmione

# Per-pipeline repository names
GIT_REPO_REPONAME=badminton_court
GIT_PEARL_HELLO_WORLD_REPONAME=pearl-hello-world
GIT_SOLVPN_REPONAME=solvpn

# GCP Settings
GCP_PROJECT_ID=project-39c0ea08-238b-47b5-915
GCP_ZONE=us-west1-b
GCP_VM_NAME=gocd-deploy-target
```

---

## GitHub Token Requirements

The `GITHUB_TOKEN` is used for three things:

| Use | Required Scope |
|---|---|
| Cloning private repos in GoCD pipelines | `repo` |
| Publishing GitHub Releases (solvpn pipeline) | `repo` |
| Pushing base image to ghcr.io (`npm run setup-base-image`) | `write:packages` |

The token we use is the **30-day gocd-server token** located here:
```
https://github.com/settings/tokens/2739118787
```

---

## To Get the Current GitHub ENV_ENCRYPTION_KEY Variable

```powershell
.\Scripts\get-gh-variable.ps1
```

Check that the `GITHUB_TOKEN` in `.env.docker` matches the value returned.

> The `GOCD_ADMIN_PASSWORD` may differ from `GITHUB_TOKEN` but it is good
> practice to update both when regenerating the token.

---

## To Get the Current GoCD Admin Password

```powershell
.\Scripts\getadminpassword.ps1
```

---

## Repository Variables

The GitHub Actions repository variables are located here:
```
https://github.com/xmione/gocd-server/settings/variables/actions
```

---

## How Environment Variables Are Used at Runtime

When the GoCD server container boots, `Scripts/entrypoint.js` reads the env vars
from `.env.docker` (loaded via `env_file` in `docker-compose.yml`) and:

1. Constructs authenticated Git URLs for each pipeline:
   ```
   https://{GITHUB_TOKEN}@{GIT_REPO_DOMAIN}/{GIT_REPO_USERNAME}/{REPO_NAME}.git
   ```

2. Injects them into `cruise-config.xml` replacing these placeholders:
   - `__GIT_REPO_URL_WITH_CREDENTIALS__` → badminton_court URL
   - `__PEARL_REPO_URL_WITH_CREDENTIALS__` → pearl-hello-world URL
   - `__SOLVPN_REPO_URL_WITH_CREDENTIALS__` → solvpn URL
   - `__GCP_PROJECT_ID__` → GCP Project ID from .env.docker
   - `__GCP_ZONE__` → GCP Zone from .env.docker
   - `__GCP_VM_NAME__` → GCP VM Name from .env.docker

3. Hashes `GOCD_ADMIN_PASSWORD` using bcrypt and writes it to `password.properties`

This means credentials are **never stored in config files** — they only exist
in `.env.docker` (which is git-ignored) and in memory at runtime.

---

## Adding a New Pipeline Repository

To add a new repository to the pipeline system:

1. Add a new env var to `.env.docker`:
   ```dotenv
   GIT_MYAPP_REPONAME=my-app-repo
   ```

2. Add a placeholder to `config/cruise-config.xml`:
   ```xml
   <git url="__MYAPP_REPO_URL_WITH_CREDENTIALS__" branch="master" />
   ```

3. Add the injection to `Scripts/entrypoint.js`:
   ```javascript
   if (GIT_MYAPP_REPONAME) {
     replaceInFile(CRUISE_CONFIG, '__MYAPP_REPO_URL_WITH_CREDENTIALS__', makeUrl(GIT_MYAPP_REPONAME));
     log('Injected URL for my-app.');
   }
   ```

---

## Token Renewal

When your GitHub token expires (every 30 days):

1. Go to `https://github.com/settings/tokens/2739118787` and regenerate it
2. Update `GITHUB_TOKEN` in `.env.docker`
3. Update `GOCD_ADMIN_PASSWORD` in `.env.docker` (recommended)
4. Update the `ENV_ENCRYPTION_KEY` repository variable on GitHub
5. Run option 1.6 from `npm run menu` to restart containers with the new token