// menu/vmSetup.js
// GCP VM Setup options (6.1 – 6.23)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
    // 6.1 – Create deployment VM
    '6.1': async (ctx) => {
        ctx.sh('node Scripts/create-fresh-vm.js');
        await ctx.pause();
    },
    // 6.2 – Configure firewall rules
    '6.2': async (ctx) => {
        ctx.sh('node Scripts/setup-firewall-rules.js');
        await ctx.pause();
    },
    // 6.3 – Setup agent SSH keys
    '6.3': async (ctx) => {
        ctx.sh('node Scripts/setup-agent-ssh.js');
        await ctx.pause();
    },
    // 6.4 – Install / Verify tools on VM
    '6.4': async (ctx) => {
        ctx.sh('node Scripts/install-tools-on-vm.js');
        ctx.log('VM tools are now ready.', '\x1b[32m');
        await ctx.pause();
    },
    // 6.5 – Setup GCP Secret Manager access for agent
    '6.5': async (ctx) => {
        ctx.sh('node Scripts/setup-gcp-secrets-access.js');
        await ctx.pause();
    },
    // 6.6 – Check VM running & reachable
    '6.6': async (ctx) => {
        ctx.sh('node Scripts/check-vm-reachability.js');
        await ctx.pause();
    },
    // 6.7 – Apply pipeline configuration to GoCD
    '6.7': async (ctx) => {
        ctx.sh('node Scripts/apply-pipeline-config.js');
        await ctx.pause();
    },
    // 6.8 – Deploy application
    '6.8': async (ctx) => {
        ctx.sh(`docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -H "Confirm: true" -X POST ${ctx.GOCD_BASE}/go/api/pipelines/badminton_court-artifacts/schedule`);
        ctx.log('Pipeline triggered. Staging will start automatically after artifacts succeed.', '\x1b[32m');
        await ctx.pause();
    },
    // 6.9 – Monitor VM status
    '6.9': async (ctx) => {
        ctx.sh(`gcloud compute instances describe ${ctx.GCP_VM_NAME} --zone=${ctx.GCP_ZONE} --project=${ctx.GCP_PROJECT_ID} --format="table[box](name, status, machineType, networkInterfaces[0].accessConfigs[0].natIP)"`);
        await ctx.pause();
    },
    // 6.10 – Grant agent VM read access (one‑time setup)
    '6.10': async (ctx) => {
        const sa = `gocd-agent-secrets@${ctx.GCP_PROJECT_ID}.iam.gserviceaccount.com`;
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.viewer"`);
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.instanceAdmin.v1"`);
        ctx.sh(`gcloud projects add-iam-policy-binding ${ctx.GCP_PROJECT_ID} --member="serviceAccount:${sa}" --role="roles/compute.securityAdmin"`);
        ctx.sh(`gcloud iam service-accounts add-iam-policy-binding 575810712323-compute@developer.gserviceaccount.com --member="serviceAccount:${sa}" --role="roles/iam.serviceAccountUser"`);
        ctx.log('Agent granted all required permissions (including project‑level SSH metadata).', '\x1b[32m');
        await ctx.pause();
    },
    // 6.11 – Export VM settings to YAML
    '6.11': async (ctx) => {
        const exportPath = await ctx.ask('Output filename (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
        ctx.sh(`gcloud compute instances export ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --destination=${exportPath}`);
        ctx.log(`VM settings saved to ${exportPath}`, '\x1b[32m');
        await ctx.pause();
    },
    // 6.12 – Delete VM
    '6.12': async (ctx) => {
        ctx.log('WARNING: This will delete the VM and all its data!', '\x1b[31m');
        const confirmDelete = await ctx.ask('Are you sure? (y/N): ');
        if (confirmDelete.toLowerCase() === 'y') {
            ctx.sh(`gcloud compute instances delete ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --quiet`);
            ctx.log('VM deleted.', '\x1b[32m');
        }
        await ctx.pause();
    },
    // 6.13 – Create VM from saved YAML
    '6.13': async (ctx) => {
        const yamlFile = await ctx.ask('YAML config file (default: gocd-deploy-target-config.yaml): ') || 'gocd-deploy-target-config.yaml';
        if (!fs.existsSync(yamlFile)) {
            ctx.log(`File not found: ${yamlFile}`, '\x1b[31m');
        } else {
            // Check if the VM already exists
            let vmExists = false;
            try {
                execSync(`gcloud compute instances describe ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE}`, { stdio: 'pipe' });
                vmExists = true;
            } catch (_) { /* VM does not exist */ }

            if (vmExists) {
                ctx.log(`ℹ️  VM "${ctx.GCP_VM_NAME}" already exists.`, '\x1b[33m');
                ctx.log('    If it needs configuration, proceed with the setup steps below.', '\x1b[33m');
                ctx.log('    To recreate a fresh VM, delete it first (option 6.12) or use 6.14.', '\x1b[33m');
            } else {
                // Read the YAML and build a standard creation command
                const yaml = fs.readFileSync(yamlFile, 'utf8');
                const machineType = (yaml.match(/machineType:\s*.*\/([^/\s]+)/) || [])[1] || 'e2-medium';
                const image       = (yaml.match(/sourceImage:\s*(.+)/) || [])[1]?.trim() || 'projects/debian-cloud/global/images/family/debian-11';
                const bootDiskSize = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                const network     = (yaml.match(/network:\s*.*\/([^/\s]+)/) || [])[1] || 'default';
                const subnetwork  = (yaml.match(/subnetwork:\s*.*\/([^/\s]+)/) || [])[1] || '';
                const hasExternalIp = yaml.includes('natIP:');
                const externalIPFlag = hasExternalIp ? '' : '--no-address';

                let createCmd = `gcloud compute instances create ${ctx.GCP_VM_NAME}`;
                createCmd += ` --project=${ctx.GCP_PROJECT_ID}`;
                createCmd += ` --zone=${ctx.GCP_ZONE}`;
                createCmd += ` --machine-type=${machineType}`;
                createCmd += ` --image=${image}`;
                createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                createCmd += ` --network=${network}`;
                if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                if (externalIPFlag) createCmd += ` ${externalIPFlag}`;

                const result = ctx.sh(createCmd);
                if (result && result.success) {
                    ctx.log('VM created from saved settings.', '\x1b[32m');
                } else {
                    ctx.log('⚠️  VM creation failed. Check the error above.', '\x1b[31m');
                }
            }

            // --- Next steps reminder ---
            ctx.log('', '\x1b[36m');
            ctx.log('📋 Recommended next steps for this VM:', '\x1b[33m');
            ctx.log('   6.2  – Configure firewall rules', '\x1b[33m');
            ctx.log('   6.3  – Setup agent SSH keys', '\x1b[33m');
            ctx.log('   6.4  – Install / Verify tools on VM', '\x1b[33m');
            ctx.log('   6.5  – Setup GCP Secret Manager access', '\x1b[33m');
            ctx.log('   6.6  – Check VM reachability', '\x1b[33m');
            ctx.log('', '\x1b[36m');
            ctx.log('💡 Pro tip: Use option 6.15 to run all of them at once.', '\x1b[36m');
            ctx.log('⚠️ Before using option 6.14: The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
            ctx.log('⚠️ All the existing settings of a fully setup VM will be lost.', '\x1b[33m');
        }
        await ctx.pause();
    },
    // 6.14 – Recreate fresh VM (export → delete → create)
    '6.14': async (ctx) => {
        ctx.log('This will: 1) Export settings, 2) Delete VM, 3) Create fresh VM, 4) Run full setup', '\x1b[33m');
        ctx.log('⚠️  The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
        const confirmRecreate = await ctx.ask('Proceed? (y/N): ');
        if (confirmRecreate.toLowerCase() === 'y') {
            const recreateYaml = 'gocd-deploy-target-config.yaml';

            // Backup the old YAML if it exists
            if (fs.existsSync(recreateYaml)) {
                const backupName = recreateYaml.replace('.yaml', `-backup-${Date.now()}.yaml`);
                fs.copyFileSync(recreateYaml, backupName);
                ctx.log(`📁 Previous config backed up to: ${backupName}`, '\x1b[36m');
            }

            // Step 1: Export (overwrites the original)
            ctx.log('Step 1: Exporting VM settings...', '\x1b[33m');
            ctx.sh(`gcloud compute instances export ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --destination=${recreateYaml}`);
            ctx.log('Step 2: Deleting VM...', '\x1b[33m');
            ctx.sh(`gcloud compute instances delete ${ctx.GCP_VM_NAME} --project=${ctx.GCP_PROJECT_ID} --zone=${ctx.GCP_ZONE} --quiet`);
            ctx.log('Step 3: Creating fresh VM...', '\x1b[33m');
            {
                const yaml = fs.readFileSync(recreateYaml, 'utf8');
                const machineType = (yaml.match(/machineType:\s*(\S+)/) || [])[1] || 'e2-medium';
                const image       = (yaml.match(/sourceImage:\s*["']?([^"'\n\r]+)["']?/) || [])[1] || 'projects/debian-cloud/global/images/family/debian-11';
                const bootDiskSize = (yaml.match(/diskSizeGb:\s*(\d+)/) || [])[1] || '20';
                const network     = (yaml.match(/network:\s*(\S+)/) || [])[1] || 'default';
                const subnetwork  = (yaml.match(/subnetwork:\s*(\S+)/) || [])[1] || '';
                const hasExternalIp = yaml.includes('natIP:');
                const externalIPFlag = hasExternalIp ? '' : '--no-address';

                let createCmd = `gcloud compute instances create ${ctx.GCP_VM_NAME}`;
                createCmd += ` --project=${ctx.GCP_PROJECT_ID}`;
                createCmd += ` --zone=${ctx.GCP_ZONE}`;
                createCmd += ` --machine-type=${machineType}`;
                createCmd += ` --image=${image}`;
                createCmd += ` --boot-disk-size=${bootDiskSize}GB`;
                createCmd += ` --network=${network}`;
                if (subnetwork) createCmd += ` --subnet=${subnetwork}`;
                if (externalIPFlag) createCmd += ` ${externalIPFlag}`;
                ctx.sh(createCmd);
            }
            ctx.log('Fresh VM created from saved settings.', '\x1b[32m');

            // Next steps reminder
            ctx.log('', '\x1b[36m');
            ctx.log('📋 Recommended next steps for this fresh VM:', '\x1b[33m');
            ctx.log('   6.2  – Configure firewall rules', '\x1b[33m');
            ctx.log('   6.3  – Setup agent SSH keys', '\x1b[33m');
            ctx.log('   6.4  – Install / Verify tools on VM', '\x1b[33m');
            ctx.log('   6.5  – Setup GCP Secret Manager access', '\x1b[33m');
            ctx.log('   6.6  – Check VM reachability', '\x1b[33m');
            ctx.log('', '\x1b[36m');
            ctx.log('💡 Pro tip: Use option 6.15 to run all of them at once.', '\x1b[36m');
        }
        await ctx.pause();
    },
    // 6.15 – Run full post‑creation setup
    '6.15': async (ctx) => {
        ctx.log('Running full VM post‑creation setup...', '\x1b[33m');
        ctx.sh('node Scripts/setup-firewall-rules.js');
        ctx.sh('node Scripts/setup-agent-ssh.js');
        ctx.sh('node Scripts/setup-gcp-secrets-access.js');
        ctx.sh('node Scripts/check-vm-reachability.js');
        ctx.log('✅ Setup completed.', '\x1b[32m');
        await ctx.pause();
    },
    // 6.16 – Show Docker containers on VM
    '6.16': async (ctx) => {
        try {
            ctx.rl.pause();
            const inquirer = (await import('inquirer')).default;
            const sshCmd = `ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "docker ps -a --format '{{.Names}}'"`;
            const result = ctx.execSync(sshCmd, { encoding: 'utf8', stdio: 'pipe' });
            const containers = result.trim().split('\n').filter(Boolean);
            if (containers.length === 0) {
                ctx.log('No containers found on VM.', '\x1b[33m');
                ctx.rl.resume();
                await ctx.pause();
                return;
            }
            const { service } = await inquirer.prompt({
                type: 'list',
                name: 'service',
                message: 'Select a container to view logs:',
                choices: containers
            });
            ctx.rl.resume();
            ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "docker logs -f --tail 50 ${service}"`);
            await ctx.pause();
        } catch (e) {
            ctx.rl.resume();                     // ensure readline is active
            ctx.setErrorDisplayed(true);
            process.stdout.write('\x1Bc');
            ctx.log('❌ Failed to list containers or view logs.', '\x1b[31m');
            console.error(e.stderr || e.message);
            await ctx.ask('Press Enter to return to the menu...');
            // No extra pause
        }
    },
    // 6.17 – View logs of a service on VM
    '6.17': async (ctx) => {
        try {
            ctx.rl.pause();
            const inquirer = (await import('inquirer')).default;
            const sshCmd = `ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "docker ps -a --format '{{.Names}}'"`;
            const result = ctx.execSync(sshCmd, { encoding: 'utf8', stdio: 'pipe' });
            const containers = result.trim().split('\n').filter(Boolean);
            if (containers.length === 0) {
                ctx.log('No containers found on VM.', '\x1b[33m');
                ctx.rl.resume();
                await ctx.pause();
                return;
            }
            const { service } = await inquirer.prompt({
                type: 'list',
                name: 'service',
                message: 'Select a container to restart:',
                choices: containers
            });
            ctx.rl.resume();
            ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "docker restart ${service}"`);
            ctx.log(`${service} restarted.`, '\x1b[32m');
            await ctx.pause();
        } catch (e) {
            ctx.rl.resume();
            ctx.setErrorDisplayed(true);
            process.stdout.write('\x1Bc');
            ctx.log('❌ Failed to list containers or restart service.', '\x1b[31m');
            console.error(e.stderr || e.message);
            await ctx.ask('Press Enter to return to the menu...');
        }
    },
    // 6.18 – Restart a service on VM
    '6.18': async (ctx) => {
        const service = await ctx.ask('Service name to restart: ');
        if (service) {
            ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "docker restart ${service}"`);
            ctx.log(`${service} restarted.`, '\x1b[32m');
        }
        await ctx.pause();
    },
    // 6.19 – Open staging app in browser
    '6.19': async (ctx) => {
        const stagingUrl = `http://${ctx.VM_IP}:8001`;
        ctx.openUrl(stagingUrl);
        ctx.log(`Opening staging app: ${stagingUrl}`, '\x1b[32m');
        await ctx.pause();
    },
    // 6.20 – Health check staging app
    '6.20': async (ctx) => {
        ctx.log('Performing health check on staging (port 8001)...', '\x1b[33m');
        ctx.sh(`ssh -i "${ctx.SSH_KEY_PATH}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${ctx.SSH_USER}@${ctx.VM_IP} "curl -s -o /dev/null -w '%{http_code}' http://localhost:8001/ || echo 'Failed'"`);
        await ctx.pause();
    },
    // 6.21 – Clear SSH host key for VM
    '6.21': async (ctx) => {
        ctx.log(`Removing cached host key for ${ctx.VM_IP}...`, '\x1b[33m');
        ctx.sh(`ssh-keygen -R ${ctx.VM_IP}`);
        ctx.log('Host key cleared. Next connection will accept the new key.', '\x1b[32m');
        await ctx.pause();
    },
    // 6.22 – Create new VM & run full setup
    '6.22': async (ctx) => {
        ctx.sh('node Scripts/create-deploy-vm.js');
        await ctx.pause();
    },
    // 6.23 – List all VMs (project-wide)
    '6.23': async (ctx) => {
        ctx.sh(`gcloud compute instances list --project=${ctx.GCP_PROJECT_ID} --format="table(name,zone,status,machineType,networkInterfaces[0].accessConfigs[0].natIP)"`);
        await ctx.pause();
    }
};