// Scripts/decryptenvfiles.js
// Decrypt .env files

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getPassphrase() {
  try {
    if (fs.existsSync('env.passphrase.txt')) {
      return fs.readFileSync('env.passphrase.txt', 'utf8').trim();
    } else {
      // Fallback to getting from GitHub variable
      return execSync('node Scripts/get-gh-variable.js', { encoding: 'utf8' }).trim();
    }
  } catch (error) {
    console.error('ERROR: Failed to get passphrase:', error.message);
    process.exit(1);
  }
}

function decryptEnvFile(encryptedFile, outputFile = null) {
  const passphrase = getPassphrase();
  console.log(`Using passphrase: ${passphrase}`);
  
  if (!fs.existsSync(encryptedFile)) {
    console.error(`Encrypted file not found: ${encryptedFile}`);
    return;
  }
  
  if (!outputFile) {
    // Remove the .e prefix to get the original filename
    outputFile = encryptedFile.replace(/^\.e/, '');
  }
  
  console.log(`Decrypting ${encryptedFile} to ${outputFile}...`);
  
  try {
    execSync(`gpg --batch --yes --pinentry-mode loopback --passphrase ${passphrase} -o ${outputFile} -d ${encryptedFile}`, { stdio: 'pipe' });
    
    if (fs.existsSync(outputFile)) {
      console.log(`Decrypted successfully: ${outputFile}`);
    } else {
      console.warn(`Failed to decrypt: ${encryptedFile}`);
    }
  } catch (error) {
    console.error(`ERROR: Failed to decrypt ${encryptedFile}:`, error.message);
  }
}

// Decrypt the files
decryptEnvFile('.e.env.dev.gpg', '.env.dev');
decryptEnvFile('.e.env.docker.gpg', '.env.docker');
decryptEnvFile('.e.env.staging.gpg', '.env.staging');
decryptEnvFile('.e.env.production.gpg', '.env.production');
// decryptEnvFile('.e.cypress.env.json.gpg', 'cypress.env.json');

// Clear the plain text passphrase from memory
const passphrase = null;