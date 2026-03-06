# Setup Guide

## Prerequisites

- Node.js 18+
- [Dropspace](https://www.dropspace.dev) account with API key
- OpenAI API key (visual platforms only — image generation)
- OpenClaw agent (for automated content generation via crons)

## Step 1: Initialize Your App

```bash
node scripts/init-app.js --app myapp --platforms tiktok,instagram,twitter
# Or all platforms:
node scripts/init-app.js --app myapp --platforms all
```

Creates `~/markus-automation/apps/myapp/` with app.json template and per-platform data files.

Override data directory: `export MARKUS_DATA_ROOT=/path/to/data`

## Step 2: Configure app.json

Edit `~/markus-automation/apps/myapp/app.json`:

```json
{
  "name": "My App",
  "description": "What the app does (AI uses this for content generation)",
  "audience": "Who it's for",
  "problem": "What problem it solves",
  "url": "https://myapp.com",
  "apiKeyEnv": "DROPSPACE_API_KEY",
  "platforms": {
    "tiktok": { "enabled": true, "postingTimes": ["07:00", "10:00", "13:00"] }
  }
}
```

See [app-json-schema.md](app-json-schema.md) for full schema.

## Step 3: Environment Variables

```bash
# Required
export DROPSPACE_API_KEY="ds_live_..."
export OPENAI_API_KEY="sk-..."      # visual platforms only

# Optional (enriches analytics)
export STRIPE_SECRET_KEY="rk_live_..."
export SUPABASE_ACCESS_TOKEN="sbp_..."
export POSTHOG_PERSONAL_API_KEY="phx_..."

# Optional (X research)
export BIRD_AUTH_TOKEN="..."         # Bird CLI for X search
export BIRD_CT0="..."
export X_BEARER_TOKEN="..."         # X API fallback
```

## Step 4: Validate

```bash
node scripts/validate-engine.js --app myapp --platform tiktok
```

## Step 5: First Manual Run

```bash
# Run self-improve (dry run first)
node scripts/self-improve-engine.js --app myapp --platform tiktok --days 14 --dry-run

# Generate posts via agent, pipe to add-posts
echo '{"posts":[{"text":"hook","slideTexts":["..."],"slidePrompts":["..."],"caption":"..."}]}' \
  | node scripts/add-posts.js --app myapp --platform tiktok

# Schedule (dry run)
node scripts/schedule-day.js --app myapp --dry-run
```

## Step 6: Cron Setup

Set up OpenClaw crons for automated daily pipeline. Recommended schedule:

| Time | Command |
|------|---------|
| 12:30 AM | `node scripts/run-x-research.js --app myapp` |
| 1:00 AM | `node scripts/self-improve-engine.js --app myapp --platform tiktok` |
| 1:30 AM | `node scripts/batch-prepare-engine.js --app myapp --platform tiktok --count 5` |
| 2:00 AM | `node scripts/schedule-day.js --app myapp` |

## Canvas Module (Visual Platforms)

Visual platforms need the `canvas` npm package for text overlays:

```bash
cd ~/markus-automation && npm install canvas
```

Custom fonts: place `.ttf` files in `~/markus-automation/fonts/`.

## Multiple Apps

Run separate pipelines per app:
```bash
node scripts/init-app.js --app app1 --platforms tiktok,twitter
node scripts/init-app.js --app app2 --platforms instagram,linkedin
```

Each gets its own data at `~/markus-automation/apps/{app}/`.
