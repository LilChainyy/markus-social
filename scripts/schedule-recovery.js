#!/usr/bin/env node
/**
 * Schedule Recovery — retry missed posting slots from earlier today.
 *
 * Checks scheduled-{date}.json for gaps (posting times that weren't scheduled)
 * and retries them. Only runs for slots whose posting time hasn't passed yet
 * (with a 16-min future minimum for Dropspace scheduling).
 *
 * Usage: node schedule-recovery.js --app dropspace [--dry-run]
 *
 * Designed to run as a recovery cron ~4 hours after schedule-day (e.g., 6 AM ET).
 * If schedule-day succeeded fully, this is a no-op.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadJSON, saveJSON, parseArgs } = require('./helpers');
const { checkScheduledExists } = require('./api');
const paths = require('./paths');
const { PLATFORMS: PLATFORM_DEFS } = require('./platforms');

const SKILLS = __dirname;
const { getArg, hasFlag } = parseArgs();
const appName = getArg('app');
if (!appName) { console.error('ERROR: --app required'); process.exit(1); }
const dryRun = hasFlag('dry-run');

function getETDate() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    .toISOString().split('T')[0];
}

function toISOSchedule(date, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const year = parseInt(date.split('-')[0]);
  const month = parseInt(date.split('-')[1]) - 1;
  const day = parseInt(date.split('-')[2]);
  const tempUtc = new Date(Date.UTC(year, month, day, h, m, 0));
  const etStr = tempUtc.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etParsed = new Date(etStr);
  const offsetMs = tempUtc.getTime() - etParsed.getTime();
  return new Date(Date.UTC(year, month, day, h, m, 0) + offsetMs);
}

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const etDay = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  return etDay !== 0 && etDay !== 6;
}

async function main() {
  const today = getETDate();
  const scheduledPath = path.join(paths.appRoot(appName), `scheduled-${today}.json`);
  const scheduled = loadJSON(scheduledPath, { slots: {} });
  const appConfig = paths.loadAppConfig(appName);

  function markScheduled(platform, time, launchId) {
    const key = `${platform}:${time}`;
    scheduled.slots[key] = {
      launchId: launchId || 'recovered',
      scheduledAt: new Date().toISOString(),
      source: 'recovery',
    };
    if (!dryRun) saveJSON(scheduledPath, scheduled);
  }

  if (!appConfig) {
    console.error(`❌ No app.json for ${appName}`);
    process.exit(1);
  }

  const now = new Date();
  const minTime = new Date(now.getTime() + 16 * 60 * 1000); // 16 min minimum
  let recovered = 0;
  let skipped = 0;
  let alreadyDone = 0;

  console.log(`🔄 Schedule Recovery for ${appName} — ${today}${dryRun ? ' (DRY RUN)' : ''}\n`);

  for (const [platform, platConfig] of Object.entries(appConfig.platforms || {})) {
    if (platConfig.enabled === false) continue;
    if (platConfig.weekdaysOnly && !isWeekday(today)) continue;

    const platDef = PLATFORM_DEFS[platform];
    if (!platDef) continue;

    const postingTimes = platConfig.postingTimes || [];
    const strategy = loadJSON(paths.strategyPath(appName, platform), { postQueue: [] });
    const queue = strategy.postQueue || [];

    for (const time of postingTimes) {
      const slotKey = `${platform}:${time}`;
      
      if (scheduled.slots[slotKey]) {
        alreadyDone++;
        continue;
      }

      // Check if this slot's time is still in the future (with 16 min buffer)
      const slotTime = toISOSchedule(today, time);
      if (slotTime < minTime) {
        console.log(`  ⏭ ${platform} ${time}: already past, can't recover`);
        skipped++;
        continue;
      }

      if (queue.length === 0) {
        console.log(`  ⚠️ ${platform} ${time}: queue empty, can't recover`);
        skipped++;
        continue;
      }

      // Server-side dedup: check if a launch already exists at this time
      const scheduledISO_check = slotTime.toISOString();
      const existing = await checkScheduledExists(
        process.env.DROPSPACE_API_KEY_DROPSPACE,
        platform,
        scheduledISO_check
      );
      if (existing) {
        console.log(`  ⏭ ${platform} ${time}: launch already exists on server (${existing.id}), marking tracked`);
        markScheduled(platform, time, existing.id);
        alreadyDone++;
        continue;
      }

      console.log(`  🔁 ${platform} ${time}: MISSED — recovering...`);

      if (dryRun) {
        console.log(`     Would schedule: "${(queue[0].text || queue[0]).substring(0, 60)}..."`);
        recovered++;
        continue;
      }

      const engineScript = platDef.type === 'visual'
        ? path.join(SKILLS, 'create-visual-post-engine.js')
        : path.join(SKILLS, 'create-text-post-engine.js');

      const scheduledISO = slotTime.toISOString();
      const cmd = `node "${engineScript}" --app ${appName} --platform ${platform} --schedule "${scheduledISO}" --next`;

      try {
        const output = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 300000,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        });
        const launchIdMatch = output.match(/Launch[:\s]+([a-f0-9-]{36})/i) || output.match(/id[:\s"]+([a-f0-9-]{36})/i);
        const launchId = launchIdMatch ? launchIdMatch[1] : null;
        markScheduled(platform, time, launchId);
        console.log(`  ✅ ${platform} ${time}: recovered, scheduled for ${scheduledISO}${launchId ? ` (${launchId})` : ''}`);
        recovered++;
      } catch (e) {
        const errMsg = (e.stderr || e.message || '').substring(0, 200);
        console.error(`  ❌ ${platform} ${time}: recovery failed — ${errMsg}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Recovery Summary`);
  console.log(`  ✅ Already scheduled: ${alreadyDone}`);
  console.log(`  🔁 Recovered: ${recovered}`);
  console.log(`  ⏭ Skipped: ${skipped}`);

  if (recovered === 0 && skipped === 0) {
    console.log('\n✅ Nothing to recover — schedule-day ran clean.');
  }
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
