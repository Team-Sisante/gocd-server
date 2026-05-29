// Scripts/decryptenvfiles.js
// Decrypt .env files encrypted with AES-256-GCM (Node crypto).
// Uses envfiles.json to know which files to decrypt.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ------------------------------------------------------------------
// 1. Read the list of files to decrypt from envfiles.json (same as encryption)
// ------------------------------------------------------------------
function getEnvFiles() {
    const listPath = path.join(__dirname, 'envfiles.json');
    if (!fs.existsSync(listPath)) {
        console.error('ERROR: envfiles.json not found at', listPath);
        process.exit(1);
    }
    try {
        const data = JSON.parse(fs.readFileSync(listPath, 'utf8'));
        const files = Array.isArray(data) ? data : (data.files || []);
        if (files.length === 0) {
            console.error('ERROR: envfiles.json contains no files.');
            process.exit(1);
        }
        return files;
    } catch (e) {
        console.error('ERROR: Failed to parse envfiles.json:', e.message);
        process.exit(1);
    }
}

// ------------------------------------------------------------------
// 2. Retrieve the passphrase (same logic as before)
// ------------------------------------------------------------------
function getPassphrase() {
    try {
        if (fs.existsSync('env.passphrase.txt')) {
            return fs.readFileSync('env.passphrase.txt', 'utf8').trim();
        } else {
            // Fallback to getting from GitHub variable
            const scriptPath = path.join(__dirname, 'get-gh-variable.js');
            const result = execFileSync('node', [scriptPath], {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return result.trim();
        }
    } catch (error) {
        console.error('ERROR: Failed to get passphrase:', error.message);
        
        // Check if this is a GitHub authentication error
        const errorOutput = (error.stderr || error.stdout || error.message || '').toString();
        if (errorOutput.includes('HTTP 401') || errorOutput.includes('Bad credentials')) {
            console.error('\x1b[31m');
            console.error('========================================');
            console.error('GITHUB AUTHENTICATION ERROR');
            console.error('========================================\x1b[0m');
            console.error('Your GitHub credentials are invalid or expired.');
            console.error('Please run menu option \x1b[36m13.17\x1b[0m to fix your GITHUB_TOKEN.');
            console.error('');
            console.error('Recommended option: \x1b[36m13.17 option 2\x1b[0m (gh auth login)');
            console.error('This will authenticate via GitHub CLI and verify your credentials.');
            console.error('');
            console.error('Alternative option: \x1b[36m13.17 option 1\x1b[0m (manual)');
            console.error('This will read GITHUB_TOKEN from your .env file and set it automatically.');
        }
        
        process.exit(1);
    }
}

// ------------------------------------------------------------------
// 3. Decrypt a file encrypted with the format:
//    [salt (16)] [iv (12)] [authTag (16)] [ciphertext]
// ------------------------------------------------------------------
function decryptFile(encryptedFile, outputFile, passphrase) {
    const input = fs.readFileSync(encryptedFile);
    if (input.length < 44) {
        throw new Error('File too short to contain valid encryption data');
    }

    const salt = input.slice(0, 16);
    const iv = input.slice(16, 28);
    const authTag = input.slice(28, 44);
    const ciphertext = input.slice(44);

    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    fs.writeFileSync(outputFile, decrypted);
}

// ------------------------------------------------------------------
// 4. Main decryption process
// ------------------------------------------------------------------
function decryptEnvFiles() {
    console.log('\n=== Starting Decryption Process (AES-256-GCM) ===\n');

    const passphrase = getPassphrase();
    console.log(`✓ Passphrase retrieved (length: ${passphrase.length})`);

    const envFiles = getEnvFiles();
    console.log(`Files to decrypt (${envFiles.length}): ${envFiles.join(', ')}\n`);

    let successCount = 0;
    let failCount = 0;

    envFiles.forEach(baseName => {
        const encryptedFile = `.e${baseName}.enc`;   // matches encryption output
        console.log(`--- Processing: ${baseName} ---`);

        if (!fs.existsSync(encryptedFile)) {
            console.warn(`⚠ Encrypted file ${encryptedFile} not found. Skipping.`);
            return;
        }

        try {
            decryptFile(encryptedFile, baseName, passphrase);
            console.log(`✓ Decrypted to ${baseName}`);
            successCount++;
        } catch (error) {
            console.error(`✗ Failed to decrypt ${baseName}: ${error.message}`);
            failCount++;
        }
    });

    console.log(`\n=== Decryption Summary ===`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);

    if (failCount > 0) process.exit(1);
}

decryptEnvFiles();