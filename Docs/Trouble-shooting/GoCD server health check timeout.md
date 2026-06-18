# GoCD server health check timeout
## Source: Docs/Trouble-shooting/GoCD server health check timeout.md

## Troubleshooting GoCD server health check timeouts after container recreation

### Symptom
The `gocd-recreate-server.js` script (menu option 1.13) fails with:
```
[gocd-recreate-server] Server did not become healthy within 300 seconds.
[gocd-recreate-server] Recent server logs:
jvm 1    | GoCD server started successfully.
jvm 1    | Reloading config file: config/cruise-config.xml
```

The server logs show "GoCD server started successfully" and config reloaded — but the health check still fails.

### Root Cause
Two issues:

1. **GoCD takes 2-5 minutes to fully boot** — it's a Java app that initializes Spring context, runs database migrations, loads plugins, and starts Jetty. The script's health check timeout (even at 5 minutes) can be too short on slow machines.

2. **Windows curl quirks** — when the script uses `execSync('curl ... http://localhost:8153/...')`, Node.js on Windows may resolve `curl` to `C:\Windows\System32\curl.exe` instead of Git Bash's `/usr/bin/curl`. The Windows builtin curl can behave differently with the `-f` flag and IPv6 resolution.

3. **IPv6-first resolution** — `localhost` on Windows can resolve to `::1` (IPv6) before `127.0.0.1` (IPv4). Docker's port binding may only listen on IPv4 (`0.0.0.0:8153`), so the IPv6 connection fails.

### Diagnostic Steps

1. **Check if the server actually came up:**
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8153/go/api/v1/health
   # If this returns 200, the server is up — the script's health check was the problem
   ```

2. **Check the server logs for "started successfully":**
   ```bash
   docker logs gocd-server 2>&1 | grep "GoCD server started"
   ```

3. **Try the health check with 127.0.0.1 (force IPv4):**
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8153/go/api/v1/health
   ```

### Fix

#### Step 1: Use Node's native HTTP client instead of curl

In `Scripts/gocd-recreate-server.js`, replace the curl-based health check with Node's `http` module:

```javascript
const http = require('http');

/**
 * Check if the GoCD server is responding. Uses Node's built-in http module
 * instead of curl to avoid Windows curl quirks.
 *
 * Uses 127.0.0.1 explicitly (not localhost) to force IPv4.
 */
function isServerReady() {
    return new Promise((resolve) => {
        const tryEndpoint = (path, label) => {
            return new Promise((res) => {
                const req = http.get({
                    host: '127.0.0.1',        // ← Force IPv4
                    port: 8153,
                    path: path,
                    timeout: 3000,
                }, (response) => {
                    response.resume();
                    if (response.statusCode === 200 ||
                        response.statusCode === 302 ||
                        response.statusCode === 401) {
                        res(label);
                    } else {
                        res(null);
                    }
                });
                req.on('error', () => res(null));
                req.on('timeout', () => {
                    req.destroy();
                    res(null);
                });
            });
        };

        // Try the API health endpoint first
        tryEndpoint('/go/api/v1/health', 'health').then(result => {
            if (result) return resolve(result);
            // Fall back to the root UI URL (responds earlier in boot)
            return tryEndpoint('/go/', 'root');
        }).then(resolve);
    });
}
```

#### Step 2: Increase the timeout to 5 minutes

```javascript
const MAX_ATTEMPTS = 60;     // 60 attempts × 5s = 300s = 5 minutes
const INTERVAL_MS = 5000;
```

#### Step 3: Use `await isServerReady()` in the polling loop

```javascript
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const endpoint = await isServerReady();
    if (endpoint) {
        ready = true;
        log(`Server is responding via /${endpoint} (attempt ${attempt}/${MAX_ATTEMPTS}, ${elapsed}s elapsed).`, '\x1b[32m');
        break;
    }
    if (attempt === 1 || attempt % 6 === 0) {
        log(`  Still waiting... attempt ${attempt}/${MAX_ATTEMPTS} (${elapsed}s elapsed)`, '\x1b[36m');
    }
    await sleep(INTERVAL_MS);
}
```

### Why This Works

| Approach | Issue |
|----------|-------|
| `execSync('curl ... http://localhost:8153/...')` | Windows curl PATH issues, IPv6 resolution |
| `http.get({ host: '127.0.0.1', port: 8153, ... })` | No curl dependency, forces IPv4 |

### Verification

After the fix, the script should detect the server within 5 minutes:
```
[gocd-recreate-server] Server is responding via /health (attempt 48/60, 240s elapsed).
[gocd-recreate-server] STEP 4: Giving the server 10 extra seconds to finish booting...
[gocd-recreate-server] STEP 5: Verifying entrypoint.js output...
[gocd-recreate-server] All placeholders successfully replaced.
```

### If the Server Still Doesn't Come Up

If the health check fails AND the server logs don't show "started successfully", there's a real startup error. Check:
```bash
docker logs gocd-server --tail=50
```

Look for:
- `ERROR` or `FATAL` in the logs
- `Could not fetch resource` (GCP/permission issues)
- `Could not connect to database` (Postgres issues)
- `Config file changed` followed by errors (cruise-config.xml parse errors)

### Related Files
- `gocd-server/Scripts/gocd-recreate-server.js` — the health check script (menu option 1.13)
