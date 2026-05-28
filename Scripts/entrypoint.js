#!/usr/bin/env node
// Scripts/entrypoint.js
'use strict';
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const GIT_REPO_PROTOCOL = process.env.GIT_REPO_PROTOCOL || 'https';
const GIT_REPO_DOMAIN = process.env.GIT_REPO_DOMAIN || 'github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIT_REPO_USERNAME = process.env.GIT_REPO_USERNAME;
const SITE_URL = process.env.SITE_URL;
const CRUISE_CONFIG = '/godata/config/cruise-config.xml';

function log(msg) { console.log(`[entrypoint.js] ${msg}`); }

function replaceInFile(file, search, replace) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(new RegExp(search, 'g'), replace);
  fs.writeFileSync(file, content);
}

// Ensure username is injected correctly with token
const makeUrl = (repo) =>
  `${GIT_REPO_PROTOCOL}://${GIT_REPO_USERNAME}:${GITHUB_TOKEN}@${GIT_REPO_DOMAIN}/${GIT_REPO_USERNAME}/${repo}.git`;

log('STEP 4: Processing dynamic app injections from apps.json...');
const appsConfig = JSON.parse(fs.readFileSync('/tmp/apps.json', 'utf8'));
appsConfig.apps.forEach(app => {
  const repoName = process.env[app.env_var];
  if (repoName) {
    const url = makeUrl(repoName);
    replaceInFile(CRUISE_CONFIG, app.placeholder, url);
    log(`Successfully injected URL for: ${app.name}`);
  } else {
    log(`Skipping ${app.name}: Env var ${app.env_var} is empty or placeholder missing.`);
  }
});

if (SITE_URL) replaceInFile(CRUISE_CONFIG, '__SITE_URL__', SITE_URL);

log('STEP 7: Handing off to GoCD via gosu...');
const args = process.argv.slice(2);
const result = spawnSync('gosu', ['go', '/docker-entrypoint.sh', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 0);
