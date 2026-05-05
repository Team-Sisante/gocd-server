# GoCD Management Menu Script
# This script provides a menu-driven interface for managing GoCD server and agent containers.
# It allows users to start, stop, and manage the GoCD environment.
# Ensure you have Docker and Docker Compose installed and running before using this script.
# Usage: Run this script in PowerShell to display the GoCD management menu.
# Scripts/gocd-menu.ps1

do {
    Clear-Host
    Write-Host "GoCD Management Menu" -ForegroundColor Green
    Write-Host "====================" -ForegroundColor Green
    Write-Host ""
    Write-Host "1. CONTAINER MANAGEMENT" -ForegroundColor Cyan
    Write-Host "   1.1. Update/Restart GoCD (Fast Build)" -ForegroundColor White
    Write-Host "   1.2. Get Docker container errors" -ForegroundColor White
    Write-Host "   1.3. Validate GoCD environment" -ForegroundColor White
    Write-Host "   1.4. View container logs" -ForegroundColor White
    Write-Host "   1.5. Stop all containers" -ForegroundColor White
    Write-Host "   1.6. SYSTEM HARD RESET (Full Wipe via go.ps1)" -ForegroundColor Red
    Write-Host ""
    Write-Host "2. PIPELINE MANAGEMENT" -ForegroundColor Cyan
    Write-Host "   2.1. Trigger badminton_court pipeline" -ForegroundColor White
    Write-Host "   2.2. View pipeline history" -ForegroundColor White
    Write-Host "   2.3. Unlock pipeline" -ForegroundColor White
    Write-Host ""
    Write-Host "3. AGENT MANAGEMENT" -ForegroundColor Cyan
    Write-Host "   3.1. View agent status" -ForegroundColor White
    Write-Host "   3.2. Enable agent" -ForegroundColor White
    Write-Host "   3.3. Disable agent" -ForegroundColor White
    Write-Host ""
    Write-Host "4. SYSTEM UTILITIES" -ForegroundColor Cyan
    Write-Host "   4.1. Encrypt .env files" -ForegroundColor White
    Write-Host "   4.2. Decrypt .env files" -ForegroundColor White
    Write-Host "   4.3. Open GoCD web interface" -ForegroundColor White
    Write-Host "   4.4. View system resources" -ForegroundColor White
    Write-Host "   4.5. Clean up Docker resources" -ForegroundColor White
    Write-Host "   4.6. Print Project Folder Structure" -ForegroundColor White
    Write-Host "   4.7. Sync Master with Feature Branch" -ForegroundColor White
    Write-Host "   4.8. Fix NODE_OPTIONS error" -ForegroundColor White
    Write-Host ""
    Write-Host "5. TROUBLE-SHOOT CONTAINERS" -ForegroundColor Cyan
    Write-Host "   5.1. Rebuild and Re-start gocd-server container" -ForegroundColor White
    Write-Host "   5.2. Rebuild and Re-start gocd-agent-1 container" -ForegroundColor White
    Write-Host "   5.3. Rebuild and Re-start gocd-agent-2 container" -ForegroundColor White
    Write-Host "   5.4. Rebuild and Re-start gocd-agent-3 container" -ForegroundColor White
    Write-Host "   5.5. View container logs" -ForegroundColor White
    Write-Host ""
    Write-Host "0. Exit" -ForegroundColor Red
    Write-Host ""

    $choice = Read-Host "Select an option (e.g., 1.1, 2.3, or 0 to exit)"

    switch ($choice) {
        # Container Management
        "1.1" { 
            docker compose build
            docker compose up -d
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "1.2" { 
            npm run geterror
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "1.3" { 
            npm run validate
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "1.4" { 
            $container = Read-Host "Enter container name (gocd-server/gocd-agent)"
            if ($container -eq "gocd-server" -or $container -eq "gocd-agent") {
                docker logs -f $container
            } else {
                Write-Host "Invalid container name. Please use 'gocd-server' or 'gocd-agent'." -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "1.5" { 
            Write-Host "Stopping all GoCD containers..." -ForegroundColor Yellow
            docker-compose down
            Write-Host "All containers stopped." -ForegroundColor Green
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "1.6" { 
            Write-Host "WARNING: Performing Full System Wipe..." -ForegroundColor Red
            npm run go
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }        
        
        # Pipeline Management
        "2.1" { 
            $pipeline = Read-Host "Enter pipeline name (default: badminton_court)"
            if ([string]::IsNullOrWhiteSpace($pipeline)) {
                $pipeline = "badminton_court"
            }
            Write-Host "Triggering pipeline: $pipeline" -ForegroundColor Yellow
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:8153/go/api/pipelines/$pipeline/schedule" -Method POST -Headers @{"Confirm"="true"} -ErrorAction Stop
                Write-Host "Pipeline triggered successfully." -ForegroundColor Green
            } catch {
                Write-Host "Failed to trigger pipeline: $_" -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "2.2" { 
            $pipeline = Read-Host "Enter pipeline name (default: badminton_court)"
            if ([string]::IsNullOrWhiteSpace($pipeline)) {
                $pipeline = "badminton_court"
            }
            Write-Host "Opening pipeline history for: $pipeline" -ForegroundColor Yellow
            Start-Process "http://localhost:8153/go/pipelines/$pipeline"
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "2.3" { 
            $pipeline = Read-Host "Enter pipeline name (default: badminton_court)"
            if ([string]::IsNullOrWhiteSpace($pipeline)) {
                $pipeline = "badminton_court"
            }
            Write-Host "Unlocking pipeline: $pipeline" -ForegroundColor Yellow
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:8153/go/api/pipelines/$pipeline/unlock" -Method POST -Headers @{"Confirm"="true"} -ErrorAction Stop
                Write-Host "Pipeline unlocked successfully." -ForegroundColor Green
            } catch {
                Write-Host "Failed to unlock pipeline: $_" -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        
        # Agent Management
        "3.1" { 
            Write-Host "Agent status:" -ForegroundColor Yellow
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:8153/go/api/agents" -UseBasicParsing | ConvertFrom-Json
                $response | Select-Object hostname, agent_state, build_state | Format-Table
            } catch {
                Write-Host "Failed to get agent status: $_" -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "3.2" { 
            $agent = Read-Host "Enter agent UUID (leave blank for agent-1)"
            if ([string]::IsNullOrWhiteSpace($agent)) {
                $agent = "agent-1"
            }
            Write-Host "Enabling agent: $agent" -ForegroundColor Yellow
            try {
                $body = '{"agent_state":"Enabled"}' | ConvertTo-Json
                $response = Invoke-WebRequest -Uri "http://localhost:8153/go/api/agents/$agent" -Method PATCH -Body $body -ContentType "application/json" -Headers @{"Accept"="application/vnd.go.cd.v1+json"} -ErrorAction Stop
                Write-Host "Agent enabled successfully." -ForegroundColor Green
            } catch {
                Write-Host "Failed to enable agent: $_" -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "3.3" { 
            $agent = Read-Host "Enter agent UUID (leave blank for agent-1)"
            if ([string]::IsNullOrWhiteSpace($agent)) {
                $agent = "agent-1"
            }
            Write-Host "Disabling agent: $agent" -ForegroundColor Yellow
            try {
                $body = '{"agent_state":"Disabled"}' | ConvertTo-Json
                $response = Invoke-WebRequest -Uri "http://localhost:8153/go/api/agents/$agent" -Method PATCH -Body $body -ContentType "application/json" -Headers @{"Accept"="application/vnd.go.cd.v1+json"} -ErrorAction Stop
                Write-Host "Agent disabled successfully." -ForegroundColor Green
            } catch {
                Write-Host "Failed to disable agent: $_" -ForegroundColor Red
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        
        # System Utilities
        "4.1" { 
            Write-Host "Enrcrypt .env files..." -ForegroundColor Yellow
            npm run encryptenvfiles
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.2" { 
            Write-Host "Decrypt .env files..." -ForegroundColor Yellow
            npm run decryptenvfiles
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.3" { 
            Write-Host "Opening GoCD web interface..." -ForegroundColor Yellow
            Start-Process "http://localhost:8153/go"
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.4" { 
            Write-Host "System resources:" -ForegroundColor Yellow
            docker stats --no-stream
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.5" { 
            Write-Host "Cleaning up Docker resources..." -ForegroundColor Yellow
            docker system prune -f
            Write-Host "Cleanup completed." -ForegroundColor Green
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.6" { 
            pnpm run pfs
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "4.7" { 
            $featureBranch = Read-Host "Enter feature branch name to sync with master (e.g., 'my-feature')"
            if ([string]::IsNullOrWhiteSpace($featureBranch)) {
                Write-Host "Feature branch name cannot be empty." -ForegroundColor Red
            } else {
                npm run master-feature-git-sync -- -FeatureBranch $featureBranch
            }
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }

        "4.8" { 
            Write-Host "   4.8. Fix NODE_OPTIONS error" -ForegroundColor White
            Remove-Item Env:\NODE_OPTIONS
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        
        # Troubleshoot Containers
        "5.1" { 
            Write-Host "Rebuilding and starting gocd-server container..." -ForegroundColor Yellow
            docker-compose build gocd-server        # rebuilds only gocd-server, uses cache
            docker-compose up -d gocd-server        # restarts it
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "5.2" { 
            Write-Host "Rebuilding and starting gocd-agent-1 container..." -ForegroundColor Yellow
            docker-compose build --no-cache gocd-agent-1   # forced rebuild to use new mirror
            docker-compose up -d gocd-agent-1        # restarts it
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "5.3" { 
            Write-Host "Rebuilding and starting gocd-agent-2 container..." -ForegroundColor Yellow
            docker-compose build --no-cache gocd-agent-2   # forced rebuild to use new mirror
            docker-compose up -d gocd-agent-2        # restarts it
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "5.4" { 
            Write-Host "Rebuilding and starting gocd-agent-3 container..." -ForegroundColor Yellow
            docker-compose build --no-cache gocd-agent-3   # forced rebuild to use new mirror
            docker-compose up -d gocd-agent-3        # restarts it
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
        "5.5" { 
            Write-Host "Viewing container logs..." -ForegroundColor Yellow
            docker-compose logs gocd-server
            Write-Host "Press Enter to continue..." -ForegroundColor Yellow
            Read-Host
        }
         
        "0" { 
            Write-Host "Exiting..." -ForegroundColor Green
            exit
        }
        default { 
            Write-Host "Invalid option. Press Enter to continue..." -ForegroundColor Red
            Read-Host
        }
    }
} while ($choice -ne "0")