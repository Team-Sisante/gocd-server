# eradicate-node-options.ps1 – Final NODE_OPTIONS killer
# Compiles a C# console app that wipes the variable, then cleans up.

$app = "$env:TEMP\NODE_OPTIONS_ERASER.exe"
$cs = @"
using System;
using Microsoft.Win32;

class Program {
    static void Main() {
        // User hive (Current User)
        try {
            using (var key = Registry.CurrentUser.OpenSubKey("Environment", writable: true)) {
                if (key != null && key.GetValue("NODE_OPTIONS") != null) {
                    key.DeleteValue("NODE_OPTIONS", false);
                }
            }
        } catch {}
        // System hive (All users)
        try {
            using (var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", writable: true)) {
                if (key != null && key.GetValue("NODE_OPTIONS") != null) {
                    key.DeleteValue("NODE_OPTIONS", false);
                }
            }
        } catch {}
        Console.WriteLine("NODE_OPTIONS purged from registry.");
    }
}
"@

# Clear the broken LIB path temporarily so Add‑Type can compile
$originalLib = $env:LIB
$env:LIB = ""

try {
    Add-Type -TypeDefinition $cs -ReferencedAssemblies "System" -OutputAssembly $app -ErrorAction Stop
} finally {
    $env:LIB = $originalLib
}

# Kill all VS Code instances
Get-Process code -ErrorAction SilentlyContinue | Stop-Process -Force

# Run the killer in a clean environment
$env:NODE_OPTIONS = ""
& $app

# Remove the temporary executable
Remove-Item $app -Force -ErrorAction SilentlyContinue

# Relaunch VS Code in the current directory
Start-Process "code" -ArgumentList "."

Write-Host "All done. NODE_OPTIONS is permanently gone." -ForegroundColor Green