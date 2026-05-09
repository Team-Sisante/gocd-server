#!/bin/bash

# Define the default project ID from your environment setup.
# This will be used to name or identify your primary tmux session.
DEFAULT_PROJECT_ID="project-39c0ea08-238b-47b5-915"
TMUX_PROJECT_SESSION_NAME="gcp-${DEFAULT_PROJECT_ID}"

echo "What do you want to do?"
PS3='Please enter your choice: '
options=("Start/Attach to Project Session" "Kill a specific tmux session" "Kill all tmux sessions" "Detach from current session" "Exit")

select opt in "${options[@]}"
do
    case $opt in
        "Start/Attach to Project Session")
            echo "Attempting to start or attach to tmux session for project: $DEFAULT_PROJECT_ID (session name: $TMUX_PROJECT_SESSION_NAME)"
            # Check if a session with the dedicated name already exists
            if tmux has-session -t "$TMUX_PROJECT_SESSION_NAME" 2>/dev/null; then
                echo "Attaching to existing tmux session: $TMUX_PROJECT_SESSION_NAME"
                # Ensure the project is set in the existing session
                tmux send-keys -t "$TMUX_PROJECT_SESSION_NAME" "gcloud config set project $DEFAULT_PROJECT_ID && clear" C-m
                tmux attach-session -t "$TMUX_PROJECT_SESSION_NAME"
            else
                echo "Creating new tmux session: $TMUX_PROJECT_SESSION_NAME"
                # Create detached, initialize the project environment, then attach
                tmux new-session -d -s "$TMUX_PROJECT_SESSION_NAME"
                tmux send-keys -t "$TMUX_PROJECT_SESSION_NAME" "gcloud config set project $DEFAULT_PROJECT_ID && clear" C-m
                tmux attach-session -t "$TMUX_PROJECT_SESSION_NAME"
            fi
            break
            ;;
        "Kill a specific tmux session")
            echo "Listing active tmux sessions:"
            tmux ls
            read -p "Enter the session name or ID to kill (e.g., '0' or 'my_session'): " SESSION_TO_KILL
            if [ -n "$SESSION_TO_KILL" ]; then
                tmux kill-session -t "$SESSION_TO_KILL"
                echo "Session '$SESSION_TO_KILL' killed."
            else
                echo "No session specified. Aborting."
            fi
            break
            ;;
        "Kill all tmux sessions")
            read -p "Are you sure you want to kill ALL tmux sessions? (y/N): " CONFIRM_KILL_ALL
            if [[ "$CONFIRM_KILL_ALL" =~ ^[Yy]$ ]]; then
                tmux kill-server
                echo "All tmux sessions killed."
            else
                echo "Aborting kill all sessions."
            fi
            break
            ;;
        "Detach from current session")
            echo "Detaching from current tmux session..."
            tmux detach
            break
            ;;
        "Exit")
            echo "Exiting."
            break
            ;;
        *) echo "Invalid option $REPLY";;
    esac
done