// Scripts/encryptenvfiles.js
// Encrypt .env files with proper error handling and debugging

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getPassphrase() {
  try {
    // Use Scripts (capital S) to match Windows folder name
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

function encryptEnvFiles() {
  console.log('\n=== Starting Encryption Process ===\n');
  
  // Get passphrase
  const passphrase = getPassphrase();
  console.log(`✓ Passphrase retrieved (length: ${passphrase.length})`);
  
  // Check if gpg is available
  try {
    execFileSync('gpg', ['--version'], { stdio: 'pipe' });
    console.log('✓ GPG is available\n');
  } catch (error) {
    console.error('ERROR: GPG is not installed or not in PATH');
    process.exit(1);
  }
  
  const envFiles = [
    '.env.dev',
    '.env.docker',
    '.env.staging',
    '.env.production',
    // 'cypress.env.json'
  ];

  let successCount = 0;
  let failCount = 0;

  envFiles.forEach(file => {
    console.log(`\n--- Processing: ${file} ---`);
    
    if (!fs.existsSync(file)) {
      console.warn(`⚠ ${file} not found. Skipping.`);
      return;
    }
    
    console.log(`✓ File exists: ${file}`);
    
    const gpgOutputFile = `${file}.gpg`;
    const targetFile = `.e${file}.gpg`;
    
    console.log(`  Expected GPG output: ${gpgOutputFile}`);
    console.log(`  Final target: ${targetFile}`);
    
    // Clean up existing files
    if (fs.existsSync(gpgOutputFile)) {
      console.log(`  Removing existing ${gpgOutputFile}`);
      fs.unlinkSync(gpgOutputFile);
    }
    if (fs.existsSync(targetFile)) {
      console.log(`  Removing existing ${targetFile}`);
      fs.unlinkSync(targetFile);
    }
    
    try {
      console.log(`  Encrypting...`);
      
      // Use spawnSync for better debugging
      const result = spawnSync('gpg', [
        '--batch',
        '--yes',
        '--pinentry-mode', 'loopback',
        '--passphrase', passphrase,
        '-c',
        file
      ], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      if (result.error) {
        throw new Error(`Spawn error: ${result.error.message}`);
      }
      
      if (result.status !== 0) {
        console.error(`  ✗ GPG exited with code ${result.status}`);
        if (result.stdout) console.error(`  Stdout: ${result.stdout}`);
        if (result.stderr) console.error(`  Stderr: ${result.stderr}`);
        failCount++;
        return;
      }
      
      // Show any output
      if (result.stdout) console.log(`  GPG stdout: ${result.stdout.trim()}`);
      if (result.stderr) console.log(`  GPG stderr: ${result.stderr.trim()}`);
      
      // Check for output file
      console.log(`  Checking for output file...`);
      if (fs.existsSync(gpgOutputFile)) {
        console.log(`  ✓ Found ${gpgOutputFile}`);
        
        // Get file size for verification
        const stats = fs.statSync(gpgOutputFile);
        console.log(`  File size: ${stats.size} bytes`);
        
        // Rename to target
        fs.renameSync(gpgOutputFile, targetFile);
        console.log(`  ✓ Renamed to ${targetFile}`);
        console.log(`✓ Successfully encrypted: ${file} → ${targetFile}`);
        successCount++;
      } else {
        console.error(`  ✗ GPG output file not found: ${gpgOutputFile}`);
        console.log(`  Current directory contents:`);
        const files = fs.readdirSync('.').filter(f => f.includes(file));
        files.forEach(f => console.log(`    - ${f}`));
        failCount++;
      }
    } catch (error) {
      console.error(`  ✗ ERROR: Failed to encrypt ${file}`);
      console.error(`  Error message: ${error.message}`);
      if (error.stderr) console.error(`  Stderr: ${error.stderr}`);
      if (error.stdout) console.error(`  Stdout: ${error.stdout}`);
      failCount++;
    }
  });

  // Save passphrase to file
  console.log(`\n--- Saving Passphrase ---`);
  const passFile = 'env.passphrase.txt';
  try {
    fs.writeFileSync(passFile, passphrase);
    console.log(`✓ Passphrase saved to ${passFile}`);
  } catch (error) {
    console.error(`✗ Failed to save passphrase: ${error.message}`);
  }
  
  // Summary
  console.log(`\n=== Encryption Summary ===`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`\n⚠ Keep ${passFile} safe!`);
}

encryptEnvFiles();