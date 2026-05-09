#!/bin/bash
set -e

# Configuration
AGENT_HOSTNAME="agent-1"
PIPELINE_NAME="badminton_court"
RESOURCE_NAME="docker"
GOCD_URL="https://localhost:8154/go"
API_URL="${GOCD_URL}/api"

# Check if admin password is set
if [ -z "$GOCD_ADMIN_PASSWORD" ]; then
    echo "ERROR: GOCD_ADMIN_PASSWORD environment variable not set."
    exit 1
fi

echo "===================================================================================="
echo "GoCD Environment Validation"
echo "===================================================================================="

# 0. Check Container Existence
if ! docker ps --format '{{.Names}}' | grep -q "^gocd-server$"; then
    echo "   ❌ ERROR: gocd-server container is not running. Please run Scripts/go.sh first."
    exit 1
fi

# 1. Check Agent Status
echo "1. Checking for agent '${AGENT_HOSTNAME}'..."
AGENT_STATE=$(curl -s -k -u "admin:${GOCD_ADMIN_PASSWORD}" "${API_URL}/agents" | jq -r ".agents[] | select(.hostname==\"${AGENT_HOSTNAME}\") | .agent_config_state" 2>/dev/null)
if [ "$AGENT_STATE" == "Enabled" ]; then
    echo "   ✅ Agent '${AGENT_HOSTNAME}' is registered and enabled."
else
    echo "   ❌ Agent '${AGENT_HOSTNAME}' not found or not enabled. State: ${AGENT_STATE:-"Not Found"}"
    exit 1
fi

# 2. Check Pipeline Existence
echo "2. Checking for pipeline '${PIPELINE_NAME}'..."
PIPELINE_EXISTS=$(curl -s -k -u "admin:${GOCD_ADMIN_PASSWORD}" "${API_URL}/config/pipelines" | jq -r ".groups[].pipelines[] | select(.name==\"${PIPELINE_NAME}\") | .name" 2>/dev/null)
if [ "$PIPELINE_EXISTS" == "$PIPELINE_NAME" ]; then
    echo "   ✅ Pipeline '${PIPELINE_NAME}' exists."
else
    echo "   ❌ Pipeline '${PIPELINE_NAME}' not found."
    exit 1
fi

# 3. Check Pipeline-Agent Resource Assignment
echo "3. Checking if pipeline '${PIPELINE_NAME}' is assigned to an agent with resource '${RESOURCE_NAME}'..."
ASSIGNED_RESOURCE=$(curl -s -k -u "admin:${GOCD_ADMIN_PASSWORD}" "${API_URL}/config/pipelines/${PIPELINE_NAME}" | jq -r ".stages[].jobs[].resources[]? | select(.==\"${RESOURCE_NAME}\")" 2>/dev/null)
if [ "$ASSIGNED_RESOURCE" == "$RESOURCE_NAME" ]; then
    echo "   ✅ Pipeline '${PIPELINE_NAME}' requires resource '${RESOURCE_NAME}'."
else
    echo "   ❌ Pipeline '${PIPELINE_NAME}' is not configured to use resource '${RESOURCE_NAME}'."
    exit 1
fi

# 4. Check Last Pipeline Run Status
echo "4. Checking last run status of pipeline '${PIPELINE_NAME}'..."
PIPELINE_STATUS=$(curl -s -k -u "admin:${GOCD_ADMIN_PASSWORD}" "${API_URL}/pipelines/${PIPELINE_NAME}/history" | jq -r '.pipelines[0].stages[-1].result' 2>/dev/null)
if [ "$PIPELINE_STATUS" == "Passed" ]; then
    echo "   ✅ Last deployment of '${PIPELINE_NAME}' succeeded."
elif [ "$PIPELINE_STATUS" == "Failed" ]; then
    echo "   ❌ Last deployment of '${PIPELINE_NAME}' failed."
    exit 1
else
    echo "   ⚠️ Pipeline '${PIPELINE_NAME}' status: ${PIPELINE_STATUS:-"No history found"}"
fi

echo "===================================================================================="
echo "✅ All checks passed! The environment is configured correctly."
echo "===================================================================================="