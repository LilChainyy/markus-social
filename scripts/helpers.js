/**
 * Shared helpers for all platform automation skills.
 *
 * Platform-specific helpers extend this base by providing their own HOOK_PATTERNS
 * and CTA patterns. Import from here for common utilities.
 */

// ── ET Timezone Helpers ──
const TZ = 'America/New_York';

function etDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function etHour(d) {
  return parseInt(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TZ }));
}

function etTimestamp(d) {
  return d.toLocaleString('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .replace(',', '').replace(' ', 'T').replace(/:/g, '-');
}

function isWeekday(d) {
  const day = new Date(d.toLocaleString('en-US', { timeZone: TZ })).getDay();
  return day >= 1 && day <= 5;
}

// ── JSON I/O ──
const fs = require('fs');
const path = require('path');

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return fallback; }
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ── CLI Helpers ──
function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  return {
    args,
    getArg(name) {
      const idx = args.indexOf(`--${name}`);
      return idx !== -1 ? args[idx + 1] : null;
    },
    hasFlag(name) {
      return args.includes(`--${name}`);
    }
  };
}

// ── Referrer → Platform Mapping ──
// Ordered array of tuples — more specific domains MUST come before general ones.
// Object key iteration order is spec-guaranteed for string keys in insertion order,
// but tuples are explicit and unambiguous.
const REFERRER_RULES = [
  ['tiktok.com', 'tiktok'],
  ['vm.tiktok', 'tiktok'],
  ['twitter.com', 'twitter'],
  ['x.com', 'twitter'],
  ['t.co', 'twitter'],
  ['instagram.com', 'instagram'],
  ['l.facebook.com', 'facebook'],
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['linkedin.com', 'linkedin'],
  ['lnkd.in', 'linkedin'],
  ['reddit.com', 'reddit'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['producthunt.com', 'producthunt'],
  ['news.ycombinator.com', 'hackernews'],
  // Google: specific before general (order matters)
  ['accounts.google', 'google_oauth'],
  ['tagassistant.google', 'google_tagassistant'],
  ['google.com/search', 'google_organic'],
  ['www.google', 'google_organic'],
  ['google.co.', 'google_organic'],
  ['google.com', 'google_other'],
  ['google.co', 'google_other'],
  ['bing.com', 'bing'],
];

function referrerToPlatform(referrer) {
  if (!referrer || referrer === '$direct') return 'direct';
  const domain = referrer.toLowerCase();
  for (const [pattern, source] of REFERRER_RULES) {
    if (domain.includes(pattern)) return source;
  }
  return domain;
}

// ── Math Helpers ──
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Failure Recording ──
function recordFailure(failuresPath, rule, context = {}) {
  try {
    const data = loadJSON(failuresPath, { failures: [] });
    data.failures = data.failures || [];
    if (data.failures.some(f => f.rule === rule)) return;
    data.failures.push({ rule, date: new Date().toISOString(), ...context });
    if (data.failures.length > 50) data.failures = data.failures.slice(-50);
    saveJSON(failuresPath, data);
    console.log(`  📝 Recorded failure rule: ${rule}`);
  } catch (e) {
    console.warn(`  ⚠️ Could not record failure: ${e.message}`);
  }
}

module.exports = {
  TZ, etDate, etHour, etTimestamp, isWeekday,
  loadJSON, saveJSON,
  parseArgs,
  referrerToPlatform,
  mean,
  recordFailure,
};
