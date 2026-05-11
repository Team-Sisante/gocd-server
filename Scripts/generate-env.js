#!/usr/bin/env node
/**
 * Scripts/generate-env.js
 * Generates a .env file by pulling variables from GitHub and secrets from GCP Secret Manager.
 * 
 * Usage:
 *   node Scripts/generate-env.js development
 *   node Scripts/generate-env.js docker-production
 */

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');

const REPO = 'xmione/badminton_court';
const PROJECT_ID = 'project-39c0ea08-238b-47b5-915';
const ENV = process.argv[2] || 'development';
const OUTPUT_FILE = process.argv[3] || '.env';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
    console.error('\x1b[31mError: GITHUB_TOKEN environment variable is not set.\x1b[0m');
    process.exit(1);
}

// List of keys we know are stored in GCP Secret Manager
const SECRET_KEYS = [
    'SECRET_KEY', 'POSTGRES_PASSWORD', 'NGR_AUTHTOKEN', 
    'EMAIL_HOST_PASSWORD', 'POSTE_API_PASSWORD', 'ADMIN_PASSWORD', 
    'REGULARUSER_PASSWORD', 'SUPERADMIN_PASSWORD', 'STAFF_ADMIN_PASSWORD', 
    'INACTIVE_ADMIN_PASSWORD', 'GOOGLE_CLIENT_SECRET', 'FACEBOOK_CLIENT_SECRET', 
    'TWITTER_CLIENT_SECRET', 'GPG_PASSPHRASE'
];

async function getGitHubVariables(env) {
    let allVariables = [];
    let page = 1;
    let totalCount = 0;

    do {
        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${REPO}/environments/${env}/variables?per_page=100&page=${page}`,
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'User-Agent': 'Node.js/generate-env-script',
                    'Accept': 'application/vnd.github.v3+json'
                }
            };

            https.get(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else if (res.statusCode === 404 && page === 1) {
                        console.log(`\x1b[33mEnvironment ${env} not found, trying repository-level variables...\x1b[0m`);
                        resolve(null);
                    } else {
                        resolve({ variables: [] });
                    }
                });
            }).on('error', reject);
        });

        if (result === null) return [];
        if (!result.variables || result.variables.length === 0) break;

        allVariables = allVariables.concat(result.variables);
        totalCount = result.total_count || allVariables.length;
        page++;
    } while (allVariables.length < totalCount);

    return allVariables;
}

async function getRepoVariables() {
    let allVariables = [];
    let page = 1;
    let totalCount = 0;

    do {
        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${REPO}/actions/variables?per_page=100&page=${page}`,
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'User-Agent': 'Node.js/generate-env-script',
                    'Accept': 'application/vnd.github.v3+json'
                }
            };

            https.get(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve({ variables: [] });
                    }
                });
            }).on('error', reject);
        });

        if (!result.variables || result.variables.length === 0) break;

        allVariables = allVariables.concat(result.variables);
        totalCount = result.total_count || allVariables.length;
        page++;
    } while (allVariables.length < totalCount);

    return allVariables;
}

function getGCPSecret(key) {
    try {
        // Use --quiet and redirect stderr to ignore warnings/errors
        return execSync(`gcloud secrets versions access latest --secret="${key}" --project ${PROJECT_ID}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        return null;
    }
}

async function generate() {
    console.log(`\x1b[32mGenerating ${OUTPUT_FILE} for ${ENV}...\x1b[0m`);

    try {
        // 1. Fetch Variables from GitHub
        console.log('\x1b[34mFetching variables from GitHub...\x1b[0m');
        
        // Fetch both repo and environment level variables
        const [repoVars, envVars] = await Promise.all([
            getRepoVariables(),
            getGitHubVariables(ENV)
        ]);

        // Merge variables (environment level takes precedence)
        const variables = [...repoVars, ...envVars];
        const uniqueVars = {};
        variables.forEach(v => {
            uniqueVars[v.name] = v.value;
        });
        
        let content = `# Generated from GitHub and GCP\n# Environment: ${ENV}\n# Date: ${new Date().toISOString()}\n\n`;

        Object.keys(uniqueVars).sort().forEach(name => {
            const value = uniqueVars[name];
            const formattedValue = value.includes(' ') || value.includes('#') || value.includes('"') ? `"${value.replace(/"/g, '\\"')}"` : value;
            content += `${name}=${formattedValue}\n`;
        });

        // 2. Fetch Secrets from GCP
        console.log('\x1b[34mFetching secrets from GCP Secret Manager...\x1b[0m');
        for (const key of SECRET_KEYS) {
            const value = getGCPSecret(key);
            if (value) {
                console.log(`\x1b[32m  ✓ Retrieved secret: ${key}\x1b[0m`);
                content += `${key}="${value}"\n`;
            } else {
                console.log(`\x1b[33m  ⚠ Secret not found or inaccessible: ${key}\x1b[0m`);
            }
        }

        // 3. Write to file
        fs.writeFileSync(OUTPUT_FILE, content);
        console.log(`\x1b[32m\nSuccessfully created ${OUTPUT_FILE}!\x1b[0m`);
    } catch (error) {
        console.error(`\x1b[31m\nGeneration failed: ${error.message}\x1b[0m`);
        process.exit(1);
    }
}

generate();
