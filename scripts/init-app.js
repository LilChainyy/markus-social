#!/usr/bin/env node
/**
 * Initialize a new app for the automation pipeline.
 *
 * Creates the directory structure, app.json template, and empty data files
 * for all specified platforms.
 *
 * Usage:
 *   node init-app.js --app markus --platforms tiktok,instagram,twitter
 *   node init-app.js --app markus --platforms all
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./helpers');
const pathsLib = require('./paths');
const { getAllPlatforms, getVisualPlatforms } = require('./platforms');

const { getArg } = parseArgs();
const appName = getArg('app');
const platformsArg = getArg('platforms') || 'all';

if (!appName) {
  console.error('Usage: node init-app.js --app <name> --platforms <tiktok,instagram,...|all>');
  process.exit(1);
}

const platforms = platformsArg === 'all'
  ? getAllPlatforms()
  : platformsArg.split(',').map(s => s.trim());

const visualPlatforms = getVisualPlatforms();

// Create directories
const appRoot = pathsLib.appRoot(appName);
const dirs = [
  appRoot,
  pathsLib.reportsDir(appName),
  pathsLib.cacheDir(),
];

for (const platform of platforms) {
  dirs.push(pathsLib.platformDir(appName, platform));
  dirs.push(pathsLib.postsAssetsRoot(appName, platform));
  if (platform === 'twitter') {
    dirs.push(pathsLib.researchDir(appName, 'twitter'));
  }
}

for (const d of dirs) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    console.log(`📁 ${d}`);
  }
}

// Create app.json template
const appConfigFile = pathsLib.appConfigPath(appName);
if (!fs.existsSync(appConfigFile)) {
  const platformConfig = {};
  for (const p of platforms) {
    platformConfig[p] = {
      enabled: true,
      postingTimes: visualPlatforms.includes(p) ? ['08:00'] : ['09:00'],
      ...(visualPlatforms.includes(p) ? { imageModel: 'gpt-image-1.5' } : {}),
      ...(p === 'linkedin' ? { weekdaysOnly: true } : {}),
    };
  }

  const template = {
    name: appName.charAt(0).toUpperCase() + appName.slice(1),
    description: '',
    audience: '',
    problem: '',
    differentiator: '',
    url: '',
    category: 'saas',
    monetization: 'subscription',
    apiKeyEnv: `DROPSPACE_API_KEY_${appName.toUpperCase()}`,
    integrations: {
      posthog: { projectId: '' },
      supabase: { projectId: '', url: '' },
      stripe: { productIds: [] },
    },
    platforms: platformConfig,
    utmTemplate: `https://example.com?utm_source={platform}&utm_medium=social&utm_campaign=openclaw`,
  };

  fs.writeFileSync(appConfigFile, JSON.stringify(template, null, 2));
  console.log(`📝 ${appConfigFile}`);
} else {
  console.log(`⏭ ${appConfigFile} already exists`);
}

// Create empty data files for each platform
for (const platform of platforms) {
  const files = {
    'strategy.json': { postQueue: [] },
    'posts.json': { posts: [] },
    'failures.json': { failures: [] },
  };

  if (visualPlatforms.includes(platform)) {
    files['pending-batches.json'] = { batches: [] };
  }

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(pathsLib.platformDir(appName, platform), filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
      console.log(`📝 ${platform}/${filename}`);
    }
  }
}

// Create shared files
const sharedFiles = {
  [pathsLib.sharedFailuresPath(appName)]: { failures: [] },
  [pathsLib.insightsPath(appName)]: { lastUpdated: null },
};

for (const [filePath, content] of Object.entries(sharedFiles)) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    console.log(`📝 ${path.basename(filePath)}`);
  }
}

console.log(`\n✅ App "${appName}" initialized with ${platforms.length} platforms: ${platforms.join(', ')}`);
console.log(`\nNext steps:`);
console.log(`  1. Edit ${appConfigFile} with your app details`);
console.log(`  2. Add crons (copy from dropspace crons, change --app to ${appName})`);
console.log(`  3. Run: node scripts/pipeline-check.js --stage self-improve --app ${appName}`);
