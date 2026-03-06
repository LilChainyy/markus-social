#!/usr/bin/env node
/**
 * Schedule a full day's posts across all platforms for an app.
 *
 * Reads app.json for enabled platforms and posting times, then calls
 * the appropriate create-post engine for each slot.
 *
 * Usage:
 *   node schedule-day.js --app dropspace [--date 2026-02-27] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadJSON, etDate, parseArgs } = require('./helpers');
const paths = require('./paths');
const { PLATFORMS: PLATFORM_DEFS } = require('./platforms');

const { saveJSON } = require('./helpers');
const { checkScheduledExists } = require('./api');
const SKILLS = __dirname; // scripts are co-located in the same directory

const { getArg, hasFlag } = parseArgs();

const appName = getArg('app');
if (!appName) { console.error('ERROR: --app required'); process.exit(1); }
const targetDate = getArg('date') || (() => {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    .toISOString().split('T')[0];
})();
const dryRun = hasFlag('dry-run');

// ── Cleanup old schedule tracking files (keep last 3 days) ──
try {
  const appRoot = paths.appRoot(appName);
  const files = fs.readdirSync(appRoot).filter(f => f.startsWith('scheduled-') && f.endsWith('.json'));
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  for (const f of files) {
    const date = f.replace('scheduled-', '').replace('.json', '');
    if (date < cutoff) {
      fs.unlinkSync(path.join(appRoot, f));
      console.log(`🧹 Cleaned old tracking file: ${f}`);
    }
  }
} catch { /* non-critical */ }

// ── Idempotency tracking ──
// Prevents duplicate scheduling if schedule-day runs twice on the same day
const scheduledTodayPath = path.join(paths.appRoot(appName), `scheduled-${targetDate}.json`);
const scheduledToday = loadJSON(scheduledTodayPath, { slots: {} });

function slotKey(platform, time) {
  return `${platform}:${time}`;
}

function markScheduled(platform, time, launchId) {
  scheduledToday.slots[slotKey(platform, time)] = {
    launchId: launchId || 'unknown',
    scheduledAt: new Date().toISOString(),
  };
  if (!dryRun) saveJSON(scheduledTodayPath, scheduledToday);
}

function isAlreadyScheduled(platform, time) {
  return !!scheduledToday.slots[slotKey(platform, time)];
}

/**
 * Convert "08:00" ET on a given date to ISO datetime.
 */
function toISOSchedule(date, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const year = parseInt(date.split('-')[0]);
  const month = parseInt(date.split('-')[1]) - 1;
  const day = parseInt(date.split('-')[2]);

  const tempUtc = new Date(Date.UTC(year, month, day, h, m, 0));
  const etStr = tempUtc.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etParsed = new Date(etStr);
  const offsetMs = tempUtc.getTime() - etParsed.getTime();
  const utc = new Date(Date.UTC(year, month, day, h, m, 0) + offsetMs);
  return utc.toISOString();
}

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const etDay = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  return etDay !== 0 && etDay !== 6;
}

