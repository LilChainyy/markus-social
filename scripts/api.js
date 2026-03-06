/**
 * Shared API clients for Dropspace, Stripe, Supabase, and OpenAI.
 * All platform automations use these same clients.
 */

const { referrerToPlatform: classifyReferrer } = require('./helpers');

const DROPSPACE_URL = 'https://api.dropspace.dev';

// Throttle: minimum ms between consecutive Dropspace API calls
const DROPSPACE_THROTTLE_MS = 200;
let _lastDropspaceCallMs = 0;

/**
 * Dropspace API caller with built-in throttling.
 *   dropspaceRequest(method, endpoint, body, key)
 *   dropspaceRequest(method, endpoint, null, key)  — for GET/DELETE
 */
async function dropspaceRequest(method, endpoint, body = null, key = undefined) {
  if (!key) throw new Error('DROPSPACE_API_KEY not provided');

  // Throttle: wait if last call was too recent
  const now = Date.now();
  const elapsed = now - _lastDropspaceCallMs;
  if (elapsed < DROPSPACE_THROTTLE_MS) {
    await new Promise(r => setTimeout(r, DROPSPACE_THROTTLE_MS - elapsed));
  }
  _lastDropspaceCallMs = Date.now();

  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(`${DROPSPACE_URL}${endpoint}`, opts);
    if (res.status === 429 && attempt < 2) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0');
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt + 1) * 1000;
      console.log(`  ⏳ Rate limited on ${endpoint} — retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      _lastDropspaceCallMs = Date.now();
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Dropspace ${endpoint}: ${res.status} ${text.slice(0, 500)}`); }
    if (!res.ok) throw new Error(`Dropspace ${endpoint}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
}

async function stripeAPI(endpoint, key) {
  if (!key) return null;
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    headers: { 'Authorization': `Basic ${Buffer.from(key + ':').toString('base64')}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabaseSQL(sql, token, projectId) {
  if (!token || !projectId) return null;
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchPostHogReferrers(posthogKey, projectId, days = 14) {
  if (!posthogKey || !projectId) return {};
  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    // Paginate to collect ALL events (PostHog returns max 1000 per page)
    let allResults = [];
    let url = `https://us.posthog.com/api/projects/${projectId}/events/?event=$pageview&limit=1000&after=${after}`;
    const MAX_PAGES = 10; // Safety cap: 10,000 events max
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${posthogKey}` } });
      if (!res.ok) break;
      const data = await res.json();
      const results = data.results || [];
      allResults = allResults.concat(results);
      if (!data.next) break; // No more pages
      url = data.next;
    }
    if (allResults.length >= MAX_PAGES * 1000) {
      console.warn(`  ⚠️ PostHog pagination cap hit (${allResults.length} events). Results may be truncated. Consider switching to Insights API.`);
    }
    const byReferrer = {};
    for (const e of allResults) {
      const ref = e.properties?.$referrer || '';
      const source = classifyReferrer(ref);
      if (!byReferrer[source]) byReferrer[source] = 0;
      byReferrer[source]++;
    }
    return byReferrer;
  } catch (e) {
    console.warn(`  ⚠️ PostHog fetch failed: ${e.message}`);
    return {};
  }
}

// Referrer classification — single source of truth in helpers.js (imported at top)


/**
 * Fetch all recent launches for a specific platform and app.
 */
async function fetchRecentLaunches(dropspaceKey, platform, cutoff, knownLaunchIds, appUrl, postQueueTexts) {
  let allLaunches = [];
  let page = 1;
  while (true) {
    const res = await dropspaceRequest('GET', `/launches?page=${page}&page_size=100`, null, dropspaceKey);
    allLaunches = allLaunches.concat(res.data);
    // Stop early if we've passed the cutoff date (launches are sorted newest-first)
    const lastLaunch = res.data[res.data.length - 1];
    if (lastLaunch && new Date(lastLaunch.created_at) < cutoff) break;
    if (page >= res.pagination.total_pages) break;
    page++;
  }

  return allLaunches.filter(l => {
    const created = new Date(l.created_at);
    if (created < cutoff) return false;
    if (!l.platforms || !l.platforms.includes(platform)) return false;
    if (!['completed', 'partial'].includes(l.status)) return false;
    if (knownLaunchIds.has(l.id)) return true; // Already tracked — update metrics
    if (appUrl && l.product_url && l.product_url.toLowerCase().includes(appUrl)) return true;
    if (l.name && postQueueTexts.has(l.name.toLowerCase())) return true;
    if (!appUrl) return true;
    return false;
  });
}

/**
 * Fetch user-level attribution data from Supabase + Stripe.
 */
async function fetchAttributionData(cutoff, profile, supabaseToken, supabaseProjectId, stripeKey) {
  const { referrerToPlatform } = require('./helpers');
  const productIds = profile.stripe?.productIds || [];
  let conversions = [];
  let totalRevenue = 0;

  // Test email patterns from app.json or defaults
  const configPatterns = profile.testEmailPatterns || [];
  const TEST_EMAIL_PATTERNS = configPatterns.length > 0
    ? configPatterns.map(p => new RegExp(p, 'i'))
    : [/system@/i, /test@/i];

  if (supabaseToken && supabaseProjectId) {
    const sinceISO = cutoff.toISOString();
    const newUsers = await supabaseSQL(
      `SELECT id, email, stripe_customer_id, created_at, signup_referrer, signup_utm_source, signup_utm_medium, signup_utm_campaign FROM profiles WHERE created_at >= '${sinceISO}' ORDER BY created_at ASC`,
      supabaseToken, supabaseProjectId
    );

    if (newUsers && newUsers.length > 0) {
      const realUsers = newUsers.filter(u =>
        u.email && !TEST_EMAIL_PATTERNS.some(p => p.test(u.email))
      );
      const filtered = newUsers.length - realUsers.length;
      console.log(`👤 Found ${newUsers.length} new Supabase users (${filtered} test/system excluded)`);

      // PostHog first-touch enrichment for users with unknown source
      const posthogKey = process.env.POSTHOG_PERSONAL_API_KEY;
      const posthogProject = profile.posthog?.projectId;

      for (const user of realUsers) {
        let source = 'unknown';
        let firstTouchSource = null;
        if (user.signup_utm_source) source = user.signup_utm_source;
        else if (user.signup_referrer) source = referrerToPlatform(user.signup_referrer);

        // If source is unknown, check PostHog for first-touch referrer
        if (source === 'unknown' && posthogKey && posthogProject) {
          try {
            const phRes = await fetch(
              `https://us.posthog.com/api/projects/${posthogProject}/persons/?distinct_id=${user.id}`,
              { headers: { 'Authorization': `Bearer ${posthogKey}` } }
            );
            if (phRes.ok) {
              const phData = await phRes.json();
              const person = phData.results?.[0];
              if (person) {
                const props = person.properties || {};
                const initialUtm = props.$initial_utm_source;
                const initialRef = props.$initial_referrer;
                const initialDomain = props.$initial_referring_domain;
                if (initialUtm) {
                  source = initialUtm;
                  firstTouchSource = `posthog:utm:${initialUtm}`;
                } else if (initialRef && initialRef !== '$direct') {
                  source = referrerToPlatform(initialRef);
                  firstTouchSource = `posthog:ref:${initialDomain || initialRef}`;
                } else if (initialRef === '$direct') {
                  source = 'direct';
                  firstTouchSource = 'posthog:direct';
                }
              }
            }
          } catch (e) {
            // Silently continue — PostHog enrichment is best-effort
          }
        }

        const conv = {
          userId: user.id,
          email: user.email,
          signupTime: new Date(user.created_at).getTime(),
          stripeCustomerId: user.stripe_customer_id,
          revenue: 0,
          status: 'signup_only',
          plan: null,
          source,
          firstTouchSource,
          referrerDomain: user.signup_referrer || null,
          utmSource: user.signup_utm_source || null,
          utmMedium: user.signup_utm_medium || null,
          utmCampaign: user.signup_utm_campaign || null,
        };

        if (user.stripe_customer_id && stripeKey) {
          const subs = await stripeAPI(`/subscriptions?customer=${user.stripe_customer_id}&limit=10`, stripeKey);
          if (subs?.data?.length > 0) {
            for (const sub of subs.data) {
              if (productIds.length > 0) {
                const subProducts = sub.items?.data?.map(i => i.price?.product) || [];
                if (!subProducts.some(p => productIds.includes(p))) continue;
              }
              conv.plan = sub.items?.data?.[0]?.price?.id || null;
              if (sub.status === 'trialing') conv.status = 'trialing';
              else if (sub.status === 'active') {
                conv.status = 'active';
                const invoices = await stripeAPI(`/invoices?subscription=${sub.id}&status=paid&limit=10`, stripeKey);
                if (invoices?.data) conv.revenue = invoices.data.reduce((s, inv) => s + (inv.amount_paid / 100), 0);
              } else if (['canceled', 'past_due'].includes(sub.status)) conv.status = 'cancelled';
            }
          }
          if (conv.revenue === 0) {
            const charges = await stripeAPI(`/charges?customer=${user.stripe_customer_id}&limit=10`, stripeKey);
            if (charges?.data) {
              const paid = charges.data.filter(c => c.paid && !c.refunded);
              conv.revenue = paid.reduce((s, c) => s + (c.amount / 100), 0);
              if (conv.revenue > 0 && conv.status === 'signup_only') conv.status = 'active';
            }
          }
        }

        conversions.push(conv);
        totalRevenue += conv.revenue;
      }
    } else {
      console.log(`👤 No new Supabase users in attribution window`);
    }
  } else if (stripeKey) {
    console.log(`⚠️  No Supabase — using timestamp-based Stripe attribution`);
    const since = Math.floor(cutoff.getTime() / 1000);
    const chargesRes = await stripeAPI(`/charges?limit=100&created[gte]=${since}`, stripeKey);
    if (chargesRes?.data) {
      const filtered = chargesRes.data.filter(c => {
        if (!productIds.length) return false;
        return productIds.some(pid =>
          c.metadata?.product_id === pid || c.metadata?.supabase_user_id
        );
      });
      for (const c of filtered) {
        conversions.push({
          userId: c.metadata?.supabase_user_id || null,
          email: c.billing_details?.email,
          signupTime: c.created * 1000,
          stripeCustomerId: c.customer,
          revenue: c.amount / 100,
          status: 'active',
          plan: null,
          source: 'unknown',
        });
      }
      totalRevenue = conversions.reduce((s, c) => s + c.revenue, 0);
    }
  }

  return { conversions, totalRevenue };
}

