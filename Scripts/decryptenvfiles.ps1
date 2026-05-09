<#=====================================================
 To run:

       & "C:\repo\gocd-server\Scripts\decryptenvfiles.ps1"

   Or

       .\Scripts\decryptenvfiles.ps1
=====================================================#>
function DecryptEnvFile {
    param (
        [string]$encryptedFile,
        [string]$outputFile = $null 
    )

    $passphrase = ./Scripts/get-gh-variable.ps1 
    
    if ([string]::IsNullOrWhiteSpace($passphrase)) {
        Write-Error "Could not retrieve decryption passphrase. Aborting."
        return
    }

    Write-Host "Using passphrase: [REDACTED]"
    if (-not (Test-Path $encryptedFile)) {
        Write-Error "Encrypted file not found: $encryptedFile"
        return
    }

    if (-not $outputFile) {
        $outputFile = [System.IO.Path]::GetFileNameWithoutExtension($encryptedFile)
    }

    Write-Host "Decrypting $encryptedFile to $outputFile..."

    & gpg --batch --yes --pinentry-mode loopback --passphrase $passphrase -o $outputFile -d $encryptedFile

    if (Test-Path $outputFile) {
        Write-Host "Decrypted successfully: $outputFile"
    } else {
        Write-Warning "Failed to decrypt: $encryptedFile"
    }

    # Clear the plain text passphrase from memory
    $passphrase = $null
}

#DecryptEnvFile -encryptedFile ".e.env.dev.gpg" ".env.dev"
DecryptEnvFile -encryptedFile ".e.env.docker.gpg" ".env.docker"
# DecryptEnvFile -encryptedFile ".e.cypress.env.json.gpg" ".cypress.env.json"