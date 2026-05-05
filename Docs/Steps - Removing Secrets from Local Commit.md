# Remove a Secret File from Git History

This guide covers how to remove accidentally committed secrets from Git history.
This has happened in this project with `env.passphrase.txt` and `.env.docker`.

---

## Set Your Default Editor First

```bash
# Windows
git config --global core.editor "notepad"

# Linux/WSL
git config --global core.editor "nano"

# Google Cloud Shell
git config --global core.editor "cloudshell edit --wait"
```

---

## Know First the Commit ID That Has the Secret

```bash
git log --oneline
```

Output example:
```
a1b2c3d (HEAD -> feature-stats-logging) latest commit message
f8f4cbe accidentally added env.passphrase.txt   <-- this one
9e8d7c6 some earlier commit
```

---

## For a More Specific Search If You Don't Know the Commit ID

```bash
# Search by filename
git log --oneline -S "env.passphrase.txt"

# Search by actual secret string inside the file
git log --oneline -S "your_secret_value"

# Search across all branches
git log --all --oneline -S "env.passphrase.txt"
```

---

## Interactive Rebase Back to Before That Commit

```bash
git rebase -i f8f4cbed~1
```

In the editor, change `pick` to `edit` on `f8f4cbe`, save and close.

---

## Troubleshooting

### 1. "Permission denied" during rebase
If you see `error: unable to create file ... Permission denied` (e.g., for `secrets/gcp-key.json`) when continuing or aborting a rebase, it is usually because the directory has become owned by `root` due to Docker volume mounts.

Run this to fix ownership:
```bash
sudo chown -R $USER:$USER ~/gocd-server
```

### 2. "Untracked working tree files would be overwritten"
If `git rebase --abort` fails because files like `Scripts/go.sh` would be overwritten:
1. Manually delete the files listed in the error message (e.g., `rm Scripts/go.sh`).
2. Run `git rebase --abort` again.
Git will then successfully restore the original versions of those files from history.

---

## Managing the Rebase

```bash
# If you messed up the file, abort and start over
git rebase --abort

# If you accidentally closed the editor, continue
git rebase --continue

# If you have work-in-progress you don't want to lose before rebasing:
git stash

# To get your stashed work back after the rebase:
git stash pop
```

---

## Remove the File from That Commit

```bash
git rm --cached env.passphrase.txt
echo "env.passphrase.txt" >> .gitignore
git commit --amend --no-edit
```

---

## Continue Rebase and Force Push

```bash
git rebase --continue
git push origin feature-stats-logging --force
```

---

## Files That Must Never Be Committed (Already in .gitignore)

| File | Reason |
|---|---|
| `.env.docker` | Contains `GITHUB_TOKEN` and `GOCD_ADMIN_PASSWORD` |
| `env.passphrase.txt` | Contains encryption passphrase |
| `certs/*.key` | Private SSL keys |
| `certs/keystore.p12` | PKCS12 keystore |

---

## If the Secret Was Already Pushed to GitHub

If the secret was pushed to a public or shared repo, you must:

1. **Immediately revoke the token** — go to `https://github.com/settings/tokens` and delete it
2. **Generate a new token** — see `Docs/Steps - Github Token and Environment Variables.md`
3. **Update `.env.docker`** with the new token
4. **Clean the history** using the steps above
5. **Force push** to overwrite remote history
6. **Notify collaborators** to re-clone — their local copies still have the old history

> **Note:** GitHub's secret scanning will automatically detect and alert you if a
> `GITHUB_TOKEN` pattern is pushed. Always act immediately when you receive that alert.

---

## Prevention

Add a pre-commit hook to prevent accidental commits of sensitive files:

```bash
# .git/hooks/pre-commit
#!/bin/bash
if git diff --cached --name-only | grep -qE "(\.env|passphrase|\.key|keystore)"; then
    echo "ERROR: Attempting to commit a sensitive file. Aborting."
    exit 1
fi
```

Make it executable:
```bash
chmod +x .git/hooks/pre-commit
```