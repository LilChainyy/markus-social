#!/usr/bin/env node
/**
 * Shared Config Validator — checks if an app is ready to post for a platform.
 *
 * Usage:
 *   node validate-engine.js --app dropspace --platform tiktok
 *   node validate-engine.js --app dropspace --platform tiktok --init  (use init-app.js instead)
 *
 * Can also be called programmatically:
 *   const { runValidate } = require('./validate-engine');
 *   runValidate({ platform: 'tiktok', requiresImages: true, extraChecks: fn });
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, loadJSON } = require('./helpers');
const pathsLib = require('./paths');
const { getPlatformDef, getVisualPlatforms } = require('./platforms');

function runValidate(config = {}) {
  const { getArg, hasFlag } = parseArgs();

  const appName = getArg('app');
  const platformName = getArg('platform') || config.platform;

  if (!appName || !platformName) {
    console.error('Usage: node validate-engine.js --app <name> --platform <platform>');
    process.exit(1);
  }

  const platDef = getPlatformDef(platformName);
  const requiresImages = config.requiresImages ?? getVisualPlatforms().includes(platformName);
  const platformDir = pathsLib.platformDir(appName, platformName);
  const appConfigFile = pathsLib.appConfigPath(appName);

  console.log(`\n🔍 Validating "${appName}" / ${platformName}...\n`);

  let errors = 0;
  let warnings = 0;
  const checks = [];

  function check(name, condition, severity = 'error') {
    const status = condition ? '✅' : severity === 'error' ? '❌' : '⚠️';
    console.log(`  ${status} ${name}`);
    if (!condition) { severity === 'error' ? errors++ : warnings++; }
    checks.push({ name, ok: condition, severity });
  }

  // ── Directories ──
  check('Platform directory exists', fs.existsSync(platformDir));
  if (!fs.existsSync(platformDir)) {
    console.log(`\n❌ Run: node init-app.js --app ${appName} --platforms ${platformName}`);
    process.exit(1);
  }
  check('Posts assets directory exists', fs.existsSync(pathsLib.postsAssetsRoot(appName, platformName)));

  // ── App config ──
  const hasAppConfig = fs.existsSync(appConfigFile);
  check('app.json exists', hasAppConfig);
  if (hasAppConfig) {
    const appConfig = loadJSON(appConfigFile);
    check('App name set', !!appConfig.name);
    check('App description set', !!appConfig.description);
    check('Target audience defined', !!appConfig.audience);
    check('App URL set', !!appConfig.url);
    check('Platform enabled in app.json', !!appConfig.platforms?.[platformName]?.enabled, 'warn');
    check('Posting times configured', appConfig.platforms?.[platformName]?.postingTimes?.length > 0, 'warn');
    check('PostHog project ID', !!appConfig.integrations?.posthog?.projectId, 'warn');
    check('Supabase project configured', !!appConfig.integrations?.supabase?.projectId, 'warn');
    check('Stripe product IDs configured', appConfig.integrations?.stripe?.productIds?.length > 0, 'warn');
  }

  // ── Strategy ──
  const strategyFile = pathsLib.strategyPath(appName, platformName);
  const hasStrategy = fs.existsSync(strategyFile);
  check('strategy.json exists', hasStrategy);
  if (hasStrategy) {
    const strategy = loadJSON(strategyFile);
    check('Post queue has entries', strategy.postQueue?.length > 0, 'warn');

    // Platform-specific checks
    if (config.extraChecks) {
      const extras = config.extraChecks(strategy, platformDir);
      for (const c of extras) check(c.name, c.ok, c.severity || 'warn');
    }
  }

  // ── Data files ──
  check('failures.json exists', fs.existsSync(pathsLib.failuresPath(appName, platformName)), 'warn');
  check('posts.json exists', fs.existsSync(pathsLib.postsPath(appName, platformName)), 'warn');

  // ── Env vars ──
  check('DROPSPACE_API_KEY set', !!process.env.DROPSPACE_API_KEY_DROPSPACE);
  check('STRIPE_SECRET_KEY set', !!process.env.STRIPE_SECRET_KEY, 'warn');

  if (requiresImages) {
    check('Image gen API key set', !!process.env.OPENAI_API_KEY);
    let hasCanvas = false;
    const canvasPaths = [
      'canvas',
      path.join(process.env.HOME || '', 'markus-automation', 'node_modules', 'canvas'),
      path.join(process.env.HOME || '', 'node_modules', 'canvas'),
    ];
    for (const cp of canvasPaths) { try { require(cp); hasCanvas = true; break; } catch {} }
    check('node-canvas installed', hasCanvas);
    check('pending-batches.json exists', fs.existsSync(path.join(platformDir, 'pending-batches.json')), 'warn');
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Errors:   ${errors}`);
  console.log(`  Warnings: ${warnings}`);
  console.log(`  Passed:   ${checks.filter(c => c.ok).length}/${checks.length}`);

  if (errors > 0) {
    console.log(`\n❌ Not ready. Fix ${errors} error(s).`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`\n⚠️  Ready, but ${warnings} warning(s).`);
  } else {
    console.log(`\n✅ Fully configured!`);
  }
}

// CLI entry point
if (require.main === module) {
  runValidate();
}

module.exports = { runValidate };
