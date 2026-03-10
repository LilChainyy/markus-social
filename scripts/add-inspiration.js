#!/usr/bin/env node
/**
 * Add inspiration posts to an app's inspiration.json store.
 *
 * Usage (stdin JSON object):
 *   echo '{"text":"the full post","tags":["build-in-public"],"note":"why its good"}' | \
 *     node add-inspiration.js --app dropspace
 *
 * Stdin JSON fields:
 *   text:  The full post text (required)
 *   tags:  Array of tags (optional)
 *   note:  Why this post is good / what to learn from it (optional)
 *
 * Deduplicates against existing posts (case-insensitive first 50 chars).
 */

const fs = require('fs');
const { loadJSON, saveJSON, parseArgs } = require('./helpers');
const paths = require('./paths');

function main() {
  const { getArg } = parseArgs();

  const appName = getArg('app');
  if (!appName) {
    console.error('Usage: echo \'{"text":"...","tags":["..."],"note":"..."}\' | node add-inspiration.js --app <name>');
    process.exit(1);
  }

  const input = fs.readFileSync(0, 'utf-8').trim();
  if (!input) {
    console.error('No input on stdin. Pipe a JSON object: {"text":"..."}');
    process.exit(1);
  }

  const parsed = JSON.parse(input);
  if (!parsed.text || typeof parsed.text !== 'string') {
    console.error('Stdin JSON must have a "text" string field');
    process.exit(1);
  }

  const filePath = paths.inspirationPath(appName);
  const data = loadJSON(filePath, { posts: [], lastUpdated: null });

  // Dedup by case-insensitive first 50 chars
  const fingerprint = parsed.text.substring(0, 50).toLowerCase();
  const isDupe = data.posts.some(p => p.text.substring(0, 50).toLowerCase() === fingerprint);
  if (isDupe) {
    console.log(`  Duplicate — "${parsed.text.substring(0, 60)}..." already exists`);
    process.exit(0);
  }

  const entry = {
    text: parsed.text,
    addedAt: new Date().toISOString().split('T')[0],
    tags: parsed.tags || [],
    note: parsed.note || null,
  };

  data.posts.push(entry);
  data.lastUpdated = new Date().toISOString();

  saveJSON(filePath, data);
  console.log(`  Added: "${parsed.text.substring(0, 60)}..."`);
  console.log(`  Total inspiration posts: ${data.posts.length}`);
}

main();