/**
 * Check for duplicate launches to prevent double-posting.
 */
async function checkDuplicate(dropspaceKey, hook, platform) {
  const today = new Date().toISOString().slice(0, 10);
  const hookNorm = hook.toLowerCase().replace(/\s*\(thread\)\s*$/, '').trim();
  try {
    const checkData = await dropspaceRequest('GET', '/launches?page_size=50', null, dropspaceKey);
    return (checkData.data || []).find(l =>
      (l.name || '').toLowerCase().replace(/\s*\(thread\)\s*$/, '').trim() === hookNorm &&
      l.created_at?.startsWith(today) &&
      l.platforms?.includes(platform) &&
      !['cancelled', 'failed'].includes(l.status)
    );
  } catch (e) {
    console.warn('⚠️ Could not check for duplicates:', e.message);
    return null;
  }
}

/**
 * Check if a scheduled launch already exists for a given platform + time window.
 * Prevents duplicates when schedule-day or schedule-recovery run multiple times.
 * Returns the existing launch if found, null otherwise.
 */
async function checkScheduledExists(dropspaceKey, platform, scheduledISO, toleranceMinutes = 5) {
  try {
    const res = await dropspaceRequest('GET', '/launches?status=scheduled&page_size=100', null, dropspaceKey);
    const launches = res.data || res || [];
    const targetTime = new Date(scheduledISO).getTime();
    const toleranceMs = toleranceMinutes * 60 * 1000;
    return launches.find(l => {
      if (!l.scheduled_date) return false;
      if (!(l.platforms || []).includes(platform)) return false;
      const launchTime = new Date(l.scheduled_date).getTime();
      return Math.abs(launchTime - targetTime) < toleranceMs;
    }) || null;
  } catch (e) {
    console.warn(`⚠️ Could not check existing scheduled launches: ${e.message}`);
    return null; // fail open — better to risk a duplicate than block scheduling
  }
}