async function main() {
  console.log(`📅 Scheduling ${appName} posts for ${targetDate}${dryRun ? ' (DRY RUN)' : ''}\n`);

  const appConfig = paths.loadAppConfig(appName);
  if (!appConfig) {
    console.error(`❌ No app.json found for ${appName} at ${paths.appConfigPath(appName)}`);
    process.exit(1);
  }

  const results = { scheduled: 0, skipped: 0, failed: 0, errors: [] };

  for (const [platform, platAppConfig] of Object.entries(appConfig.platforms || {})) {
    if (platAppConfig.enabled === false) {
      console.log(`  ⏭ ${platform}: disabled`);
      continue;
    }

    const platDef = PLATFORM_DEFS[platform];
    if (!platDef) {
      console.log(`  ⚠️ ${platform}: unknown platform, skipping`);
      continue;
    }

    const strategyFile = paths.strategyPath(appName, platform);
    if (!fs.existsSync(strategyFile)) {
      console.log(`  ⏭ ${platform}: no strategy.json, skipping`);
      results.skipped++;
      continue;
    }

    const strategy = loadJSON(strategyFile, {});
    const postingTimes = platAppConfig.postingTimes || strategy.postingTimes || [];
    const queue = strategy.postQueue || [];
    const weekdaysOnly = platAppConfig.weekdaysOnly || false;

    if (weekdaysOnly && !isWeekday(targetDate)) {
      console.log(`  ⏭ ${platform}: weekday-only, skipping (${targetDate} is weekend)`);
      results.skipped++;
      continue;
    }

    if (queue.length === 0) {
      console.log(`  ⚠️ ${platform}: post queue empty, skipping`);
      results.skipped++;
      continue;
    }

    const now = new Date();
    const minTime = new Date(now.getTime() + 16 * 60 * 1000);

    for (let i = 0; i < postingTimes.length && i < queue.length; i++) {
      const time = postingTimes[i];
      const post = queue[i];
      const scheduledISO = toISOSchedule(targetDate, time);
      const scheduledDate_dt = new Date(scheduledISO);

      if (scheduledDate_dt < minTime) {
        console.log(`  ⏭ ${platform} ${time}: already past, skipping`);
        results.skipped++;
        continue;
      }

      if (isAlreadyScheduled(platform, time)) {
        const prev = scheduledToday.slots[slotKey(platform, time)];
        console.log(`  ⏭ ${platform} ${time}: already scheduled (launch ${prev.launchId}), skipping`);
        results.skipped++;
        continue;
      }

      const hookText = post.text || post;

      if (dryRun) {
        console.log(`  🏃 ${platform} ${time}: "${hookText.substring(0, 60)}..." [DRY RUN]`);
        continue;
      }

      // Server-side dedup: check if a launch already exists at this time
      const existing = await checkScheduledExists(
        process.env.DROPSPACE_API_KEY_DROPSPACE,
        platform,
        scheduledISO
      );
      if (existing) {
        console.log(`  ⏭ ${platform} ${time}: launch already exists on server (${existing.id}), skipping`);
        markScheduled(platform, time, existing.id);
        results.skipped++;
        continue;
      }

      // Call the appropriate engine directly
      const engineScript = platDef.type === 'visual'
        ? path.join(SKILLS, 'create-visual-post-engine.js')
        : path.join(SKILLS, 'create-text-post-engine.js');

      const cmd = `node "${engineScript}" --app ${appName} --platform ${platform} --schedule "${scheduledISO}" --next`;

      console.log(`  🚀 ${platform} ${time}: "${hookText.substring(0, 60)}..."`);

      try {
        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 300000,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        });

        // Extract launch ID from output if available
        const launchIdMatch = output.match(/Launch[:\s]+([a-f0-9-]{36})/i) || output.match(/id[:\s"]+([a-f0-9-]{36})/i);
        const launchId = launchIdMatch ? launchIdMatch[1] : null;

        if (output.includes('Launch created') || output.includes('SCHEDULED')) {
          console.log(`  ✅ ${platform} ${time}: scheduled for ${scheduledISO}`);
          markScheduled(platform, time, launchId);
          results.scheduled++;
        } else if (output.includes('already exists') || output.includes('Skipping to avoid duplicate')) {
          console.log(`  ⏭ ${platform} ${time}: already scheduled (idempotency check)`);
          markScheduled(platform, time, launchId || 'existing');
          results.skipped++;
        } else if (!output.trim()) {
          // Engine produced no output — likely not running (missing CLI entrypoint)
          console.error(`  ❌ ${platform} ${time}: engine produced no output (script may not have a CLI entrypoint)`);
          results.errors.push(`${platform} ${time}: engine produced no output`);
          results.failed++;
        } else {
          // Engine ran but didn't print expected markers — treat as failure
          console.error(`  ❌ ${platform} ${time}: unexpected output (no 'Launch created' or 'SCHEDULED' marker)`);
          console.error(`     Output: ${output.trim().split('\n').slice(-3).join(' | ').substring(0, 200)}`);
          results.errors.push(`${platform} ${time}: unexpected engine output`);
          results.failed++;
        }

        for (const line of output.split('\n')) {
          if (line.includes('⚠️') || line.includes('❌')) {
            console.log(`     ${line.trim()}`);
          }
        }
      } catch (e) {
        const stderr = e.stderr || '';
        const stdout = e.stdout || '';
        const errMsg = stderr.trim() || stdout.split('\n').filter(l => l.includes('❌') || l.includes('ERROR')).join('; ') || e.message;
        console.error(`  ❌ ${platform} ${time}: ${errMsg.substring(0, 200)}`);
        results.errors.push(`${platform} ${time}: ${errMsg.substring(0, 200)}`);
        results.failed++;
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Schedule Summary for ${targetDate}`);
  console.log(`  ✅ Scheduled: ${results.scheduled}`);
  console.log(`  ⏭ Skipped:   ${results.skipped}`);
  console.log(`  ❌ Failed:    ${results.failed}`);
  if (results.errors.length > 0) {
    console.log(`\n⚠️ Errors:`);
    for (const e of results.errors) console.log(`  - ${e}`);
  }
  console.log('');

  // Clean up old scheduled-*.json files (keep last 3 days)
  try {
    const appRoot = paths.appRoot(appName);
    const files = fs.readdirSync(appRoot).filter(f => f.startsWith('scheduled-') && f.endsWith('.json'));
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    for (const f of files) {
      const dateStr = f.replace('scheduled-', '').replace('.json', '');
      if (dateStr < cutoff) {
        fs.unlinkSync(path.join(appRoot, f));
      }
    }
  } catch { /* non-critical */ }

  if (results.failed > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
