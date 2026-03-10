#!/usr/bin/env node
/**
 * Run Readings — check tracked sources for new articles, fetch content.
 *
 * Usage:
 *   node scripts/run-readings.js --app dropspace [--dry-run]
 *
 * For each enabled source in sources.json:
 *   - html-listing: scrape listing page for article links, fetch full articles
 *   - rss: parse RSS feed for titles + summaries (alert-only if unscrapable)
 *
 * New articles are stored in readings.json.
 * Unscrapable articles print an alert with paste instructions.
 */

const fs = require('fs');
const { loadJSON, saveJSON, parseArgs } = require('./helpers');
const paths = require('./paths');

// ── HTML helpers ──────────────────────────────────────────────

/** Strip HTML tags, scripts, styles, nav/header/footer, collapse whitespace */
function htmlToText(html) {
  let text = html;
  // Remove script, style, nav, header, footer blocks
  text = text.replace(/<(script|style|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** Extract article links from Anthropic engineering listing page */
function extractAnthropicLinks(html, baseUrl) {
  const links = [];
  // Match href="/engineering/..." patterns
  const regex = /href="(\/engineering\/[^"]+)"/g;
  let match;
  const seen = new Set();
  while ((match = regex.exec(html)) !== null) {
    const path = match[1];
    if (!seen.has(path)) {
      seen.add(path);
      links.push(baseUrl + path);
    }
  }
  return links;
}

/** Extract title from an HTML page */
function extractTitle(html) {
  // Try <h1> first
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) return htmlToText(h1Match[1]).trim();
  // Fall back to <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return htmlToText(titleMatch[1]).trim();
  return 'Untitled';
}

// ── RSS helpers ──────────────────────────────────────────────

/** Parse RSS XML into items (simple regex-based, no dependencies) */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : null;
    };
    items.push({
      title: get('title') || 'Untitled',
      link: get('link'),
      description: get('description') || '',
      pubDate: get('pubDate') || null,
    });
  }
  return items;
}

// ── Slug generation ──────────────────────────────────────────

function makeId(sourceId, title) {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return `${sourceId}--${slug}`;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { getArg, hasFlag } = parseArgs();
  const appName = getArg('app');
  const dryRun = hasFlag('dry-run');

  if (!appName) {
    console.error('Usage: node scripts/run-readings.js --app <name> [--dry-run]');
    process.exit(1);
  }

  const sourcesFile = paths.sourcesPath(appName);
  if (!fs.existsSync(sourcesFile)) {
    console.error(`No sources.json found at ${sourcesFile}`);
    process.exit(1);
  }

  const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf-8'));
  const readingsFile = paths.readingsPath(appName);
  const readings = loadJSON(readingsFile, { articles: [], lastChecked: null });

  const existingUrls = new Set(readings.articles.map(a => a.url));
  const counts = { fetched: 0, alerts: 0 };

  for (const source of sources.sources) {
    if (!source.enabled) continue;

    console.log(`\n📡 Checking: ${source.name} (${source.type})`);

    try {
      if (source.type === 'rss') {
        await processRSS(source, readings, existingUrls, dryRun, counts);
      } else if (source.type === 'html-listing') {
        await processHTMLListing(source, readings, existingUrls, dryRun, counts);
      } else {
        console.warn(`  ⚠️  Unknown source type: ${source.type}`);
      }
    } catch (e) {
      console.error(`  ❌ Failed to process ${source.name}: ${e.message}`);
    }
  }

  readings.lastChecked = new Date().toISOString();

  if (!dryRun) {
    saveJSON(readingsFile, readings);
    console.log(`\n✅ Saved ${readingsFile}`);
  } else {
    console.log('\n🏃 Dry run — no files written');
  }

  console.log(`\n📊 ${counts.fetched} new articles fetched, ${counts.alerts} alerts (unscrapable)`);
}

