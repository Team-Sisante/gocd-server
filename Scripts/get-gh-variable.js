#!/usr/bin/env node
// Scripts/get-gh-variable.js
// Retrieves GitHub variable using gh CLI
// 
// Usage:
//   node scripts/get-gh-variable.js
//   node scripts/get-gh-variable.js --repo=owner/repo --variable=VAR_NAME

const { execSync } = require('child_process');

function getGitHubVariable(repo = 'xmione/badminton_court', variableName = 'ENV_ENCRYPTION_KEY') {
  try {
    // Check if gh CLI is available
    try {
      execSync('gh --version', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('GitHub CLI (gh) is not installed or not in PATH. Install from: https://cli.github.com/');
    }

    // Get variable list from GitHub
    const output = execSync(
      `gh variable list --repo ${repo} --json name,value`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Parse JSON response
    const variables = JSON.parse(output);
    
    // Find the requested variable
    const variable = variables.find(v => v.name === variableName);

    if (!variable) {
      throw new Error(`Variable '${variableName}' not found in repository '${repo}'.`);
    }

    // Output to stderr so only the value goes to stdout
    console.error(`[OK] ${variable.name} = ${variable.value}`);
    console.error(`[OK] Retrieved GitHub variable '${variableName}' from repository '${repo}'.`);

    // Return value to stdout (this is what gets captured by parent script)
    console.log(variable.value);
    
    return variable.value;

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    
    if (error.message.includes('gh auth')) {
      console.error('\nYou may need to authenticate with GitHub CLI:');
      console.error('  gh auth login');
    }
    
    process.exit(1);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let repo = 'xmione/badminton_court';
  let variableName = 'ENV_ENCRYPTION_KEY';

  args.forEach(arg => {
    if (arg.startsWith('--repo=')) {
      repo = arg.split('=')[1];
    } else if (arg.startsWith('--variable=')) {
      variableName = arg.split('=')[1];
    }
  });

  return { repo, variableName };
}

// Main execution
if (require.main === module) {
  const { repo, variableName } = parseArgs();
  getGitHubVariable(repo, variableName);
}

module.exports = getGitHubVariable;