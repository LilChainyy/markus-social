#!/usr/bin/env node
/**
 * Run self-improve for all enabled platforms with retry on failure.
 *
 * Runs each platform's self-improve engine sequentially.
 * If a platform fails, retries once after all others complete.
 * Outputs POSTS_NEEDED blocks for the cron agent to generate posts.
 *
 * Usage: node run-self-improve-all.js --app dropspace [--days 14] [--dry-run]
 */

const { execSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('./helpers');
const paths = require('./paths');

const { getArg, hasFlag } = parseArgs();
const appName = getArg('app');
if (!appName) { console.error('ERROR: --app required'); process.exit(1); }
const days = getArg('days') || '14';
const dryRun = hasFlag('dry-run');

const SCRIPT = path.join(__dirname, 'self-improve-engine.js');

const enabledPlatforms = paths.getEnabledPlatforms(appName);
if (enabledPlatforms.length === 0) {
  console.error(`❌ No enabled platforms for ${appName}`);
  process.exit(1);
}

console.log(`🔄 Self-improve all: ${appName} (${enabledPlatforms.join(', ')})\n`);

const results = { success: [], failed: [], retried: [] };

function runPlatform(platform) {
  const cmd = `node "${SCRIPT}" --app ${appName} --platform ${platform} --days ${days}${dryRun ? ' --dry-run' : ''}`;
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300000, // 5 min per platform
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Print output (includes POSTS_NEEDED blocks that the agent needs to see)
    process.stdout.write(output);
    return { ok: true, output };
  } catch (e) {
    const stderr = (e.stderr || '').trim();
    const stdout = (e.stdout || '').trim();
    // Still print stdout — may contain partial results
    if (stdout) process.stdout.write(stdout + '\n');
    const errMsg = stderr || e.message;
    console.error(`\n❌ ${platform} failed: ${errMsg.substring(0, 300)}\n`);
    return { ok: false, error: errMsg.substring(0, 300) };
  }
}

// First pass
for (const platform of enabledPlatforms) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`▶ ${platform}`);
  const result = runPlatform(platform);
  if (result.ok) {
    results.success.push(platform);
  } else {
    results.failed.push({ platform, error: result.error });
  }
}

// Retry failed platforms once
if (results.failed.length > 0) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🔁 Retrying ${results.failed.length} failed platform(s): ${results.failed.map(f => f.platform).join(', ')}\n`);

  const stillFailed = [];
  for (const { platform, error: firstError } of results.failed) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`▶ ${platform} (retry)`);
    const result = runPlatform(platform);
    if (result.ok) {
      results.retried.push(platform);
    } else {
      stillFailed.push({ platform, firstError, retryError: result.error });
    }
  }
  results.failed = stillFailed;
}

// Summary
console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 Self-improve Summary for ${appName}`);
console.log(`  ✅ Success: ${results.success.length} (${results.success.join(', ') || 'none'})`);
if (results.retried.length > 0) {
  console.log(`  🔁 Retried: ${results.retried.length} (${results.retried.join(', ')})`);
}
if (results.failed.length > 0) {
  console.log(`  ❌ Failed:  ${results.failed.length}`);
  for (const f of results.failed) {
    console.log(`     ${f.platform}: ${f.retryError}`);
  }
}
console.log('');

if (results.failed.length > 0) process.exitCode = 1;