async function processRSS(source, readings, existingUrls, dryRun, counts) {
  const res = await fetch(source.feedUrl);
  if (!res.ok) {
    console.error(`  ❌ RSS fetch failed: ${res.status} ${res.statusText}`);
    return;
  }

  const xml = await res.text();
  const items = parseRSS(xml);
  console.log(`  Found ${items.length} RSS entries`);

  let newCount = 0;
  for (const item of items) {
    if (!item.link || existingUrls.has(item.link)) continue;

    const article = {
      id: makeId(source.id, item.title),
      sourceId: source.id,
      title: item.title,
      url: item.link,
      summary: (item.description || '').substring(0, 200),
      content: null, // unscrapable — alert only
      fetchedAt: new Date().toISOString(),
      usedInPost: false,
    };

    // If source is scrapable, try to fetch full content
    if (source.scrapable) {
      try {
        const articleRes = await fetch(item.link);
        if (articleRes.ok) {
          const html = await articleRes.text();
          article.content = htmlToText(html);
        }
      } catch (e) {
        console.warn(`  ⚠️  Could not fetch article: ${e.message}`);
      }
    }

    if (!dryRun) {
      readings.articles.push(article);
      existingUrls.add(item.link);
    }
    newCount++;

    if (!article.content) {
      counts.alerts++;
      console.log(`  🔔 New article detected (can't auto-read):`);
      console.log(`     "${item.title}" — ${item.link}`);
      console.log(`     Paste content: echo '{"url":"${item.link}","content":"paste here"}' | node scripts/add-reading.js --app dropspace`);
    } else {
      counts.fetched++;
      console.log(`  ✅ Fetched: "${item.title}"`);
    }
  }

  console.log(`  ${newCount} new articles from ${source.name}`);
}

async function processHTMLListing(source, readings, existingUrls, dryRun, counts) {
  const res = await fetch(source.listingUrl);
  if (!res.ok) {
    console.error(`  ❌ Listing fetch failed: ${res.status} ${res.statusText}`);
    return;
  }

  const html = await res.text();
  let articleUrls;

  // Source-specific link extraction
  if (source.id === 'anthropic-engineering') {
    articleUrls = extractAnthropicLinks(html, source.articleBaseUrl);
  } else {
    // Generic: extract all links under the listing, filter by base URL
    const regex = /href="([^"]+)"/g;
    let match;
    articleUrls = [];
    const seen = new Set();
    while ((match = regex.exec(html)) !== null) {
      let url = match[1];
      if (url.startsWith('/')) url = source.articleBaseUrl + url;
      if (url.startsWith(source.articleBaseUrl) && !seen.has(url)) {
        seen.add(url);
        articleUrls.push(url);
      }
    }
  }

  console.log(`  Found ${articleUrls.length} article links`);

  let newCount = 0;
  for (const url of articleUrls) {
    if (existingUrls.has(url)) continue;

    const article = {
      id: null,
      sourceId: source.id,
      title: 'Untitled',
      url,
      summary: '',
      content: null,
      fetchedAt: new Date().toISOString(),
      usedInPost: false,
    };

    if (source.scrapable) {
      try {
        const articleRes = await fetch(url);
        if (articleRes.ok) {
          const articleHtml = await articleRes.text();
          article.title = extractTitle(articleHtml);
          article.content = htmlToText(articleHtml);
          article.summary = article.content.substring(0, 200);
        } else {
          console.warn(`  ⚠️  Article returned ${articleRes.status}: ${url}`);
          continue;
        }
      } catch (e) {
        console.warn(`  ⚠️  Could not fetch article: ${e.message}`);
        continue;
      }
    }

    article.id = makeId(source.id, article.title);

    if (!dryRun) {
      readings.articles.push(article);
      existingUrls.add(url);
    }
    newCount++;

    if (article.content) {
      counts.fetched++;
      console.log(`  ✅ Fetched: "${article.title}"`);
    } else {
      counts.alerts++;
      console.log(`  🔔 New article detected (can't auto-read):`);
      console.log(`     "${article.title}" — ${url}`);
      console.log(`     Paste content: echo '{"url":"${url}","content":"paste here"}' | node scripts/add-reading.js --app dropspace`);
    }
  }

  console.log(`  ${newCount} new articles from ${source.name}`);
}

main().catch(e => {
  console.error(`\n❌ Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