/**
 * Post-publish verification — polls GET /launches/:id/status until terminal.
 *
 * Publish is ASYNC (returns 202). This function polls the status endpoint
 * to wait for actual platform results before reporting success/failure.
 *
 * Terminal statuses: completed, partial, failed, cancelled
 * Non-terminal: running, pending, publishing
 *
 * @param {string} dropspaceKey - API key
 * @param {string} launchId - Launch ID to check
 * @param {string} platform - Platform name for context
 * @param {object} [opts]
 * @param {number} [opts.initialDelayMs=5000] - Wait before first poll
 * @param {number} [opts.pollIntervalMs=5000] - Time between polls
 * @param {number} [opts.maxPollMs=120000] - Max total polling time (2 min)
 * @returns {{ ok: boolean, status: string, warnings: string[], postUrl: string|null, postingLogs: object[] }}
 */
async function verifyPublish(dropspaceKey, launchId, platform, opts = {}) {
  // Support legacy signature: verifyPublish(key, id, platform, delayMs)
  if (typeof opts === 'number') opts = { initialDelayMs: opts };
  const { initialDelayMs = 5000, pollIntervalMs = 5000, maxPollMs = 120000 } = opts;

  await new Promise(r => setTimeout(r, initialDelayMs));

  const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const startTime = Date.now();
  let lastStatus = 'unknown';
  let postingLogs = [];

  try {
    while (Date.now() - startTime < maxPollMs) {
      const statusRes = await dropspaceRequest('GET', `/launches/${launchId}/status`, null, dropspaceKey);
      const data = statusRes.data || statusRes;
      lastStatus = data.launch_status || 'unknown';
      postingLogs = data.posting_logs || [];

      if (TERMINAL.has(lastStatus)) break;

      console.log(`  ⏳ Launch status: ${lastStatus} — polling again in ${pollIntervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    const warnings = [];
    let postUrl = null;

    // Check overall status
    if (lastStatus === 'failed') {
      warnings.push(`Launch ${launchId} failed`);
    } else if (lastStatus === 'partial') {
      warnings.push(`Launch ${launchId} completed with partial success`);
    } else if (!TERMINAL.has(lastStatus)) {
      warnings.push(`Launch ${launchId} still ${lastStatus} after ${maxPollMs / 1000}s — may still be processing`);
    }

    // Check per-platform posting logs
    for (const log of postingLogs) {
      if (log.platform === platform) {
        if (log.status === 'success') {
          postUrl = log.post_url || null;
        } else if (log.status === 'failed') {
          warnings.push(`${platform}: ${log.error_message || 'unknown error'}${log.error_code ? ` (${log.error_code})` : ''}`);
        }
      }
    }

    // Check for platforms that have no log at all (may have been skipped)
    const loggedPlatforms = new Set(postingLogs.map(l => l.platform));
    if (!loggedPlatforms.has(platform) && TERMINAL.has(lastStatus)) {
      warnings.push(`${platform}: no posting log found — platform may have been skipped`);
    }

    return {
      ok: lastStatus === 'completed' && warnings.length === 0,
      status: lastStatus,
      warnings,
      postUrl,
      postingLogs,
    };
  } catch (e) {
    return {
      ok: true, // Don't block on verification failure
      status: 'unverified',
      warnings: [`Could not verify publish status: ${e.message}`],
      postUrl: null,
      postingLogs: [],
    };
  }
}

/**
 * Retry failed platforms for a launch.
 * Uses POST /launches/:id/retry which only retries platforms that failed.
 *
 * @param {string} dropspaceKey - API key
 * @param {string} launchId - Launch ID
 * @returns {{ retried: boolean, platforms: string[], error: string|null }}
 */
async function retryFailedPlatforms(dropspaceKey, launchId) {
  try {
    const res = await fetch(`${DROPSPACE_URL}/launches/${launchId}/retry`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${dropspaceKey}` },
    });
    if (res.status === 400) {
      return { retried: false, platforms: [], error: 'No failed platforms to retry' };
    }
    if (res.status === 409) {
      return { retried: false, platforms: [], error: 'Launch is already running' };
    }
    if (!res.ok) {
      const text = await res.text();
      return { retried: false, platforms: [], error: `HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    return {
      retried: true,
      platforms: data.data?.platforms || [],
      error: null,
    };
  } catch (e) {
    return { retried: false, platforms: [], error: e.message };
  }
}




/**
 * Fetch unresolved Sentry issues with recent activity.
 * Only returns issues that are unresolved AND have fired within maxAgeHours.
 * Filters out known noise (browser extensions, etc).
 * 
 * @param {string} project - Sentry project slug (e.g. 'myapp')
 * @param {object} [opts]
 * @param {number} [opts.maxAgeHours=48] - Only include issues seen within this window
 * @param {number} [opts.limit=25] - Max issues to fetch
 * @param {string[]} [opts.filterTitles=[]] - Substrings to filter out (e.g. browser extensions)
 * @returns {Promise<{issues: Array, error: string|null}>}
 */
async function fetchSentryIssues(project, opts = {}) {
  const token = process.env.SENTRY_ACCESS_TOKEN;
  if (!token) return { issues: [], error: 'SENTRY_ACCESS_TOKEN not set' };

  const maxAgeHours = opts.maxAgeHours ?? 48;
  const limit = opts.limit ?? 25;
  const filterTitles = opts.filterTitles ?? [
    'frame_ant',       // browser extension
    'MetaMask',        // browser extension
    'inpage.js',       // browser extension
  ];

  try {
    const org = opts.org || process.env.SENTRY_ORG || 'default';
    const url = `https://us.sentry.io/api/0/projects/${org}/${project}/issues/?query=is:unresolved&sort=freq&limit=${limit}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      return { issues: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const raw = await res.json();
    const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);

    const issues = raw
      .filter(i => {
        // Must have recent activity
        const lastSeen = new Date(i.lastSeen).getTime();
        if (lastSeen < cutoff) return false;
        // Filter noise
        const title = i.title || '';
        if (filterTitles.some(f => title.toLowerCase().includes(f.toLowerCase()))) return false;
        return true;
      })
      .map(i => ({
        id: i.shortId,
        title: i.title,
        count: parseInt(i.count, 10),
        firstSeen: i.firstSeen,
        lastSeen: i.lastSeen,
        status: i.status,
        level: i.level,
        permalink: i.permalink,
      }));

    return { issues, error: null };
  } catch (e) {
    return { issues: [], error: e.message };
  }
}

module.exports = {
  DROPSPACE_URL,
  dropspaceRequest,
  stripeAPI,
  supabaseSQL,
  fetchPostHogReferrers,
  fetchRecentLaunches,
  fetchAttributionData,
  checkDuplicate,
  checkScheduledExists,
  verifyPublish,
  retryFailedPlatforms,
  fetchSentryIssues,
};
