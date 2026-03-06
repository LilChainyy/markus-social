#!/usr/bin/env node
/**
 * Add posts to a platform's strategy.json queue atomically.
 * Also saves strategy notes and cross-platform insights in the same write.
 *
 * Usage (stdin JSON object):
 *   echo '{"posts":[...], "notes":"...", "crossNotes":"..."}' | \
 *     node add-posts.js --app dropspace --platform facebook
 *
 * Stdin JSON fields:
 *   posts:      Array of post objects [{text, ...}, ...]
 *   notes:      Strategy notes for this platform (saved to strategy.notes)
 *   crossNotes: Insights for other platforms (saved to insights.json)
 *
 * Deduplicates against existing queue + posting history.
 * Respects MAX_QUEUE (14) cap.
 */

const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON, etDate, parseArgs } = require('./helpers');
const paths = require('./paths');
const { getVisualPlatforms } = require('./platforms');
const { parseExperimentCommands, applyExperimentCommands } = require('./experiments');

const MAX_QUEUE = 14;

// Platform-specific char limits — reject posts that exceed these at write time
const CHAR_LIMITS = {
  twitter: { postBody: 280, threadTweet: 280 },
  linkedin: { postBody: 3000 },
  reddit: { postBody: 3000 },
  tiktok: { caption: 4000 },
  instagram: { caption: 2200 },
  facebook: { caption: 3000 },
};

function checkCharLimits(post, platform) {
  const limits = CHAR_LIMITS[platform];
  if (!limits) return null;

  // Text platform postBody check
  if (post.postBody && limits.postBody) {
    if (platform === 'twitter' && post.postBody.includes('\n\n')) {
      // Check each tweet in thread
      const tweets = post.postBody.split('\n\n');
      for (let i = 0; i < tweets.length; i++) {
        if (tweets[i].length > limits.threadTweet) {
          return `tweet ${i + 1} is ${tweets[i].length}/${limits.threadTweet} chars`;
        }
      }
    } else if (post.postBody.length > limits.postBody) {
      return `postBody is ${post.postBody.length}/${limits.postBody} chars`;
    }
  }

  // Visual platform caption check
  if (post.caption && limits.caption && post.caption.length > limits.caption) {
    return `caption is ${post.caption.length}/${limits.caption} chars`;
  }

  return null;
}

function main() {
  const { getArg } = parseArgs();

  const appName = getArg('app');
  const platform = getArg('platform');

  if (!appName || !platform) {
    console.error('Usage: echo \'{"posts":[...], "notes":"...", "crossNotes":"..."}\' | node add-posts.js --app <name> --platform <platform>');
    process.exit(1);
  }

  const strategyFile = paths.strategyPath(appName, platform);
  const postsFile = paths.postsPath(appName, platform);

  // Read stdin JSON: {posts: [...], notes?: "...", crossNotes?: "..."}
  let newPosts;
  let effectiveNotes = null;
  let effectiveCrossNotes = null;

  const input = fs.readFileSync(0, 'utf-8').trim();
  if (!input) {
    console.error('No input on stdin. Pipe a JSON object: {"posts":[...], "notes":"...", "crossNotes":"..."}');
    process.exit(1);
  }

  const parsed = JSON.parse(input);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (!Array.isArray(parsed.posts)) {
      console.error('Stdin JSON must have a "posts" array: {"posts":[...], "notes":"...", "crossNotes":"..."}');
      process.exit(1);
    }
    newPosts = parsed.posts;
    if (parsed.notes) effectiveNotes = parsed.notes;
    if (parsed.crossNotes) effectiveCrossNotes = parsed.crossNotes;
  } else {
    console.error('Stdin must be a JSON object: {"posts":[...], "notes":"...", "crossNotes":"..."}');
    process.exit(1);
  }

  // Load current state (fresh read — atomic)
  const strategy = loadJSON(strategyFile, { postQueue: [] });
  const history = loadJSON(postsFile, { posts: [] });

  // Build dedup set from queue + posting history
  const existing = new Set([
    ...(strategy.postQueue || []).map(h => (h.text || h).toLowerCase()),
    ...history.posts.map(p => (p.text || '').toLowerCase()),
  ]);

  let added = 0;
  let skipped = 0;

  let rejected = 0;

  for (const post of newPosts) {
    const text = post.text || post;
    if (!text || typeof text !== 'string') { skipped++; continue; }
    if (existing.has(text.toLowerCase())) {
      console.log(`  ⏭ Duplicate: "${text.substring(0, 60)}..."`);
      skipped++;
      continue;
    }

    // Enforce char limits at write time
    const charError = typeof post === 'object' ? checkCharLimits(post, platform) : null;
    if (charError) {
      console.log(`  ❌ Rejected: "${text.substring(0, 50)}..." — ${charError}`);
      rejected++;
      continue;
    }

    if ((strategy.postQueue || []).length >= MAX_QUEUE) {
      console.log(`  ⚠️ Queue full (${MAX_QUEUE}) — stopping`);
      break;
    }

    const entry = typeof post === 'string' ? {
      text: post,
      source: 'agent-generated',
      addedAt: etDate(new Date()),
    } : {
      ...post,
      source: post.source || 'agent-generated',
      addedAt: post.addedAt || etDate(new Date()),
    };

    strategy.postQueue = strategy.postQueue || [];
    strategy.postQueue.unshift(entry);
    existing.add(text.toLowerCase());
    added++;
    console.log(`  ✅ Added: "${text.substring(0, 60)}..."`);
  }

  // Save strategy notes atomically with queue update
  if (effectiveNotes) {
    strategy.notes = effectiveNotes;
    strategy.notesUpdatedAt = new Date().toISOString();
    console.log(`  📝 Strategy notes saved (${effectiveNotes.length} chars)`);
  }

  // Save atomically
  saveJSON(strategyFile, strategy);
  const parts = [`${added} added`, `${skipped} skipped`];
  if (rejected > 0) parts.push(`${rejected} rejected (char limit)`);
  console.log(`\n✅ Done: ${parts.join(', ')}. Queue: ${strategy.postQueue.length}/${MAX_QUEUE}`);

  // Parse and apply experiment commands from strategy notes
  if (effectiveNotes) {
    const expCommands = parseExperimentCommands(effectiveNotes);
    if (expCommands.length > 0) {
      applyExperimentCommands(appName, platform, expCommands);
    }
  }

  // Save cross-platform insights (separate file, same operation)
  if (effectiveCrossNotes && platform) {
    const insightsFile = paths.insightsPath(appName);
    const insights = loadJSON(insightsFile, { lastUpdated: null });
    insights[platform] = effectiveCrossNotes;
    insights.lastUpdated = new Date().toISOString().split('T')[0];
    saveJSON(insightsFile, insights);
    console.log(`  🔗 Cross-platform insights saved for ${platform}`);
  }
}

main();
