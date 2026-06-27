const path = require('path');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load .env.common from project root
const envPath = path.join(__dirname, '..', '..', '.env.common');
dotenv.config({ path: envPath });

module.exports = async function (helpers) {
  const { runCommand, ask, pause } = helpers;
  const inquirer = require('inquirer');

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.error('\x1b[31m❌ GCP_PROJECT_ID not found in .env.common. Please set it.\x1b[0m');
    await pause();
    return;
  }

  const backendChoices = [
    { name: '🌐 humrine-staging-backend', value: 'humrine-staging-backend' },
    { name: '🌐 humrine-backend (production)', value: 'humrine-backend' },
    { name: '🏸 court-staging-backend', value: 'court-staging-backend' },
    { name: '🏸 court-backend (production)', value: 'court-backend' },
    { name: '✏️  Enter custom backend name', value: 'custom' },
  ];

  const { backendChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'backendChoice',
      message: 'Select the backend service to check health:',
      choices: backendChoices,
    },
  ]);

  let backendName = backendChoice;
  if (backendChoice === 'custom') {
    const { customName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customName',
        message: 'Enter the backend service name:',
        validate: (input) => input.trim().length > 0 ? true : 'Please enter a valid name.',
      },
    ]);
    backendName = customName.trim();
  }

  console.log(`\n🔍 Checking health of ${backendName}...`);
  const cmd = `gcloud compute backend-services get-health ${backendName} --global --project=${projectId}`;
  runCommand(cmd);
  await pause();
};