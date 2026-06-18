# Git Bash MSYS path translation
## Source: Docs/Trouble-shooting/Git Bash MSYS path translation.md

## Troubleshooting Git Bash MSYS path translation issues with Docker commands

### Symptom
When running `docker exec` commands in Git Bash on Windows, paths like `/godata/config/cruise-config.xml` get translated to `C:/Program Files/Git/godata/config/cruise-config.xml`:

```bash
$ docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml
grep: C:/Program Files/Git/godata/config/cruise-config.xml: No such file or directory
```

The command never reaches the container — `grep` ran locally on Windows and couldn't find the file.

### Root Cause
Git Bash (MSYS2) automatically converts Unix-style paths to Windows paths before passing them to commands. When it sees `/godata/config/cruise-config.xml`:

1. MSYS thinks you're referring to a Unix-style path on the local machine
2. It translates it to a Windows path: `C:/Program Files/Git/godata/config/cruise-config.xml`
3. `docker exec` receives the translated path and passes it to the container
4. The container's `grep` looks for `C:/Program Files/Git/godata/config/cruise-config.xml` inside Linux — doesn't exist
5. Error

### Diagnostic Steps

1. **Check if the path is being translated:**
   ```bash
   echo /godata/config/cruise-config.xml
   # If output is: C:/Program Files/Git/godata/config/cruise-config.xml
   # Then MSYS is translating the path
   ```

2. **Run the docker exec command and check the error:**
   ```bash
   docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml
   # If error mentions "C:/Program Files/Git/...", path translation is the issue
   ```

### Fix

#### Option A: Prefix with `MSYS_NO_PATHCONV=1` (recommended)

```bash
MSYS_NO_PATHCONV=1 docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml
```

`MSYS_NO_PATHCONV=1` tells Git Bash "don't translate paths in this command."

#### Option B: Use double slashes

```bash
docker exec gocd-server grep -c "set -e" //godata/config/cruise-config.xml
```

Git Bash won't translate paths that start with `//`. However, this can sometimes confuse the container's `grep`, so Option A is safer.

#### Option C: Set `MSYS_NO_PATHCONV=1` for the session

```bash
export MSYS_NO_PATHCONV=1
```

After running this once, all subsequent `docker exec` commands in that terminal session will skip path translation. You'd need to re-run it for each new Git Bash window.

To make it permanent, add to `~/.bashrc`:
```bash
echo 'export MSYS_NO_PATHCONV=1' >> ~/.bashrc
```

**Warning:** This can break other tools that rely on path translation. Only use this if you primarily run Docker commands in Git Bash.

#### Option D: Use PowerShell or CMD

If you use PowerShell or CMD instead of Git Bash, path translation isn't an issue — `/godata/...` is passed verbatim to `docker exec`.

### Common Commands That Need This Fix

Any `docker exec` command with Linux paths:

```bash
# Grep for config values
MSYS_NO_PATHCONV=1 docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml

# Cat a file inside a container
MSYS_NO_PATHCONV=1 docker exec gocd-server cat /godata/config/cruise-config.xml

# Find files inside a container
MSYS_NO_PATHCONV=1 docker exec gocd-server find /godata -name "*.xml"

# Run a command with a path argument
MSYS_NO_PATHCONV=1 docker exec gocd-server ls -la /godata/config/
```

### Why This Only Happens in Git Bash

| Shell | Path translation? | Example |
|-------|-------------------|---------|
| Git Bash (MSYS2) | ✅ Yes | `/godata/...` → `C:/Program Files/Git/godata/...` |
| PowerShell | ❌ No | `/godata/...` passed verbatim |
| CMD | ❌ No | `/godata/...` passed verbatim |
| WSL | ❌ No | `/godata/...` passed verbatim |

### Verification

```bash
# Without the fix (broken):
docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml
# Error: grep: C:/Program Files/Git/godata/config/cruise-config.xml: No such file or directory

# With the fix (working):
MSYS_NO_PATHCONV=1 docker exec gocd-server grep -c "set -e" /godata/config/cruise-config.xml
# Output: 3
```

### Related Files
- Any `docker exec` command run from Git Bash on Windows
