# app.json Schema

App configuration at `~/markus-automation/apps/{app}/app.json`.

## Minimal

```json
{
  "name": "My App",
  "description": "AI tool for indie hackers",
  "url": "https://myapp.com",
  "apiKeyEnv": "DROPSPACE_API_KEY",
  "platforms": {
    "twitter": { "enabled": true, "postingTimes": ["09:30"] }
  }
}
```

## Full

```json
{
  "name": "string — display name",
  "description": "string — app description (used as AI content context)",
  "audience": "string — target audience",
  "problem": "string — problem it solves",
  "differentiator": "string — why it's different",
  "url": "string — product URL (used in UTM links)",
  "category": "string — saas, mobile, marketplace, community",
  "monetization": "string — subscription, freemium, one-time",
  "apiKeyEnv": "string — env var name for Dropspace API key",
  "testEmailPatterns": ["regex strings — emails to exclude from attribution"],
  "integrations": {
    "posthog": { "projectId": "string" },
    "supabase": { "projectId": "string", "url": "string" },
    "stripe": { "productIds": ["string"] },
    "sentry": { "org": "string", "projects": ["string"] }
  },
  "xResearch": {
    "queries": ["X search queries for trend research"],
    "competitors": ["competitor X handles"]
  },
  "utmTemplate": "https://myapp.com?utm_source={platform}&utm_medium=social&utm_campaign=automation",
  "platforms": {
    "tiktok": {
      "enabled": true,
      "postingTimes": ["07:00", "10:00", "13:00", "16:00", "19:00"],
      "imageModel": "gpt-image-1.5"
    },
    "instagram": {
      "enabled": true,
      "postingTimes": ["08:00"],
      "imageModel": "gpt-image-1.5"
    },
    "facebook": {
      "enabled": true,
      "postingTimes": ["09:00"]
    },
    "twitter": {
      "enabled": true,
      "postingTimes": ["09:30", "15:00"]
    },
    "linkedin": {
      "enabled": true,
      "postingTimes": ["08:30"],
      "weekdaysOnly": true
    },
    "reddit": {
      "enabled": true,
      "postingTimes": ["10:00"]
    }
  }
}
```

## Platform Fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | boolean | `true` | Include in automation |
| `postingTimes` | string[] | varies | HH:MM in local timezone |
| `imageModel` | string | `gpt-image-1.5` | Visual platforms only |
| `weekdaysOnly` | boolean | `false` | Skip weekends |
| `audienceOverride` | string | null | Platform-specific audience |

## Integration Notes

- **PostHog:** Traffic referrer analysis. Personal API Key required.
- **Supabase:** Signup attribution. Queries `profiles` table.
- **Stripe:** Revenue attribution. Matches users to subscriptions/charges.
- **Sentry:** Error monitoring in reports.
- **X Research:** Bird CLI or X API for competitive intelligence. Optional.
