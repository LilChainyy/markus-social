#!/usr/bin/env node
/**
 * Shared Self-Improvement Engine (v2 — simplified)
 *
 * Does the data work: pulls analytics, updates hooks, manages queue.
 * Outputs structured signals for the cron agent to make strategic decisions.
 *
 * Can be called directly: node self-improve-engine.js --app dropspace --platform tiktok --days 14
 * Or via runSelfImprove(config) for backward compat.
 */

const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON, mean, etDate, etHour,
  referrerToPlatform, parseArgs
} = require('./helpers');
const paths = require('./paths');
const { getPlatformDef } = require('./platforms');
const { dropspaceRequest, stripeAPI, supabaseSQL, fetchPostHogReferrers, fetchRecentLaunches, fetchAttributionData } = require('./api');
const { buildExperimentContext, parseExperimentCommands, applyExperimentCommands } = require('./experiments');

const MAX_QUEUE = 14;
const MIN_QUEUE = 7;

// Slide image URLs now come from GET /launches list response (media_assets field)
// No per-launch detail fetch needed.

async function _runSelfImprove(config) {
  const { getArg, hasFlag } = parseArgs();

  const appName = getArg('app');
  const days = parseInt(getArg('days') || '14');
  const dryRun = hasFlag('dry-run');

  if (!appName) {
    console.error('Usage: node self-improve-engine.js --app <name> --platform <platform> [--days 14] [--dry-run]');
    process.exit(1);
  }

  const DROPSPACE_KEY = process.env.DROPSPACE_API_KEY_DROPSPACE;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
  let SUPABASE_PROJECT_ID = process.env.SUPABASE_PROJECT_ID;

  if (!DROPSPACE_KEY) {
    console.error('ERROR: DROPSPACE_API_KEY_DROPSPACE not set');
    process.exit(1);
  }

  const platform = config.platform;
  const primaryMetric = config.primaryMetric;
  const getMetricValue = config.engagementFormula || (post => post[primaryMetric] || 0);

  // File paths — all via paths.js
  const appDir = paths.platformDir(appName, platform);
  const postsFile = paths.postsPath(appName, platform);
  const strategyFile = paths.strategyPath(appName, platform);
  const reportsDirectory = paths.reportsDir(appName);

  // App config (replaces per-platform profile.json)
  const appConfig = paths.loadAppConfig(appName) || {};
  const profileData = appConfig;

  if (!SUPABASE_PROJECT_ID && profileData.integrations?.supabase?.projectId) {
    SUPABASE_PROJECT_ID = profileData.integrations?.supabase.projectId;
  }

  console.log(`\n🔄 Self-improvement run: ${appName}/${platform} (last ${days} days)${dryRun ? ' [DRY RUN]' : ''}\n`);

  const changelog = [];

  // ── 1. Pull launches + analytics ──────────────────────────────
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const postsData = loadJSON(postsFile, { posts: [] });
  const strategy = loadJSON(strategyFile, { postQueue: [], postingTimes: [] });
  const knownLaunchIds = new Set(postsData.posts.map(h => h.launchId).filter(Boolean));
  const postQueueTexts = new Set(strategy.postQueue.map(q => (q.text || q).toLowerCase()));
  const appUrl = (profileData.url || '').replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const recentLaunches = await fetchRecentLaunches(DROPSPACE_KEY, platform, cutoff, knownLaunchIds, appUrl, postQueueTexts);
  console.log(`📊 Found ${recentLaunches.length} ${platform} launches for ${appName} in last ${days} days`);

  const postData = [];
  for (const launch of recentLaunches) {
    try {
      const analytics = await dropspaceRequest('GET', `/launches/${launch.id}/analytics`, null, DROPSPACE_KEY);
      const platformData = analytics.data.platforms?.find(p => p.platform === platform);
      const metrics = config.extractMetrics(platformData);
      postData.push({
        launchId: launch.id,
        name: launch.name,
        createdAt: launch.created_at,
        postUrl: platformData?.post_url || null,
        mediaAssetUrls: (launch.media_assets || []).map(a => a.url).filter(Boolean),
        ...metrics,
      });
    } catch (e) {
      console.warn(`  ⚠️  Could not get analytics for ${launch.id}: ${e.message}`);
    }
  }
  console.log(`📈 Got analytics for ${postData.length} launches\n`);

  // ── 2-3. Shared data (PostHog + Attribution) with cross-process cache ──
  // PostHog referrers and Supabase/Stripe attribution are per-app, not per-platform.
  // When 6 self-improve crons run simultaneously, cache the result so only one hits the APIs.
  const sharedCachePath = paths.selfImproveCachePath(appName, days);
  const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

  let phSources = [];
  let phTotal = 0;
  let phFromPlatform = 0;
  let conversions = [];
  let totalRevenue = 0;

  let sharedCache = null;
  try {
    if (fs.existsSync(sharedCachePath)) {
      const raw = JSON.parse(fs.readFileSync(sharedCachePath, 'utf-8'));
      if (Date.now() - new Date(raw.cachedAt).getTime() < CACHE_MAX_AGE_MS) {
        sharedCache = raw;
        console.log(`📦 Using cached shared data (PostHog + attribution) from ${raw.cachedAt}`);
      }
    }
  } catch { /* ignore stale/corrupt cache */ }

  if (sharedCache) {
    phSources = sharedCache.phSources || [];
    phTotal = sharedCache.phTotal || 0;
    conversions = sharedCache.conversions || [];
    totalRevenue = sharedCache.totalRevenue || 0;
    phFromPlatform = phSources.find(s => s.source === platform)?.count || 0;
    console.log(`🌐 PostHog (cached): ${phTotal} pageviews, ${phFromPlatform} from ${platform}`);
    console.log(`💰 Conversions (cached): ${conversions.length} users, $${totalRevenue.toFixed(2)} revenue`);
  } else {
    // Fetch fresh data and cache it
    try {
      const phKey = process.env.POSTHOG_PERSONAL_API_KEY;
      const phProject = profileData.integrations?.posthog?.projectId;
      if (phKey && phProject) {
        const rawPH = await fetchPostHogReferrers(phKey, phProject, days);
        phSources = Object.entries(rawPH).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
        phTotal = phSources.reduce((s, e) => s + e.count, 0);
        phFromPlatform = phSources.find(s => s.source === platform)?.count || 0;
        console.log(`🌐 PostHog: ${phTotal} pageviews, ${phFromPlatform} from ${platform}`);
        const topSrc = phSources.slice(0, 5).map(s => `${s.source}=${s.count}`).join(', ');
        console.log(`   Top sources: ${topSrc}`);
      }
    } catch (e) {
      console.warn(`⚠️  PostHog failed: ${e.message}`);
    }

    try {
      const attrResult = await fetchAttributionData(
        cutoff, profileData, SUPABASE_TOKEN, SUPABASE_PROJECT_ID, STRIPE_KEY
      );
      conversions = attrResult.conversions || [];
      totalRevenue = attrResult.totalRevenue || 0;
      const statusCounts = {};
      const sources = {};
      for (const c of conversions) {
        statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
        sources[c.source || 'unknown'] = (sources[c.source || 'unknown'] || 0) + 1;
      }
      const phEnriched = conversions.filter(c => c.firstTouchSource).length;
      console.log(`💰 Conversions: ${conversions.length} users (${statusCounts.signup_only || 0} signup, ${statusCounts.trialing || 0} trialing, ${statusCounts.active || 0} paid, ${statusCounts.cancelled || 0} cancelled)`);
      console.log(`💵 Revenue: $${totalRevenue.toFixed(2)}`);
      const srcStr = Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(', ');
      if (srcStr) console.log(`📍 Sources: ${srcStr}`);
      if (phEnriched > 0) console.log(`🔗 ${phEnriched} sources enriched via PostHog first-touch`);
    } catch (e) {
      console.warn(`⚠️  Attribution failed: ${e.message}`);
    }

    // Cache for sibling platform runs
    try {
      fs.writeFileSync(sharedCachePath, JSON.stringify({
        cachedAt: new Date().toISOString(),
        phSources, phTotal, conversions, totalRevenue,
      }));
    } catch { /* non-critical */ }
  }

  // ── 4. Update posts.json ──────────────────────────────────────
  let newPosts = 0, updatedPosts = 0;

  for (const post of postData) {
    const postText = post.name;
    if (!postText) continue;
    const existing = postsData.posts.find(p => p.launchId === post.launchId || p.text?.toLowerCase() === postText.toLowerCase());

    if (existing) {
      // Update metrics
      for (const [k, v] of Object.entries(post)) {
        if (k !== 'launchId' && k !== 'name' && k !== 'createdAt') {
          existing[k] = v;
        }
      }
      existing.lastChecked = new Date().toISOString();
      if (!existing.launchId) existing.launchId = post.launchId;
      updatedPosts++;
    } else {
      // New post
      const date = new Date(post.createdAt);
      postsData.posts.push({
        launchId: post.launchId,
        text: postText,
        date: etDate(date),
        hour: etHour(date),
        ...post,

        lastChecked: new Date().toISOString(),
      });
      newPosts++;
    }
  }

  // Mark posts that have aged out of the analytics window
  const analyticsExpiry = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const p of postsData.posts) {
    if (!p.metricsFinalAt && p.date && new Date(p.date) < analyticsExpiry) {
      p.metricsFinalAt = new Date().toISOString().split('T')[0];
    }
  }

  changelog.push(`Posts: ${newPosts} new, ${updatedPosts} updated`);

  // ── 5. Queue management ───────────────────────────────────────
  // Stale pruning (14 days)
  const staleDate = etDate(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
  const beforePrune = strategy.postQueue.length;
  strategy.postQueue = strategy.postQueue.filter(q => !q.addedAt || q.addedAt >= staleDate);
  const pruned = beforePrune - strategy.postQueue.length;
  if (pruned > 0) changelog.push(`🧹 Pruned ${pruned} stale hooks (now posts)`);

  // X research signals
  // Read X research signals from file (written by x-research cron)
  const signalsPath = paths.xResearchSignalsPath(appName);
  let xResearchResults = { signals: null, competitorHooks: {} };
  try {
    if (fs.existsSync(signalsPath)) {
      const raw = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
      // Use signals if less than 6 hours old (resilient to delayed cron runs)
      const savedAt = raw.savedAt ? new Date(raw.savedAt).getTime() : 0;
      const ageHours = (Date.now() - savedAt) / (1000 * 60 * 60);
      if (ageHours < 6) {
        xResearchResults = raw;
        console.log(`🐦 X Research signals loaded (${raw.signals?.trendingAngles?.length || 0} angles, ${Object.keys(raw.competitorHooks || {}).length} competitors, ${ageHours.toFixed(1)}h old)`);
      } else {
        console.log(`🐦 X Research signals stale (${ageHours.toFixed(1)}h old) — skipping`);
      }
    } else {
      console.log('🐦 No X research signals file — skipping');
    }
  } catch (e) {
    console.warn(`⚠️  Could not read X research signals: ${e.message}`);
  }

  // Competitor data flows through researchSignals in POSTS_NEEDED (from x-research-signals.json)

  // Cross-pollination removed — the LLM sees all platforms' data in POSTS_NEEDED
  // and can decide to adapt winning angles across platforms on its own.

  // No re-sorting — the LLM writes hooks to the queue in strategic order.
  // schedule-day picks from the top, so position = priority.
  // The agent decides what to post next based on full context (performance,
  // research signals, variety, platform dynamics), not a metric score.

  // Hard cap
  if (strategy.postQueue.length > MAX_QUEUE) {
    const trimmed = strategy.postQueue.length - MAX_QUEUE;
    strategy.postQueue = strategy.postQueue.slice(0, MAX_QUEUE);
    changelog.push(`✂️ Trimmed ${trimmed} hooks (cap ${MAX_QUEUE})`);
  }

  // ── 6. POSTS_NEEDED signal for agent ───────────────────────────
  // Request enough slots to reach MIN_QUEUE, but never exceed MAX_QUEUE
  const currentQueueLen = strategy.postQueue.length;
  const slotsToMin = Math.max(0, MIN_QUEUE - currentQueueLen);
  const slotsToMax = MAX_QUEUE - currentQueueLen;
  const slotsAvailable = Math.max(slotsToMin, slotsToMax);
  if (slotsAvailable > 0) {
    // Give LLM ALL posts from the analytics window — it decides what matters
    const recentPosts = postsData.posts
      .filter(p => {
        if (!p.date) return false;
        const postDate = new Date(p.date);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return postDate >= cutoff;
      })
      .map(p => {
        const out = { text: p.text, date: p.date, format: p.format || null, [primaryMetric]: getMetricValue(p) };
        if (p.slideTexts) out.slideTexts = p.slideTexts;
        if (p.slidePrompts) out.slidePrompts = p.slidePrompts;
        if (p.caption) out.caption = p.caption;
        if (p.postBody) out.postBody = p.postBody;
        if (p.postUrl) out.postUrl = p.postUrl;
        // Include slide image URLs from launch media_assets (already in list response)
        if (isVisual && p.mediaAssetUrls?.length > 0) out.slideImageUrls = p.mediaAssetUrls;
        return out;
      });

    // Determine platform type
    const isVisual = ['tiktok', 'instagram', 'facebook'].includes(platform);
    const isTextOnly = ['twitter', 'linkedin', 'reddit'].includes(platform);

    console.log('\n--- POSTS_NEEDED ---');
    console.log(JSON.stringify({
      platform,
      app: appName,
      slotsAvailable,
      strategyPath: strategyFile,
      postType: isVisual ? 'visual-slideshow' : 'text',
      product: {
        name: profileData.name || 'Dropspace',
        description: profileData.description || '',
        audience: profileData.audience || '',
        problem: profileData.problem || '',
        differentiator: profileData.differentiator || '',
      },
      researchSignals: xResearchResults.signals ? {
        trendingAngles: xResearchResults.signals.trendingAngles?.slice(0, 8) || [],
        competitorPositioning: xResearchResults.signals.competitorPositioning || [],
        topExamples: xResearchResults.signals.topExamples || [],
      } : null,
      recentPosts,
      previousNotes: strategy.notes || null,
      crossPlatformNotes: (() => {
        try {
          const cpPath = paths.insightsPath(appName);
          return JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        } catch { return null; }
      })(),
      strategy: isVisual ? {
        instructions: 'Generate COMPLETE post blueprints, not just hooks. Each post should be a cohesive unit.',
        format: 'Each post needs: text (hook/opening line), slideTexts (array of 6 strings — the text overlaid on each slide), slidePrompts (array of 6 complete image generation prompts), caption (platform caption with hashtags and CTA).',
        contentStrategy: 'YOU own the content strategy. recentPosts has ALL posts from the past 14 days with full details and metrics. previousNotes has your strategic reasoning from last run — read it, build on it, revise it. Analyze everything and make your own call.',
        ordering: 'ORDER MATTERS. New posts are prepended to the queue and schedule-day picks from the top. Place your BEST strategic pick first.',
        noHardcodedMetrics: 'STRICT: Never include real metrics anywhere — no user counts, revenue, signup counts, view counts, day counts, or specific timeframes. All content must be evergreen.',
        slideRule: 'Slide 1 = hook (scroll-stopper). Slides 2-5 = storytelling arc (VARY this). Slide 6 = CTA.',
        formatField: 'Include "format": "<format_name>" in each post blueprint. Default is "slideshow". Check experiments.candidates for formats you can test. Activate experiments via strategy notes commands.',
        visualFeedback: 'recentPosts may include slideImageUrls arrays — these are public URLs to the actual rendered slides (with text overlays) hosted on Supabase. REVIEW THEM to see what your prompts actually produced. Compare visual quality to engagement metrics. Note which prompt styles produce good vs bad images and adjust your slidePrompts accordingly.',
        strategyNotes: 'After generating posts, output a --- STRATEGY_NOTES --- block with your updated strategic reasoning for this platform. What patterns are you seeing? What are you trying next and why? Include visual quality observations if you reviewed slideImages. Include experiment commands (ACTIVATE_EXPERIMENT, KILL_EXPERIMENT, GRADUATE_EXPERIMENT, ADD_CANDIDATE) if needed. This gets saved and fed back to you tomorrow.',
      } : {
        instructions: 'Generate COMPLETE post blueprints, not just hooks.',
        format: 'Each post needs: text (hook/opening line), postBody (the full post text — for Twitter keep under 280 chars or use thread array for threads, for LinkedIn keep under 700 chars, for Reddit write 2-4 paragraphs).',
        contentStrategy: 'YOU own the content strategy. recentPosts has ALL posts from the past 14 days with full details and metrics. previousNotes has your strategic reasoning from last run — read it, build on it, revise it. Analyze everything and make your own call.',
        ordering: 'ORDER MATTERS. New posts are prepended to the queue and schedule-day picks from the top. Place your BEST strategic pick first.',
        noHardcodedMetrics: 'STRICT: Never include real metrics anywhere — no user counts, revenue, signup counts, view counts, day counts, or specific timeframes. All content must be evergreen.',
        formatField: 'Include "format": "<format_name>" in each post blueprint. Default is "text-thread". Check experiments.candidates for formats you can test. Activate experiments via strategy notes commands.',
        strategyNotes: 'After generating posts, output a --- STRATEGY_NOTES --- block with your updated strategic reasoning for this platform. What patterns are you seeing? What are you trying next and why? What should you remember for the next run? Include experiment commands (ACTIVATE_EXPERIMENT, KILL_EXPERIMENT, GRADUATE_EXPERIMENT, ADD_CANDIDATE) if needed. This gets saved and fed back to you tomorrow.',
      },
      existingQueue: strategy.postQueue.map(h => h.text || h),
      experiments: buildExperimentContext(appName, platform, primaryMetric, getMetricValue, days),
      failureRules: (() => {
        const allRules = [];
        // Load shared cross-platform failures
        try {
          const sharedPath = paths.sharedFailuresPath(appName);
          const raw = JSON.parse(fs.readFileSync(sharedPath, 'utf-8'));
          const rules = Array.isArray(raw) ? raw : (raw.failures || []);
          allRules.push(...rules.map(r => typeof r === 'string' ? r : r.rule).filter(Boolean));
        } catch { /* no shared failures */ }
        // Load platform-specific failures
        try {
          const failPath = paths.failuresPath(appName, platform);
          const raw = JSON.parse(fs.readFileSync(failPath, 'utf-8'));
          const rules = Array.isArray(raw) ? raw : (raw.failures || []);
          allRules.push(...rules.map(r => typeof r === 'string' ? r : r.rule).filter(Boolean));
        } catch { /* no platform failures */ }
        // Deduplicate
        return [...new Set(allRules)];
      })(),
    }, null, 2));
    console.log('--- END_POSTS_NEEDED ---');
  }

  // ── 7. Save ───────────────────────────────────────────────────
  if (!dryRun) {
    saveJSON(postsFile, postsData);
    console.log(`✅ Wrote ${postsFile}`);
    saveJSON(strategyFile, strategy);
    console.log(`✅ Wrote ${strategyFile}`);
  }

  // ── 8. Report ─────────────────────────────────────────────────
  const totalMetric = postData.reduce((s, p) => s + getMetricValue(p), 0);
  const avgMetric = postData.length > 0 ? Math.round(totalMetric / postData.length) : 0;
  const postsWithData = postsData.posts.filter(p => getMetricValue(p) > 0).length;
  const statusCounts = {};
  const sourceCounts = {};
  for (const c of conversions) {
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
    sourceCounts[c.source || 'unknown'] = (sourceCounts[c.source || 'unknown'] || 0) + 1;
  }

  // Sort posts by metric for top/bottom display
  const sortedPosts = [...postData].sort((a, b) => getMetricValue(b) - getMetricValue(a));

  const reportLines = [
    `\n${'='.repeat(60)}`,
    `# Self-Improvement Report — ${appName}/${platform} — ${etDate(new Date())}`,
    '',
    `## Summary (last ${days} days)`,
    `- Posts analyzed: ${postData.length}`,
    `- Total ${primaryMetric}: ${totalMetric.toLocaleString()}`,
    `- Avg ${primaryMetric}/post: ${avgMetric.toLocaleString()}`,
    `- Posts tracked: ${postsData.posts.length} (${postsWithData} with data)`,
    `- New users: ${conversions.length} (${statusCounts.signup_only || 0} signup, ${statusCounts.trialing || 0} trialing, ${statusCounts.active || 0} paid, ${statusCounts.cancelled || 0} cancelled)`,
    `- Revenue: $${totalRevenue.toFixed(2)}`,
    '',
    `## Changes`,
    ...changelog.map(c => `- ${c}`),
    '',
  ];

  // Top posts
  if (sortedPosts.length > 0) {
    reportLines.push('## Top Posts');
    for (const p of sortedPosts.slice(0, 5)) {
      reportLines.push(`- ${p.name}: ${getMetricValue(p).toLocaleString()} ${primaryMetric}`);
    }
    reportLines.push('');
  }

  // Traffic
  if (phTotal > 0) {
    reportLines.push('## Website Traffic (PostHog)');
    reportLines.push(`- Total pageviews: ${phTotal}`);
    reportLines.push(`- From ${platform}: ${phFromPlatform} (${Math.round(phFromPlatform / phTotal * 100)}%)`);
    for (const s of phSources.slice(0, 5)) {
      reportLines.push(`- ${s.source}: ${s.count} views`);
    }
    reportLines.push('');
  }

  // Attribution — claim credit for utm_campaign=openclaw signups,
  // plus tiktok/instagram source matches (link-in-bio has no UTM tracking)
  const LINK_IN_BIO_PLATFORMS = ['tiktok', 'instagram'];
  if (conversions.length > 0) {
    const autoConversions = conversions.filter(c =>
      c.utmCampaign === 'openclaw' ||
      LINK_IN_BIO_PLATFORMS.includes(c.source)
    );
    const otherConversions = conversions.filter(c =>
      c.utmCampaign !== 'openclaw' &&
      !LINK_IN_BIO_PLATFORMS.includes(c.source)
    );

    if (autoConversions.length > 0) {
      reportLines.push('## Automation-Attributed Signups (utm_campaign=openclaw or link-in-bio platforms)');
      const autoSourceCounts = {};
      for (const c of autoConversions) autoSourceCounts[c.source || 'unknown'] = (autoSourceCounts[c.source || 'unknown'] || 0) + 1;
      for (const [src, count] of Object.entries(autoSourceCounts)) {
        const paidFromSrc = autoConversions.filter(c => c.source === src && c.status === 'active').length;
        const revFromSrc = autoConversions.filter(c => c.source === src).reduce((s, c) => s + (c.revenue || 0), 0);
        reportLines.push(`- **${src}**: ${count} signups, ${paidFromSrc} paid ($${revFromSrc.toFixed(2)})`);
      }
      reportLines.push('');
    }

    if (otherConversions.length > 0) {
      reportLines.push('## Other Signups (not automation-attributed)');
      const otherSourceCounts = {};
      for (const c of otherConversions) otherSourceCounts[c.source || 'unknown'] = (otherSourceCounts[c.source || 'unknown'] || 0) + 1;
      for (const [src, count] of Object.entries(otherSourceCounts)) {
        const campaign = otherConversions.find(c => (c.source || 'unknown') === src)?.utmCampaign;
        const campaignLabel = campaign ? ` (campaign=${campaign})` : '';
        reportLines.push(`- **${src}**: ${count} signups${campaignLabel}`);
      }
      reportLines.push('');
    }
  }

  // Post queue
  reportLines.push('## Hook Queue');
  for (let i = 0; i < strategy.postQueue.length; i++) {
    const h = strategy.postQueue[i];
    const q = '';
    reportLines.push(`${i + 1}. "${(h.text || h).substring(0, 80)}"${q}`);
  }
  reportLines.push('');

  // Platform-specific extras
  if (config.reportExtras) {
    const extras = config.reportExtras({ postData, postsData, strategy, conversions, totalRevenue, phSources, phTotal });
    if (extras && extras.length > 0) {
      reportLines.push(...extras, '');
    }
  }

  reportLines.push('='.repeat(60));

  const report = reportLines.join('\n');
  console.log(report);

  // Save report
  if (!dryRun) {
    if (!fs.existsSync(reportsDirectory)) fs.mkdirSync(reportsDirectory, { recursive: true });
    const reportPath = path.join(reportsDirectory, `${etDate(new Date())}-${appName}.md`);
    fs.writeFileSync(reportPath, report);
    console.log(`✅ Wrote ${reportPath}`);
  }

  if (dryRun) console.log('\n🏃 Dry run — no files written');
}

async function runSelfImprove(config) {
  try {
    await _runSelfImprove(config);
  } catch (e) {
    console.error(`\n❌ Fatal: ${e.message}\n${e.stack}`);
    process.exit(1);
  }
}

// CLI entry point: node self-improve-engine.js --app dropspace --platform tiktok --days 14
if (require.main === module) {
  const { getArg } = parseArgs();
  const platformName = getArg('platform');
  if (!platformName) {
    console.error('Usage: node self-improve-engine.js --app <name> --platform <platform> [--days 14] [--dry-run]');
    process.exit(1);
  }
  const platDef = getPlatformDef(platformName);
  runSelfImprove(platDef);
}

module.exports = { runSelfImprove };
