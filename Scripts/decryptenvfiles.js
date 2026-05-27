// Scripts/decryptenvfiles.js
// Decrypt .env files encrypted with AES-256-GCM (Node crypto).
// Uses envfiles.json to know which files to decrypt.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

// ---------- Confirmation helper ----------
function askConfirmation() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question('Are you sure you want to proceed with decryption? (type "yes"): ', answer => {
            rl.close();
            resolve(answer.trim() === 'yes');
        });
    });
}

// ------------------------------------------------------------------
// 1. Read the list of files to decrypt from envfiles.json
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
        if (fs.existsSync(path.join(__dirname, 'env.passphrase.txt'))) {
            return fs.readFileSync(path.join(__dirname, 'env.passphrase.txt'), 'utf8').trim();
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
async function decryptEnvFiles() {
    console.log('
=== Starting Decryption Process (AES-256-GCM) ===
');

    if (!(await askConfirmation())) {
        console.log('Decryption aborted.');
        process.exit(0);
    }

    const passphrase = getPassphrase();
    console.log(`✓ Passphrase retrieved (length: ${passphrase.length})`);

    const envFiles = getEnvFiles();
    console.log(`Files to decrypt (${envFiles.length}): ${envFiles.join(', ')}
`);

    let successCount = 0;
    let failCount = 0;

    envFiles.forEach(file => {
        const outputFile = path.resolve(__dirname, '..', file);
        const encryptedFile = path.join(path.dirname(outputFile), '.e' + path.basename(file) + '.enc');
        
        console.log(`--- Processing: ${file} ---`);

        if (!fs.existsSync(encryptedFile)) {
            console.warn(`⚠ Encrypted file ${encryptedFile} not found. Skipping.`);
            return;
        }

        try {
            decryptFile(encryptedFile, outputFile, passphrase);
            console.log(`✓ Decrypted to ${outputFile}`);
            successCount++;
        } catch (error) {
            console.error(`✗ Failed to decrypt ${file}: ${error.message}`);
            failCount++;
        }
    });

    console.log(`
=== Decryption Summary ===`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);

    if (failCount > 0) process.exit(1);
}

decryptEnvFiles();
