#!/usr/bin/env node
/**
 * Scripts/create-deploy-vm.js
 * Master orchestrator for a full fresh deployment VM.
 * 1. Creates a new VM (calls create-fresh-vm.js  → menu option 6.1)
 * 2. Runs all post‑creation setup steps by calling the same
 *    granular scripts that are also available as individual menu options:
 *    - setup-firewall-rules.js      (6.2)
 *    - setup-agent-ssh.js           (6.3)
 *    - wait-for-vm-tools.js       (6.4)
 *    - setup-gcp-secrets-access.js  (6.5)
 *    - check-vm-reachability.js     (6.6)
 *    - apply-pipeline-config.js     (6.7)   ← pipeline config is part of the setup
 *
 * Usage:
 *   node Scripts/create-deploy-vm.js
 *
 * ============================================================================
 * 🔴 HARD RULE for AI assistants editing this or any sub‑script:
 *    Every process MUST display real‑time progress.  Never suppress output
 *    or make the screen appear frozen.  Always show live elapsed time where
 *    appropriate, and never leave the user staring at a blank, motionless
 *    terminal.  Output that proves activity is REQUIRED, not optional.
 *    ⏱️  A single elapsed‑time line is pinned to the bottom of the terminal
 *        and updates every TIMER_INTERVAL_SECONDS seconds.  Child‑process
 *        output scrolls normally above it.
 *    🧹 Clear the terminal before starting so the timer is immediately visible.
 * ============================================================================
 */

const { spawn } = require('child_process');
const path = require('path');

// ---------- CONFIGURABLE TIMER INTERVAL ----------
const TIMER_INTERVAL_SECONDS = 1;   // change to any number of seconds

// ---------- Terminal helpers ----------
let rows = process.stdout.rows || 24;
process.stdout.on('resize', () => { rows = process.stdout.rows; });

// ---- Clear screen and move cursor to home ----
process.stdout.write('\x1Bc');

function setScrollRegion(top, bottom) {
  process.stdout.write(`\x1b[${top};${bottom}r`);
}

function resetScrollRegion() {
  process.stdout.write(`\x1b[0r`);
}

// ---------- Timer ----------
const startTime = Date.now();

function startTimer() {
  return setInterval(() => {
    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    const hours   = Math.floor(totalSec / 3600);
    const mins    = Math.floor((totalSec % 3600) / 60);
    const secs    = totalSec % 60;
    const timeStr = [hours, mins, secs].map(v => String(v).padStart(2, '0')).join(':');
    // Save cursor, move to last row, print timer, clear line, restore cursor
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[36m⏱️  Time Elapsed: ${timeStr}\x1b[0m\x1b[K\x1b8`);
  }, TIMER_INTERVAL_SECONDS * 1000);
}

// ---------- Helpers ----------
function runAsync(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',               // output goes directly to terminal (within scroll region)
      shell: true
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function log(msg, color = '\x1b[36m') {
  // Logs inside the scroll region
  console.log(`${color}%s\x1b[0m`, msg);
}

function elapsed() {
  return Math.floor((Date.now() - startTime) / 1000) + 's';
}

// ---------- Main flow ----------
async function main() {
  // Reserve the bottom line
  setScrollRegion(1, rows - 1);

  const timer = startTimer();
  timer.unref();

  log(`[${elapsed()}] Starting full deployment VM creation…`, '\x1b[32m');

  try {
    log(`[${elapsed()}] Step 1: Creating fresh VM (menu option 6.1)…`, '\x1b[33m');
    await runAsync('node', ['Scripts/create-fresh-vm.js']);
    log(`[${elapsed()}] VM created.`);

    const steps = [
      ['setup-firewall-rules.js',      'Configure firewall rules (6.2)'],
      ['setup-agent-ssh.js',           'Setup agent SSH keys (6.3)'],
      ['wait-for-vm-tools.js',       'Install / Verify tools on VM (6.4)'],
      ['setup-gcp-secrets-access.js',  'Setup GCP Secret Manager access (6.5)'],
      ['check-vm-reachability.js',     'Check VM running & reachable (6.6)'],
      ['apply-pipeline-config.js',     'Apply pipeline configuration (6.7)']
    ];

    for (const [script, label] of steps) {
      log(`[${elapsed()}] Step: ${label}…`, '\x1b[33m');
      await runAsync('node', [path.join(__dirname, script)]);
      log(`[${elapsed()}] ${label} done.`, '\x1b[36m');
    }

    clearInterval(timer);
    resetScrollRegion();
    // Clear the timer line and move to a fresh line
    process.stdout.write(`\x1b[${rows};1H\x1b[K\n`);

    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    const totalTime = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    log(`\n✅ Full deployment VM is ready.`, '\x1b[32m');
    log(`   Total time: ${totalTime}`, '\x1b[32m');
    log(`   All post‑creation steps completed and pipeline configuration applied.`, '\x1b[36m');
    log(`   You can now use option 2.1 to trigger the badminton_court‑artifacts pipeline.`, '\x1b[36m');
  } catch (err) {
    clearInterval(timer);
    resetScrollRegion();
    process.stdout.write(`\x1b[${rows};1H\x1b[K\n`);
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();