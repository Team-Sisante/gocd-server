// menu/recreateFreshVM.js

const fs = require('fs');

module.exports = async function recreateFreshVM(ctx) {
    ctx.log('This will: 1) Export settings, 2) Delete VM, 3) Create fresh VM, 4) Run full setup', '\x1b[33m');
    ctx.log('⚠️  The YAML file "gocd-deploy-target-config.yaml" will be overwritten.', '\x1b[33m');
    const confirmRecreate = await ctx.ask('Proceed? (y/N): ');
    if (confirmRecreate.toLowerCase() === 'y') {
        const recreateYaml = 'gocd-deploy-target-config.yaml';

        if (fs.existsSync(recreateYaml)) {
            const backupName = recreateYaml.replace('.yaml', `-backup-${Date.now()}.yaml`);
            fs.copyFileSync(recreateYaml, backupName);
            ctx.log(`📁 Previous config backed up to: ${backupName}`, '\x1b[36m');
        }

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

        ctx.log('', '\x1b[36m');
        ctx.log('📋 Recommended next steps for this fresh VM:', '\x1b[33m');
        ctx.log('   6.2  – Configure firewall rules', '\x1b[33m');
        ctx.log('   6.3  – Setup agent SSH keys', '\x1b[33m');
        ctx.log('   6.4  – Wait / Verify tools on VM', '\x1b[33m');
        ctx.log('   6.5  – Setup GCP Secret Manager access', '\x1b[33m');
        ctx.log('   6.6  – Check VM reachability', '\x1b[33m');
        ctx.log('', '\x1b[36m');
        ctx.log('💡 Pro tip: Use option 6.15 to run all of them at once.', '\x1b[36m');
    }
    await ctx.pause();
};