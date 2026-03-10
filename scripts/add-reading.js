#!/usr/bin/env node
/**
 * Manually add or update article content in readings.json.
 *
 * Usage (stdin JSON):
 *   echo '{"url":"https://openai.com/index/...","content":"pasted article text"}' | \
 *     node scripts/add-reading.js --app dropspace
 *
 * If a matching article exists (by URL): updates its content field.
 * If no match: creates a new entry (manual add).
 */

const fs = require('fs');
const { loadJSON, saveJSON, parseArgs } = require('./helpers');
const paths = require('./paths');

function main() {
  const { getArg } = parseArgs();

  const appName = getArg('app');
  if (!appName) {
    console.error('Usage: echo \'{"url":"...","content":"..."}\' | node scripts/add-reading.js --app <name>');
    process.exit(1);
  }

  const input = fs.readFileSync(0, 'utf-8').trim();
  if (!input) {
    console.error('No input on stdin. Pipe a JSON object: {"url":"...","content":"..."}');
    process.exit(1);
  }

  const parsed = JSON.parse(input);
  if (!parsed.url || typeof parsed.url !== 'string') {
    console.error('Stdin JSON must have a "url" string field');
    process.exit(1);
  }
  if (!parsed.content || typeof parsed.content !== 'string') {
    console.error('Stdin JSON must have a "content" string field');
    process.exit(1);
  }

  const readingsFile = paths.readingsPath(appName);
  const data = loadJSON(readingsFile, { articles: [], lastChecked: null });

  // Try to find existing article by URL
  const existing = data.articles.find(a => a.url === parsed.url);

  if (existing) {
    existing.content = parsed.content;
    existing.summary = parsed.content.substring(0, 200);
    console.log(`  Updated content for: "${existing.title}"`);
  } else {
    // Manual add — create new entry
    const title = parsed.title || new URL(parsed.url).pathname.split('/').pop().replace(/-/g, ' ') || 'Untitled';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
    data.articles.push({
      id: `manual--${slug}`,
      sourceId: 'manual',
      title,
      url: parsed.url,
      summary: parsed.content.substring(0, 200),
      content: parsed.content,
      fetchedAt: new Date().toISOString(),
      usedInPost: false,
    });
    console.log(`  Added new article: "${title}"`);
  }

  data.lastChecked = new Date().toISOString();
  saveJSON(readingsFile, data);
  console.log(`  Total articles: ${data.articles.length}`);
}

main();
