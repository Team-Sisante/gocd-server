# Environment Setup Guide

## Git Configuration
Before making commits, configure your Git identity:

```bash
git config --global user.email "solomiosisante@gmail.com"
git config --global user.name "Solomio Sante"
git config --global core.editor "nano"
```

## Tmux Configuration
Tmux is used to keep processes running in Cloud Shell even if the browser session times out or the PC sleeps.

- **Custom Prefix Key:** `Ctrl + x` (Replaces the default Ctrl+b to avoid conflicts with the Editor sidebar).
- **Persistence:** Processes inside tmux survive browser disconnects, but the Cloud Shell VM itself will shut down after ~1 hour of **web UI inactivity** (no mouse moves/typing in the browser).
- **Mouse Mode:** Enabled (allows scrolling with the mouse wheel and clicking to select panes).

### Session Management
- **Start new session:** `tmux` (Assigned a numerical ID like `0` or `1`)
- **Start named session:** `tmux new -s [name]` (e.g., `tmux new -s gocd`)
- **List active sessions:** `tmux ls` (Shows IDs and names of running sessions)
- **Attach to last session:** `tmux a`
- **Attach to specific target:** `tmux a -t [id or name]` (e.g., `tmux a -t 0`)
- **Close current session:** Type `exit` in the command prompt or press `Ctrl + d`.
- **Kill a specific session:** `tmux kill-session -t [id or name]`
- **Rename session:** `tmux rename-session -t [old_name] [new_name]`
- **Kill all sessions:** `tmux kill-server`

### Editing Files
To open a file in the Cloud Shell Editor directly from the terminal, use:
`cloudshell edit [filename]`
*Note: If you want to use the `code` command like on your local machine, you can run `alias code='cloudshell edit'`.*

*Tip: Use named sessions to easily identify which terminal is running your GoCD server versus your development tools.*

### Common Shortcuts
All commands start with the prefix `Ctrl + x`, then release, then the key below:

| Key | Action |
|-----|--------|
| `d` | **Detach** - Disconnect from session while leaving processes running. |
| `%` | Split screen **vertically**. |
| `"` | Split screen **horizontally**. |
| `z` | **Zoom** - Toggle current pane to full screen (hides other panes). |
| `c` | **New Window** - Creates a new terminal "tab" within the same session. |
| `n` / `p` | Move to **Next** or **Previous** window. |
| `0`-`9` | Jump directly to a specific window number (e.g., `Ctrl+x` then `0`). |
| `w` | **List Windows** - See an interactive list of all windows in the current session. |
| `s` | **List Sessions** - Interactive list of all sessions. Use arrows to select and Enter to switch. |
| `[` | **Copy/Scroll Mode** - Use arrows to scroll. Press `q` to exit. |
| `Ctrl + L` | **Clear Terminal** - Clears the visible screen (standard terminal shortcut). |
| `$` | **Rename** the current session. |
| `x` | Close the current pane. |

### Troubleshooting Hangups (The "Dots" Issue)
If the terminal hangs and displays infinite dots (`.......`), a process is likely waiting for an interactive prompt that isn't visible.

1. **Stop the hang:** Press `Ctrl + C`.
2. **Fix SSH Prompts:** This usually happens during the first connection to a GCP VM. Run this command once to generate keys and set defaults automatically:
   ```bash
   gcloud compute config-ssh --quiet
   ```
3. **Reset Terminal:** If the screen becomes garbled, type `reset` and press Enter.

## GoCD Management
To execute the server scripts or manage the workspace:

1. **Navigate to the folder:** `cd ~/gocd-server`
2. **Run the script:** `./Scripts/go.sh`

*Note: You do not need to reload the workspace with `code .` to run terminal scripts.*

## Deployment Status (GCP)
- **VM Name:** `gocd-deploy-target`

### 0. Initialize GCP Project (Required for new sessions)
If you see a "Project not set" error, run this command to point your CLI to the correct project:
```bash
gcloud config set project project-39c0ea08-238b-47b5-915
```

### Check Deployment Logs
Confirm if your containers are running on the remote VM via CLI:
```bash
gcloud compute ssh gocd-deploy-target --zone=us-west1-b --command="docker ps"
```

## Verification & UI Access

### 1. Accessing the GoCD Server UI
The GoCD server runs inside your Cloud Shell instance. To view the dashboard in your browser:
1. Locate the **Web Preview** icon at the top right of the Cloud Shell terminal window.
2. Click **Change port**.
3. Type `8153` and click **Change and Preview**.

*If you see "Unable to forward request", run `docker ps` to verify the gocd-server container is active.*

### 2. Checking the GCP VM Public IP
To verify your deployed application on the `gocd-deploy-target`, retrieve its external IP address with this command:
```bash
gcloud compute instances describe gocd-deploy-target \
    --zone=us-west1-b \
    --format='get(networkInterfaces[0].accessConfigs[0].externalIp)'
```
**Note:** Once you have the IP, access your app in the browser using the format `http://[EXTERNAL_IP]:[PORT]` (e.g., `http://34.x.x.x:9292`).
gcloud compute ssh badminton-court-vm --zone=us-central1-a --command="docker ps"
```