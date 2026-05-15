// menu/systemUtilities.js
// System utilities options (4.1 – 4.11)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
    '4.1': async (ctx) => {
        ctx.sh('node Scripts/encryptenvfiles.js');
        await ctx.pause();
    },
    '4.2': async (ctx) => {
        ctx.sh('node Scripts/decryptenvfiles.js');
        await ctx.pause();
    },
    '4.3': async (ctx) => {
        ctx.openUrl(`${ctx.GOCD_BASE}/go`);
        await ctx.pause();
    },
    '4.4': async (ctx) => {
        ctx.sh('docker stats --no-stream');
        await ctx.pause();
    },
    '4.5': async (ctx) => {
        ctx.sh('docker system prune -f');
        await ctx.pause();
    },
    '4.6': async (ctx) => {
        ctx.sh('node Scripts/pfs.js');
        await ctx.pause();
    },
    '4.7': async (ctx) => {
        const featureBranch = await ctx.ask('Enter feature branch name: ');
        if (featureBranch) ctx.sh(`node Scripts/master-feature-git-sync.js ${featureBranch}`);
        await ctx.pause();
    },
    '4.8': async (ctx) => {
        ctx.sh('node Scripts/fix-node-options.js');
        await ctx.pause();
    },
    '4.9': async (ctx) => {
        ctx.log('Resetting GoCD admin password and restarting server...', '\x1b[33m');
        // Write the new password from .env.docker into the container
        ctx.sh(`docker exec gocd-server sh -c "echo 'admin:${ctx.GOCD_PASS}' > /godata/config/password.properties"`);
        // Full stop/start to flush GoCD's authentication cache
        ctx.log('Stopping GoCD server...', '\x1b[33m');
        ctx.sh('docker stop gocd-server');
        ctx.log('Starting GoCD server...', '\x1b[33m');
        ctx.sh('docker start gocd-server');
        // Wait for GoCD to be ready (using the homepage to avoid auth issues)
        ctx.log('Waiting for GoCD to be ready...', '\x1b[33m');
        {
            let ready = false;
            for (let i = 0; i < 24; i++) {  // up to 120 seconds
                try {
                    execSync(`docker exec gocd-server curl -sf -o /dev/null "${ctx.GOCD_BASE}/go"`, { stdio: 'pipe' });
                    ready = true;
                    break;
                } catch (_) {
                    if (i < 23) {
                        if (os.platform() === 'win32') {
                            execSync('ping -n 6 127.0.0.1 >nul', { stdio: 'pipe' });
                        } else {
                            execSync('sleep 5', { stdio: 'pipe' });
                        }
                    }
                }
            }
            if (ready) {
                ctx.log('✅ GoCD is ready. Password reset applied.', '\x1b[32m');
            } else {
                ctx.log('❌ GoCD did not become ready in time. Check the container manually.', '\x1b[31m');
            }
        }
        await ctx.pause();
    },
    '4.10': async (ctx) => {
        // Read the current password from inside the GoCD container
        const rawPass = ctx.sh(
            `docker exec gocd-server cat /godata/config/password.properties`,
            { stdio: 'pipe' }
        );
        // sh returns the output string on success, or an error object on failure
        if (typeof rawPass === 'string' && rawPass.includes(':')) {
            const newPassword = rawPass.trim().split(':')[1];   // admin:password
            const envPath = path.join(__dirname, '..', '..', '.env.docker');
            let envContent = fs.readFileSync(envPath, 'utf8');
            envContent = envContent.replace(
                /^GOCD_ADMIN_PASSWORD=.*/m,
                `GOCD_ADMIN_PASSWORD=${newPassword}`
            );
            fs.writeFileSync(envPath, envContent);
            ctx.log('✅ .env.docker updated with password from container.', '\x1b[32m');
        } else {
            ctx.log('❌ Could not retrieve password from container.', '\x1b[31m');
        }
        await ctx.pause();
    },
    '4.11': async (ctx) => {
        ctx.log('--- GoCD Admin Credentials ---', '\x1b[36m');
        ctx.log(`Username: ${ctx.GOCD_USER}`, '\x1b[36m');
        ctx.log(`Password: ${ctx.GOCD_PASS}`, '\x1b[36m');
        ctx.log(`GoCD URL: ${ctx.GOCD_BASE}`, '\x1b[36m');

        // ── Test /go/api/agents (basic auth only) ──
        ctx.log('\nTesting /go/api/agents...', '\x1b[33m');
        const agentsResult = ctx.sh(
            `docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" "${ctx.GOCD_BASE}/go/api/agents"`,
            { stdio: 'pipe' }
        );
        if (typeof agentsResult === 'string') {
            try {
                JSON.parse(agentsResult);
                ctx.log('✅ Agents endpoint – authentication OK, JSON returned.', '\x1b[32m');
            } catch (_) {
                ctx.log('⚠ Agents returned non‑JSON:', '\x1b[33m');
                console.log(agentsResult.substring(0, 400));
            }
        } else {
            ctx.log('❌ Agents command failed (container down?).', '\x1b[31m');
        }

        // ── Test /go/api/pipelines WITH the correct Accept header ──
        ctx.log('\nTesting /go/api/pipelines (with v3 header)...', '\x1b[33m');
        const pipelinesResult = ctx.sh(
            `docker exec gocd-server curl -s -u "${ctx.GOCD_USER}:${ctx.GOCD_PASS}" -H "Accept: application/vnd.go.cd+json" "${ctx.GOCD_BASE}/go/api/pipelines"`,
            { stdio: 'pipe' }
        );
        if (typeof pipelinesResult === 'string') {
            try {
                const json = JSON.parse(pipelinesResult);
                const pipelineList = json._embedded?.pipelines || json.pipelines || [];
                ctx.log(`✅ Pipelines endpoint returned ${pipelineList.length} pipelines.`, '\x1b[32m');
            } catch (_) {
                ctx.log('⚠ Pipelines returned non‑JSON. Full response:', '\x1b[33m');
                console.log(pipelinesResult);
            }
        } else {
            ctx.log('❌ Pipelines command failed.', '\x1b[31m');
        }
        await ctx.pause();
    }
};