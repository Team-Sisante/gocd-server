# BuildKit cache corruption
## Source: Docs/Trouble-shooting/BuildKit cache corruption.md

## Troubleshooting Docker BuildKit cache corruption

### Symptom
Docker builds fail with:
```
target gocd-agent-3: failed to solve: failed to prepare extraction snapshot "extract-499934707-2P21 sha256:f02caa79e4436eb566d3b2c12cbbb02bd8e3434575612f7355c1d60c910f42df": parent snapshot sha256:06a4bfb97e5f11bec826d8e7434e31122d2eea2e2ba2b04a366b3efcdd37b1cc does not exist: not found
```

The build aborts with a snapshot reference error.

### Root Cause
Docker BuildKit's cache has a broken snapshot reference. This usually happens after:
- A Docker Desktop crash
- An interrupted build
- A disk space issue
- A Docker Desktop upgrade

BuildKit tries to reference a parent snapshot that no longer exists, causing the build to fail.

### Diagnostic Steps

1. **Check if the error mentions "parent snapshot ... does not exist":**
   ```
   failed to solve: failed to prepare extraction snapshot "extract-..." ... parent snapshot sha256:... does not exist: not found
   ```

2. **Try a simple build to confirm BuildKit is broken:**
   ```bash
   echo "FROM alpine" | docker build -
   ```
   If this fails with the same error, BuildKit cache is corrupted.

### Fix

#### Option A: Prune the builder cache (recommended first)

```bash
docker builder prune -a -f
```

This clears ALL BuildKit cache (cached layers from previous builds). Running containers and volumes are unaffected. Next build will be slower because it re-pulls/re-compiles everything, but it will succeed.

Then re-run the build:
```bash
cd gocd-server
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
```

#### Option B: Restart Docker Desktop + prune (if Option A fails)

If `builder prune` itself errors out, the BuildKit daemon state is fully corrupted:

1. Use menu option **4.5** (Clean up Docker resources) — or `docker system prune -a -f`
2. Use menu option **1.7** (Restart Docker Desktop) — fully restart Docker Desktop including the BuildKit daemon
3. After Docker is back, run **1.1** (Update/Restart GoCD - Fast Build)

#### Option C: Reset the builder (if Options A & B fail)

```bash
docker buildx ls
docker buildx rm default
docker buildx create --use --name default
```

Then restart Docker Desktop and re-run the build.

#### Option D: Nuclear (if all else fails)

Use menu option **1.6** (SYSTEM HARD RESET via `go.js`) — but this wipes ALL Docker state on the machine, not just GoCD. Only use this if:
- You don't have any other Docker projects on this machine
- Options A, B, and C all failed

### Verification

After the fix:
```bash
# Simple build should succeed
echo "FROM alpine" | docker build -

# GoCD build should succeed
cd gocd-server
docker compose --env-file .env.docker build
```

### Related Files
- `gocd-server/Scripts/go.js` — menu option 1.6 (nuclear reset)
- `gocd-server/Scripts/gocd-reset.js` — menu option 1.12 (GoCD-only reset)
