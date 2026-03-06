#!/usr/bin/env node
/**
 * Runner: X Research — search once, distribute to all platforms.
 *
 * Searches X via Bird CLI (or API fallback) ONCE, then saves
 * research signals to x-research-signals.json for self-improve to consume.
 *
 * Usage: node run-x-research.js --app dropspace [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pathsLib = require('./paths');
const { getAllPlatforms } = require('./platforms');
const PLATFORM_DIRS = getAllPlatforms();
const HOME = process.env.HOME || '';

// Default search queries + competitors — overridden by app.json xResearch config
const DEFAULT_SEARCH_QUERIES = [
  '#buildinpublic launch tool',
  '#indiehackers social media automation',
  'social media scheduling tool',
  'cross-platform posting tool',
  'launch product multiple platforms',
];

const DEFAULT_COMPETITOR_HANDLES = ['buffer', 'hootsuite', 'metricool'];
const MAX_TWEETS_PER_QUERY = 15;

// --- Args ---
const { parseArgs } = require('./helpers');
const { getArg, hasFlag } = parseArgs();
const appName = getArg('app');
if (!appName) { console.error('ERROR: --app required'); process.exit(1); }
const dryRun = hasFlag('dry-run');

// --- Bird / API helpers ---
function birdCmd(subcmd, extraArgs, count = 10) {
  const authToken = process.env.BIRD_AUTH_TOKEN;
  const ct0 = process.env.BIRD_CT0;
  if (!authToken || !ct0) return null;
  try {
    return JSON.parse(execSync(
      `bird ${subcmd} ${extraArgs} -n ${count} --json --auth-token "${authToken}" --ct0 "${ct0}" --plain 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024, timeout: 30000 }
    ));
  } catch { return null; }
}

function xApiSearch(query, count = 10) {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return null;
  try {
    const result = JSON.parse(execSync(
      `curl -s "https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${count}&tweet.fields=public_metrics,created_at,author_id" -H "Authorization: Bearer ${bearer}"`,
      { encoding: 'utf-8', timeout: 15000 }
    ));
    return (result.data || []).map(t => ({
      text: t.text,
      likeCount: t.public_metrics?.like_count || 0,
      retweetCount: t.public_metrics?.retweet_count || 0,
      replyCount: t.public_metrics?.reply_count || 0,
      viewCount: t.public_metrics?.impression_count || 0,
      createdAt: t.created_at,
      id: t.id,
      author: { username: t.author_id },
    }));
  } catch { return null; }
}

function extractHook(tweet) {
  const text = tweet.text || '';
  const firstLine = text.split(/[\n\r]/).filter(l => l.trim())[0] || '';
  return firstLine.replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
}

function getEngagement(tweet) {
  return {
    likes: tweet.likeCount || tweet.like_count || 0,
    retweets: tweet.retweetCount || tweet.retweet_count || 0,
    replies: tweet.replyCount || tweet.reply_count || 0,
    views: tweet.viewCount || tweet.impression_count || 0,
  };
}

// --- Cache: only search X once per process ---
let _xResearchCache = null;
let _xResearchCacheKey = null;

// --- Exported function for inline use by self-improve ---
async function runXResearchInline(appName, platformDirs) {
  const cacheKey = `${appName}-${new Date().toISOString().split('T')[0]}`;
  if (_xResearchCache && _xResearchCacheKey === cacheKey) {
    console.log(`🐦 X Research (cached) — reusing results from earlier this run`);
    return _xResearchCache;
  }
  const today = new Date().toISOString().split('T')[0];
  console.log(`🐦 X Research (inline) — ${appName} (${today})`);

  // Load search config from app.json, fall back to defaults
  const appConfig = pathsLib.loadAppConfig(appName);
  const searchQueries = appConfig?.xResearch?.queries || DEFAULT_SEARCH_QUERIES;
  const competitorHandles = appConfig?.xResearch?.competitors || DEFAULT_COMPETITOR_HANDLES;

  // Search niche queries — collect raw tweets for analysis
  const allTweets = [];
  const competitorHooks = {};
  let tweetsScanned = 0;

  for (const query of searchQueries) {
    let tweets = birdCmd('search', JSON.stringify(query), MAX_TWEETS_PER_QUERY);
    let source = 'bird';
    if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
      tweets = xApiSearch(query, MAX_TWEETS_PER_QUERY);
      source = 'x-api';
    }
    if (!tweets || tweets.length === 0) continue;
    tweetsScanned += tweets.length;

    for (const tweet of tweets) {
      const eng = getEngagement(tweet);
      const hook = extractHook(tweet);
      const fullText = tweet.text || '';
      if (!hook || hook.length < 15) continue;
      allTweets.push({
        hook,
        fullText: fullText.substring(0, 300),
        likes: eng.likes,
        retweets: eng.retweets,
        views: eng.views,
        engagement: eng.likes + eng.retweets * 2,
        author: tweet.author?.username || 'unknown',
        query,
      });
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Competitor content
  for (const handle of competitorHandles) {
    let tweets = birdCmd('user-tweets', handle, 15);
    if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
      tweets = birdCmd('search', `"from:${handle}"`, 10);
      if (!tweets) tweets = [];
    }
    if (tweets.length === 0) continue;
    competitorHooks[handle] = tweets.map(t => ({
      text: extractHook(t),
      likes: getEngagement(t).likes,
      views: getEngagement(t).views,
    })).filter(h => h.text && h.text.length >= 15);
    await new Promise(r => setTimeout(r, 1500));
  }

  // --- Analyze: extract signals, not raw hooks ---
  const MIN_ENGAGEMENT = 5;
  const topTweets = allTweets
    .filter(t => t.likes >= MIN_ENGAGEMENT)
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 20);

  // Extract trending angles (what themes/patterns get engagement)
  const angles = [];
  const anglePatterns = [
    { pattern: /nobody\s+(told|tells|warned)/i, angle: 'hidden truth / nobody told me' },
    { pattern: /i\s+(built|shipped|launched|created)/i, angle: 'build-in-public / I made this' },
    { pattern: /\b(mistake|lesson|learned|wrong|failed)\b/i, angle: 'failure/lesson storytelling' },
    { pattern: /\b(how\s+to|guide|step|tutorial)\b/i, angle: 'educational / how-to' },
    { pattern: /\b(unpopular|hot take|controversial)\b/i, angle: 'contrarian / hot take' },
    { pattern: /\b(pov|imagine|picture this)\b/i, angle: 'POV / immersive scenario' },
    { pattern: /\b(vs|versus|compared|alternative|better than)\b/i, angle: 'comparison / alternative' },
    { pattern: /\b(spent|wasted|lost)\s+\d+\s*(hours?|days?|weeks?|months?)\b/i, angle: 'time-waste pain point' },
    { pattern: /\$\d+|\d+\s*(users?|signups?|customers?|mrr)\b/i, angle: 'real numbers / data transparency' },
    { pattern: /\b(solo\s+founder|indie\s*hack|bootstrapp)/i, angle: 'solo founder identity' },
    { pattern: /\b(automat|one.click|instantly|in\s+seconds?)\b/i, angle: 'automation / speed transformation' },
  ];

  for (const tweet of topTweets) {
    for (const { pattern, angle } of anglePatterns) {
      if (pattern.test(tweet.hook) || pattern.test(tweet.fullText)) {
        const existing = angles.find(a => a.angle === angle);
        if (existing) {
          existing.count++;
          existing.totalEngagement += tweet.engagement;
          existing.examples.push({ text: tweet.hook.substring(0, 80), likes: tweet.likes });
          if (existing.examples.length > 3) existing.examples.shift();
        } else {
          angles.push({
            angle,
            count: 1,
            totalEngagement: tweet.engagement,
            examples: [{ text: tweet.hook.substring(0, 80), likes: tweet.likes }],
          });
        }
      }
    }
  }

  // Extract competitor positioning
  const competitorPositioning = [];
  for (const [handle, hooks] of Object.entries(competitorHooks)) {
    if (hooks.length === 0) continue;
    const topHook = hooks.sort((a, b) => (b.likes || 0) - (a.likes || 0))[0];
    const themes = hooks.slice(0, 5).map(h => h.text).join(' ');
    competitorPositioning.push({
      handle,
      hookCount: hooks.length,
      topHookLikes: topHook?.likes || 0,
      topHookText: topHook?.text?.substring(0, 80) || '',
      themes: themes.substring(0, 200),
    });
  }

  // Sort angles by total engagement
  angles.sort((a, b) => b.totalEngagement - a.totalEngagement);

  const signals = {
    date: today,
    tweetsScanned,
    topTweetCount: topTweets.length,
    trendingAngles: angles.slice(0, 8),
    competitorPositioning,
    topExamples: topTweets.slice(0, 5).map(t => ({
      text: t.hook.substring(0, 100),
      likes: t.likes,
      author: t.author,
    })),
  };

  console.log(`🐦 X Research done — ${tweetsScanned} tweets, ${topTweets.length} high-engagement, ${angles.length} angles found, ${competitorPositioning.length} competitors`);
  if (angles.length > 0) {
    console.log('   📊 Top angles:');
    for (const a of angles.slice(0, 4)) {
      console.log(`      ${a.angle} (${a.count} tweets, ${a.totalEngagement} total eng)`);
    }
  }

  const result = { signals, competitorHooks, tweetsScanned, date: today };
  _xResearchCache = result;
  _xResearchCacheKey = cacheKey;
  return result;
}

module.exports = { runXResearchInline };

// --- Standalone runner ---
// Usage: node run-x-research.js --app dropspace [--dry-run]
// Saves signals to ~/x-research-signals.json for self-improve to read
if (require.main === module) {
  (async () => {
    const result = await runXResearchInline(appName, PLATFORM_DIRS);

    // Save signals file
    const signalsPath = pathsLib.xResearchSignalsPath(appName);
    if (!hasFlag('dry-run')) {
      fs.writeFileSync(signalsPath, JSON.stringify({
        ...result,
        savedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`\n💾 Saved signals to ${signalsPath}`);
    }

    // Save research snapshot
    const researchDir = pathsLib.researchDir(appName, 'twitter');
    if (!fs.existsSync(researchDir)) fs.mkdirSync(researchDir, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    if (!hasFlag('dry-run')) {
      fs.writeFileSync(
        path.join(researchDir, `x-research-${today}.json`),
        JSON.stringify(result.signals || {}, null, 2)
      );
    }

    console.log('\n🐦 Done.');
  })().catch(e => {
    console.error(`\n❌ Fatal: ${e.message}`);
    process.exit(1);
  });
}
