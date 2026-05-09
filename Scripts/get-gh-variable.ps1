<# Scripts/get-gh-variable.ps1
 =================================================================================
 To run:
    & "C:\repo\gocd-server\Scripts\get-gh-variable.ps1"  

 Or
    .\Scripts\get-gh-variable.ps1  
 =================================================================================#>

param (
    [string]$Repo = "xmione/gocd-server",
    [string]$VariableName = "ENV_ENCRYPTION_KEY"
)

# Check for GH_TOKEN or authentication status
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0 -and -not $env:GH_TOKEN) {
    Write-Error "GitHub CLI (gh) is not authenticated. Please run 'gh auth login' or set the 'GH_TOKEN' environment variable temporarily."
    return $null
}

$variable = gh variable list --repo $repo --json name,value | ConvertFrom-Json | Where-Object { $_.name -eq $variableName }

if ($variable) {
    Write-Host "[OK] $($variable.name) = $($variable.value)"
    Write-Host "[OK] Retrieved GitHub variable '$VariableName' from repository '$Repo'."
    return $variable.value
} else {
    Write-Error "Variable '$variableName' not found in '$repo'."
    return $null
}