---
name: markus-social
description: Complete multi-platform social media automation pipeline using Dropspace for publishing. Orchestrates content across TikTok, Instagram, Facebook, Twitter, LinkedIn, and Reddit — including AI image generation, self-improving strategy, A/B format testing, X trend research, batch scheduling, and cross-platform analytics. Use when setting up multi-platform social automation, managing a full posting pipeline, running cross-platform analytics, or automating content for any app across all 6 platforms.
---

# Markus — Multi-Platform Social Automation

Full 6-platform pipeline: research → strategize → generate → schedule → publish → analyze → iterate. One command to schedule 11+ posts/day across TikTok, Instagram, Facebook, Twitter, LinkedIn, and Reddit.

## Setup

```bash
# 1. Initialize all platforms
node scripts/init-app.js --app myapp --platforms all

# 2. Configure
$EDITOR ~/markus-automation/apps/myapp/app.json

# 3. Env vars
export DROPSPACE_API_KEY="ds_live_..."
export OPENAI_API_KEY="sk-..."   # visual platforms

# 4. Validate
node scripts/validate-engine.js --app myapp --platform tiktok
```

See [references/setup-guide.md](references/setup-guide.md) and [references/app-json-schema.md](references/app-json-schema.md).

## Commands

```bash
# Run self-improve for ALL platforms sequentially
node scripts/run-self-improve-all.js --app myapp --days 14

# Single platform self-improve
node scripts/self-improve-engine.js --app myapp --platform tiktok --days 14

# Add posts (agent pipes JSON)
echo '{"posts":[...], "notes":"...", "crossNotes":"..."}' | node scripts/add-posts.js --app myapp --platform tiktok

# Batch pre-gen images for all visual platforms
for p in tiktok instagram facebook; do
  node scripts/batch-prepare-engine.js --app myapp --platform $p --count 3
done

# Schedule ALL platforms for today
node scripts/schedule-day.js --app myapp

# Recovery for missed slots
node scripts/schedule-recovery.js --app myapp

# X trend research (shared across all platforms)
node scripts/run-x-research.js --app myapp
```

## Daily Cron Pipeline

| Time | Script | Purpose |
|------|--------|---------|
| 12:30 AM | `run-x-research.js` | Scan X for trending angles + competitor hooks |
| 1:00 AM | `run-self-improve-all.js` | Analytics + POSTS_NEEDED for all 6 platforms |
| 1:30 AM | `batch-prepare-engine.js` | Pre-gen images for visual platforms |
| 2:00 AM | `schedule-day.js` | Create Dropspace launches for all time slots |
| 6:00 AM | `schedule-recovery.js` | Fill gaps from schedule-day failures |

Self-improve runs all 6 platforms sequentially. First platform fetches shared data (PostHog/Supabase/Stripe), caches it, remaining 5 read from cache.

## Architecture

### Data Layout

```
~/markus-automation/apps/{app}/
├── app.json                    ← app identity + platform config
├── shared-failures.json        ← cross-platform failure rules
├── insights.json               ← cross-platform strategy notes
├── x-research-signals.json     ← latest X research
├── reports/
├── tiktok/                     ← strategy.json, posts.json, experiments.json, pending-batches.json, posts/
├── instagram/
├── facebook/
├── twitter/                    ← strategy.json, posts.json, experiments.json, research/
├── linkedin/
└── reddit/
```

Override root: `export MARKUS_DATA_ROOT=/custom/path`

### Platform Types

**Visual** (TikTok, Instagram, Facebook): AI image gen → text overlay → carousel
**Text** (Twitter, LinkedIn, Reddit): text content → direct publish

### Self-Improve → POSTS_NEEDED Flow

Each platform's self-improve outputs a `POSTS_NEEDED` JSON block containing:
- Recent posts with full content + metrics + slide image URLs (visual feedback)
- X research signals (trending angles, competitor hooks)
- Experiment state (active tests, candidates, per-format metrics)
- Previous strategy notes (continuity between runs)
- Failure rules (patterns to avoid)

The cron agent reads each block, generates complete post blueprints, and pipes them to `add-posts.js`. Cross-platform notes propagate insights across platforms.

### Experiment Framework

A/B test content formats across any platform:

**Visual:** slideshow (6 slides), identity-cards (6), short-cta (3), meme (1), branded-consistent (6)
**Text:** text-thread, text-single, text-hook-list

LLM controls lifecycle via strategy notes:
- `ACTIVATE_EXPERIMENT: <id>` — start testing
- `KILL_EXPERIMENT: <id>` — stop, record outcome
- `GRADUATE_EXPERIMENT: <id>` — make permanent

## Platform Quick Reference

| Platform | Type | Metric | Format | Notes |
|----------|------|--------|--------|-------|
| TikTok | visual | views | 6-slide slideshow | Most emotional. Storytelling. All lowercase. |
| Instagram | visual | views | carousel (≥2 images) | Educational. Saves drive reach. |
| Facebook | visual | engagement | carousel | Reactions×1 + Comments×2 + Shares×3 |
| Twitter | text | impressions | tweet/thread (≤280/tweet) | Casual. Hot takes. No marketing speak. |
| LinkedIn | text | impressions | text (≤3,000 chars) | Professional. Questions at end. Weekdays only. |
| Reddit | text | score | title + body | Anti-marketing. No hashtags. No emoji. |

## Environment Variables

**Required:** `DROPSPACE_API_KEY`, `OPENAI_API_KEY` (visual)
**Optional analytics:** `STRIPE_SECRET_KEY`, `SUPABASE_ACCESS_TOKEN`, `POSTHOG_PERSONAL_API_KEY`
**Optional X research:** `BIRD_AUTH_TOKEN` + `BIRD_CT0` or `X_BEARER_TOKEN`
**Optional monitoring:** `SENTRY_ACCESS_TOKEN`

## Post Blueprint Formats

**Visual:**
```json
{"text":"hook","slideTexts":["s1","...","s6"],"slidePrompts":["img1","...","img6"],"caption":"...","format":"slideshow"}
```

**Text (thread):**
```json
{"text":"hook","postBody":"tweet 1\n\ntweet 2\n\ntweet 3","format":"text-thread"}
```

**Text (single):**
```json
{"text":"hook or title","postBody":"full post body","format":"text-single"}
```

## Multiple Apps

```bash
node scripts/init-app.js --app app1 --platforms all
node scripts/init-app.js --app app2 --platforms tiktok,twitter
# Each gets separate data dirs, crons, and strategies
```
