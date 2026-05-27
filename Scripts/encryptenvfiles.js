// Scripts/encryptenvfiles.js
// Encrypt .env files using AES-256-GCM (Node crypto).
// File list is read from `envfiles.json`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('readline');

// ---------- Confirmation helper ----------
function askConfirmation() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question('Are you sure you want to proceed with encryption? (type "yes"): ', answer => {
            rl.close();
            resolve(answer.trim() === 'yes');
        });
    });
}

// ------------------------------------------------------------------
// 1. Read the list of files to encrypt from envfiles.json
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
// 2. Retrieve the passphrase (same way as before)
// ------------------------------------------------------------------
function getPassphrase() {
    try {
        const scriptPath = path.join(__dirname, 'get-gh-variable.js');
        console.log(`Reading passphrase from: ${scriptPath}`);
        const result = execFileSync('node', [scriptPath], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return result.trim();
    } catch (error) {
        console.error('ERROR: Failed to get passphrase');
        console.error('Error message:', error.message);
        if (error.stderr) console.error('Stderr:', error.stderr.toString());
        if (error.stdout) console.error('Stdout:', error.stdout.toString());
        process.exit(1);
    }
}

// ------------------------------------------------------------------
// 3. Encrypt a file using AES-256-GCM
//    Output format: [salt (16 bytes)][iv (12 bytes)][authTag (16 bytes)][ciphertext]
// ------------------------------------------------------------------
function encryptFile(inputFile, outputFile, passphrase) {
    const salt = crypto.randomBytes(16);          // new salt each time
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const plaintext = fs.readFileSync(inputFile);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Concatenate: salt + iv + authTag + ciphertext
    const output = Buffer.concat([salt, iv, authTag, encrypted]);
    fs.writeFileSync(outputFile, output);
}

// ------------------------------------------------------------------
// 4. Main encryption process
// ------------------------------------------------------------------
async function encryptEnvFiles() {
    console.log('
=== Starting Encryption Process (AES-256-GCM) ===
');

    if (!(await askConfirmation())) {
        console.log('Encryption aborted.');
        process.exit(0);
    }

    const passphrase = getPassphrase();
    console.log(`✓ Passphrase retrieved (length: ${passphrase.length})`);

    const envFiles = getEnvFiles();
    console.log(`Files to encrypt (${envFiles.length}): ${envFiles.join(', ')}
`);

    let successCount = 0;
    let failCount = 0;

    envFiles.forEach(file => {
        const inputFile = path.resolve(__dirname, '..', file);
        console.log(`--- Processing: ${file} ---`);

        if (!fs.existsSync(inputFile)) {
            console.warn(`⚠ ${file} not found at ${inputFile}. Skipping.`);
            return;
        }

        console.log(`✓ File exists: ${inputFile}`);
        const targetFile = path.join(path.dirname(inputFile), '.e' + path.basename(file) + '.enc');

        try {
            encryptFile(inputFile, targetFile, passphrase);
            const stats = fs.statSync(targetFile);
            console.log(`✓ Encrypted -> ${targetFile} (${stats.size} bytes)`);
            successCount++;
        } catch (error) {
            console.error(`✗ Failed to encrypt ${file}: ${error.message}`);
            failCount++;
        }
    });

    // Save passphrase to file
    console.log(`
--- Saving Passphrase ---`);
    const passFile = 'env.passphrase.txt';
    try {
        fs.writeFileSync(path.join(__dirname, passFile), passphrase);
        console.log(`✓ Passphrase saved to ${passFile}`);
    } catch (error) {
        console.error(`✗ Failed to save passphrase: ${error.message}`);
    }

    console.log(`
=== Encryption Summary ===`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failCount}`);

    if (failCount > 0) process.exit(1);
}

encryptEnvFiles();
