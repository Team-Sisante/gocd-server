#!/usr/bin/env node
/**
 * Scripts/master-feature-git-sync.js
 * 
 * Sync the master branch to be an exact copy of a feature branch in a single commit.
 * Ported from master-feature-git-sync.ps1.
 */

const { execSync } = require('child_process');
const readline = require('readline');

const featureBranch = process.argv[2];

if (!featureBranch) {
    console.error('\x1b[31m%s\x1b[0m', 'ERROR: Feature branch name is required.');
    console.log('\x1b[33m%s\x1b[0m', 'Usage: node Scripts/master-feature-git-sync.js <branch-name>');
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question, defaultAnswer = 'y') {
    return new Promise(resolve => {
        rl.question(`\x1b[33m${question} (y/n, default=${defaultAnswer}): \x1b[0m`, answer => {
            const finalAnswer = answer.trim().toLowerCase() || defaultAnswer;
            resolve(finalAnswer === 'y');
        });
    });
}

function sh(cmd, options = {}) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...options });
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', `✗ Command failed: ${cmd}`);
        process.exit(1);
    }
}

async function main() {
    console.log(`\n=== PREREQUISITES ===`);
    console.log(`- You have a feature branch named '${featureBranch}' pushed to the remote.`);
    console.log(`- You have the latest changes locally.`);

    if (!await ask("Do you want to continue?")) process.exit(0);

    // Check Git
    sh('git --version', { stdio: 'ignore' });

    console.log('Fetching latest changes from origin...');
    sh('git fetch origin');

    console.log(`\n=== STEP 1: SWITCH TO MASTER ===`);
    if (await ask("Switch to master now?")) {
        sh('git checkout master');
    } else {
        process.exit(0);
    }

    console.log(`\n=== STEP 2 (OPTIONAL): CLEAN UP MASTER ===`);
    if (await ask("Do you want to perform a hard reset on master?", 'n')) {
        const count = await new Promise(resolve => {
            rl.question('How many commits to remove (e.g., 2)? (0 to skip): ', resolve);
        });
        if (parseInt(count) > 0) {
            if (await ask(`Reset --hard HEAD~${count}? This discards commits and changes.`, 'n')) {
                sh(`git reset --hard HEAD~${count}`);
            }
        }
    }

    console.log(`\n=== STEP 3: STAGE FEATURE BRANCH CONTENTS ===`);
    console.log(`Replaces the staging area and working directory with the exact tree from '${featureBranch}'.`);
    if (await ask("Proceed with git read-tree?")) {
        sh(`git read-tree -u --reset ${featureBranch}`);
    } else {
        process.exit(0);
    }

    console.log(`\n=== STEP 4: COMMIT ON MASTER ===`);
    const commitMsg = await new Promise(resolve => {
        rl.question(`Commit message (default: Sync master with ${featureBranch} branch): `, answer => {
            resolve(answer.trim() || `Sync master with ${featureBranch} branch`);
        });
    });
    sh(`git commit -m "${commitMsg}"`);

    console.log(`\n=== STEP 5: FORCE PUSH ===`);
    if (await ask("Force push to origin master?", 'n')) {
        sh('git push origin master --force-with-lease');
    }

    console.log(`\n=== VERIFICATION ===`);
    try {
        execSync(`git diff --name-status master..${featureBranch}`, { stdio: 'inherit' });
        console.log('\x1b[32m%s\x1b[0m', '✓ No differences found – sync successful.');
    } catch (e) {
        console.log('\x1b[33m%s\x1b[0m', '⚠ Differences exist – verify manually.');
    }

    rl.close();
}

main();
