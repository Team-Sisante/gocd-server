# install-node-options-fix.ps1
# Installs a Windows Service that permanently deletes NODE_OPTIONS.
# Run once as Administrator.

$serviceName = "NodeOptionsFixer"

# Stop and remove any existing instance
if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Write-Host "Stopping existing service..." -ForegroundColor Yellow
    Stop-Service $serviceName -Force
    sc.exe delete $serviceName
    Start-Sleep -Seconds 2
}

# Define the C# code for the service
$csharp = @"
using System;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

public class NodeOptionsFixer : ServiceBase
{
    private Timer timer;

    public NodeOptionsFixer()
    {
        this.ServiceName = "$serviceName";
        this.CanStop = true;
        this.CanPauseAndContinue = false;
        this.AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        // Poll every 10 seconds
        timer = new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromSeconds(10));
    }

    protected override void OnStop()
    {
        timer?.Change(Timeout.Infinite, Timeout.Infinite);
        timer?.Dispose();
    }

    private void DoWork(object state)
    {
        try
        {
            // Remove from User environment (Current User)
            using (var key = Registry.CurrentUser.OpenSubKey("Environment", writable: true))
            {
                if (key != null && key.GetValue("NODE_OPTIONS") != null)
                {
                    key.DeleteValue("NODE_OPTIONS", throwOnMissingValue: false);
                }
            }

            // Remove from Machine/System environment (all users)
            using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", writable: true))
            {
                if (key != null && key.GetValue("NODE_OPTIONS") != null)
                {
                    key.DeleteValue("NODE_OPTIONS", throwOnMissingValue: false);
                }
            }
        }
        catch { /* ignore transient errors */ }
    }
}
"@

# Compile the C# code
Add-Type -TypeDefinition $csharp -ReferencedAssemblies "System.ServiceProcess"

# Install the service
Write-Host "Installing service '$serviceName'..." -ForegroundColor Cyan
$binPath = (Get-Command powershell).Source  # Path to PowerShell executable
# Install as a .NET service using sc.exe
sc.exe create $serviceName binPath= "`"$binPath`" -NoProfile -Command `"`$a = New-Object NodeOptionsFixer; [System.ServiceProcess.ServiceBase]::Run(`$a)`"" start= auto

# Start the service
Start-Service $serviceName

Write-Host "Service '$serviceName' installed and started." -ForegroundColor Green
Write-Host "NODE_OPTIONS will be permanently deleted on detection."
Write-Host "To uninstall: sc.exe stop $serviceName; sc.exe delete $serviceName" -ForegroundColor DarkYellow
pause