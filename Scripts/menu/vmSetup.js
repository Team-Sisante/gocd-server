// menu/vmSetup.js
// GCP VM Setup options (6.1 – 6.29)

const viewLogs = require('./viewLogs');
const restartService = require('./restartService');
const openStagingApp = require('./openStagingApp');
const openProductionApp = require('./openProductionApp');
const healthCheckStaging = require('./healthCheckStaging');
const clearSSHHostKey = require('./clearSSHHostKey');
const recreateFreshVM = require('./recreateFreshVM');
const createVMFromYAML = require('./createVMFromYAML');
const sshToVM = require('./sshToVM');
const containerDiagnostics = require('./containerDiagnostics');
const sshTunnelGoCD = require('./sshTunnelGoCD');
const showHostRules = require('./showHostRules');

module.exports = {
    '6.1': async (ctx) => { ctx.sh('node Scripts/create-fresh-vm.js'); await ctx.pause(); },
    '6.2': async (ctx) => { ctx.sh('node Scripts/setup-firewall-rules.js'); await ctx.pause(); },
    '6.3': async (ctx) => { ctx.sh('node Scripts/setup-agent-ssh.js'); await ctx.pause(); },
    '6.4': async (ctx) => { ctx.sh('node Scripts/wait-for-vm-tools.js'); ctx.log('VM tools are now ready.', '\x1b[32m'); await ctx.pause(); },
    '6.5': async (ctx) => { ctx.sh('node Scripts/setup-gcp-secrets-access.js'); await ctx.pause(); },
    '6.6': async (ctx) => { ctx.sh('node Scripts/check-vm-reachability.js'); await ctx.pause(); },
    '6.7': async (ctx) => { ctx.sh('node Scripts/apply-pipeline-config.js'); await ctx.pause(); },
    '6.8': async (ctx) => {
        ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -H "Confirm: true" -X POST ${ctx.GOCD_BASE}/go/api/pipelines/badminton_court-artifacts/schedule`);
        ctx.log('Pipeline triggered. Staging will start automatically after artifacts succeed.', '\x1b[32m');
        await ctx.pause();
    },
    '6.9': async (ctx) => {
        ctx.sh(`gcloud compute instances describe ${ctx.GCP_VM_NAME} --zone=${ctx.GCP_ZONE} --project=${ctx.GCP_PROJECT_ID} --format="table[box](name, status, machineType, networkInterfaces[0].accessConfigs[0].natIP)"`);
        await ctx.pause();
    },
    '6.10': async (ctx) => {
        const sa = `gocd-agent-secrets@${ctx.GCP_PROJECT_ID}.iam.gserviceaccount.com`;
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.viewer"`);
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.instanceAdmin.v1"`);
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.securityAdmin"`);
        ctx.sh(`gcloud iam service-accounts add-iam-policy-binding 575810712323-compute@developer.gserviceaccount.com --member="serviceAccount:${sa}" --role="roles/iam.serviceAccountUser"`);
        ctx.log('Agent granted all required permissions (including project‑level SSH metadata).', '\x1b[32m');
        await ctx.pause();
    },
    '6.11': async (ctx) => {
        const exportPath = await ctx.ask('Output filename (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
        ctx.sh(`gcloud compute instances export ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --destination=${exportPath}`);
        ctx.log(`VM settings saved to ${exportPath}`, '\x1b[32m');
        await ctx.pause();
    },
    '6.12': async (ctx) => {
        ctx.log('WARNING: This will delete the VM and all its data!', '\x1b[31m');
        const confirmDelete = await ctx.ask('Are you sure? (y/N): ');
        if (confirmDelete.toLowerCase() === 'y') {
            ctx.sh(`gcloud compute instances delete ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --quiet`);
            ctx.log('VM deleted.', '\x1b[32m');
        }
        await ctx.pause();
    },
    '6.13': createVMFromYAML,
    '6.14': recreateFreshVM,
    '6.15': async (ctx) => {
        ctx.log('Running full VM post‑creation setup...', '\x1b[33m');
        ctx.sh('node Scripts/setup-firewall-rules.js');
        ctx.sh('node Scripts/setup-agent-ssh.js');
        ctx.sh('node Scripts/setup-gcp-secrets-access.js');
        ctx.sh('node Scripts/check-vm-reachability.js');
        ctx.log('✅ Setup completed.', '\x1b[32m');
        await ctx.pause();
    },
    // 6.16 – View logs of a service (interactive, replaces old quick table)
    '6.16': viewLogs,
    // 6.17 – Restart a service (interactive)
    '6.17': restartService,
    // 6.18 – Open staging app in browser
    '6.18': openStagingApp,
    // 6.19 – Health check staging app
    '6.19': healthCheckStaging,
    // 6.20 – Clear SSH host key
    '6.20': clearSSHHostKey,
    // 6.21 – Connect to VM via SSH (interactive shell)
    '6.21': sshToVM,
    // 6.22 – Create new VM & run full setup (one‑step)
    '6.22': async (ctx) => { ctx.sh('node Scripts/create-deploy-vm.js'); await ctx.pause(); },
    // 6.23 – List all VMs (project-wide)
    '6.23': async (ctx) => {
        ctx.sh(`gcloud compute instances list --project=${ctx.GCP_PROJECT_ID} --format="table(name,zone,status,machineType,networkInterfaces[0].accessConfigs[0].natIP)"`);
        await ctx.pause();
    },
    // 6.24 – Clean up Docker disk space on staging VM
    '6.24': async (ctx) => {
        const { GCP_VM_IP, SSH_USER, SSH_KEY_PATH, sh, log, pause } = ctx;
        log('Connecting to staging VM to clean up Docker disk space...', '\x1b[33m');
        try {
            sh(`ssh -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${SSH_USER}@${GCP_VM_IP} "sudo docker system prune -af && sudo docker volume prune -f && df -h /"`);
            log('✅ Cleanup complete.', '\x1b[32m');
        } catch (err) {
            log('❌ Cleanup failed.', '\x1b[31m');
            console.error(err.message);
        }
        await pause();
    },
    // 6.25 – Open production app in browser
    '6.25': openProductionApp,
    // Container diagnostics
    '6.26': async (ctx) => { await containerDiagnostics(ctx, 'staging'); },
    '6.27': async (ctx) => { await containerDiagnostics(ctx, 'production'); },
    // 6.28 – Enable/Verify Swap Space on VM
    '6.28': async (ctx) => { ctx.sh('node Scripts/enable-swap-on-vm.js'); await ctx.pause(); },
    // 6.29 – SSH tunnel: expose local GoCD via VM
    '6.29': sshTunnelGoCD,
    // 6.30 – Setup Load Balancer (humrine.com)
    '6.30': async (ctx) => {
        const answer = await ctx.ask('This will rebuild the load balancer. Continue? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
            ctx.log('Aborted.', '\x1b[33m');
            await ctx.ask('\x1b[33m\nPress Enter to continue...\x1b[0m');
            return;
        }
        try {
            ctx.execSync('node Scripts/setup-load-balancer.js humrine_site', { stdio: 'inherit' });
        } catch (err) {
            console.error('\x1b[31mSetup failed:\x1b[0m', err.message);
        }
        await ctx.ask('\x1b[33m\nPress Enter to continue...\x1b[0m');
    },
    // 6.31 – Validate Social Media Configs
    '6.31': async (ctx) => {
        const inquirer = (await import('inquirer')).default;

        ctx.rl.pause();
        const { appName, envName } = await inquirer.prompt([
            {
                type: 'list',
                name: 'appName',
                message: 'Select application:',
                choices: ['humrine_site', 'badminton_court']
            },
            {
                type: 'list',
                name: 'envName',
                message: 'Select environment:',
                choices: ['staging', 'production']
            }
        ]);
        ctx.rl.resume();

        try {
            ctx.execSync(`node Scripts/setup-social-media.js ${appName} ${envName}`, { stdio: 'inherit' });
        } catch (err) {
            console.error('\x1b[31mValidation failed:\x1b[0m', err.message);
        }
        await ctx.ask('\x1b[33m\nPress Enter to continue...\x1b[0m');
    },
    // 6.37 – Show load balancer host rules
    '6.37': async (ctx) => {
        await showHostRules(ctx);
    },    
};