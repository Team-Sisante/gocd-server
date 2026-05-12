#!/usr/bin/env node
/**
 * fix-node-options.js – Permanently removes NODE_OPTIONS.
 * Cleans registry/profiles, then kills VS Code to remove locked storage,
 * and restarts the editor automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

const WARN = '\x1b[33m%s\x1b[0m';
const OK   = '\x1b[32m%s\x1b[0m';
const ERR  = '\x1b[31m%s\x1b[0m';
function log(msg, style = OK) { console.log(style, msg); }

function run(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' }).trim();
  } catch { return null; }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`\x1b[33m${question}\x1b[0m`, answer => {
    rl.close();
    resolve(answer.trim().toLowerCase());
  }));
}

// ---------- Registry / profile cleanup (safe while VS Code is open) ----------
function removeRegistryVar(scope) {
  const key = scope === 'HKCU'
    ? 'HKCU\\Environment'
    : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
  try { run(`reg delete "${key}" /v NODE_OPTIONS /f`, true); log(`Removed from ${scope === 'HKCU' ? 'User' : 'System'} registry.`); } catch { /* ignore */ }
}

function clearEnvironmentVarWindows() {
  run(`powershell -Command "[System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'User')"`, true);
  run(`powershell -Command "[System.Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Machine')"`, true);
}

function findPowerShellProfile() {
  const home = os.homedir();
  const candidates = [
    `${home}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`,
    `${home}\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1`,
    `${home}\\Documents\\WindowsPowerShell\\Profile.ps1`,
    `${home}\\Documents\\PowerShell\\Profile.ps1`
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

function ensureUnsetInProfile(profilePath) {
  const line = 'Remove-Item Env:\\NODE_OPTIONS -ErrorAction SilentlyContinue';
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  if (!content.includes('Remove-Item Env:\\NODE_OPTIONS')) {
    content += '\n# Auto‑unset NODE_OPTIONS (fix for Electron errors)\n' + line + '\n';
    fs.writeFileSync(profilePath, content, 'utf8');
    log(`Added unset line to ${profilePath}`);
  }
  // comment out old assignments
  const regex = /^\s*(?:\$env:NODE_OPTIONS\s*=|set\s+NODE_OPTIONS\s*=)/mi;
  let changed = false;
  content = content.split('\n').map(l => {
    if (regex.test(l) && !l.includes('# [FIXED]')) { changed = true; return `# [FIXED] ${l}`; }
    return l;
  }).join('\n');
  if (changed) { fs.writeFileSync(profilePath, content, 'utf8'); log('Commented out old assignments.'); }
}

// ---------- VS Code storage cleanup (must be done while VS Code is CLOSED) ----------
function cleanVSCodeStorage() {
  const home = os.homedir();
  const root = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
  if (!fs.existsSync(root)) { log('VS Code workspaceStorage not found.', WARN); return; }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    const bootloader = path.join(full, 'ms-vscode.js-debug', 'bootloader.js');
    if (fs.existsSync(bootloader)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        log(`Removed workspace storage: ${entry.name}`);
        removed++;
      } catch (e) {
        log(`Could not remove ${entry.name} (${e.message}). It will be removed after restart.`, WARN);
      }
    }
  }
  if (removed === 0) log('No offending bootloader found in storage.', WARN);
}

async function killAndRestartVSCodeWindows() {
  const answer = await ask('This fix requires closing VS Code. Continue? (y/N): ');
  if (answer !== 'y') {
    log('Please close VS Code completely and reopen it manually for the fix to take effect.');
    return;
  }

  log('Killing VS Code processes...');
  run('taskkill /F /IM code.exe 2>nul', true);
  // Allow processes to fully terminate
  await new Promise(r => setTimeout(r, 3000));

  // Now safe to delete storage
  cleanVSCodeStorage();

  // Restart VS Code
  const cwd = process.cwd();
  const codePath = `"${path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd')}"`;
  log('Launching VS Code...');
  spawn('cmd', ['/c', `start "" ${codePath} ${cwd}`], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 3000));
  log('VS Code has been restarted. The NODE_OPTIONS error should be gone.');
}

// ---------- Unix (macOS/Linux) ----------
function findUnixProfile() {
  const home = os.homedir();
  const shell = process.env.SHELL || '/bin/bash';
  const name = path.basename(shell);
  if (name === 'zsh') return `${home}/.zshrc`;
  if (name === 'bash') return `${home}/.bashrc`;
  return `${home}/.profile`;
}

function ensureUnixUnset(profilePath) {
  const line = 'unset NODE_OPTIONS';
  let content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  if (!content.includes('unset NODE_OPTIONS')) {
    content += '\n# Auto‑unset NODE_OPTIONS\n' + line + '\n';
    fs.writeFileSync(profilePath, content, 'utf8');
    log(`Added unset to ${profilePath}`);
  }
  const regex = /^\s*export\s+NODE_OPTIONS\s*=/mi;
  let changed = false;
  content = content.split('\n').map(l => {
    if (regex.test(l) && !l.startsWith('# [FIXED]')) { changed = true; return `# [FIXED] ${l}`; }
    return l;
  }).join('\n');
  if (changed) { fs.writeFileSync(profilePath, content, 'utf8'); log('Commented out old exports.'); }
}

async function killAndRestartVSCodeUnix() {
  const answer = await ask('This fix requires closing VS Code. Continue? (y/N): ');
  if (answer !== 'y') {
    log('Please close VS Code completely and reopen it manually.');
    return;
  }
  run('pkill -f "Code"', true);
  await new Promise(r => setTimeout(r, 2000));
  // clean storage (safe now)
  const home = os.homedir();
  const root = path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
  }
  // restart
  spawn('code', [process.cwd()], { detached: true, stdio: 'ignore' });
  log('VS Code has been restarted.');
}

// ---------- Main ----------
async function main() {
  const platform = os.platform();
  log(`Permanently fixing NODE_OPTIONS on ${platform}...`);

  if (platform === 'win32') {
    removeRegistryVar('HKCU');
    removeRegistryVar('HKLM');
    clearEnvironmentVarWindows();
    ensureUnsetInProfile(findPowerShellProfile());
    process.env.NODE_OPTIONS = '';
    await killAndRestartVSCodeWindows();
  } else {
    ensureUnixUnset(findUnixProfile());
    process.env.NODE_OPTIONS = '';
    await killAndRestartVSCodeUnix();
  }
}

main().catch(e => console.error(e));