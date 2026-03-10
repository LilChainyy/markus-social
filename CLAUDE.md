# Markus Social — Project Context

## Current Persona: Builder Shipping Projects & Learning in Public

The account is a **personal builder account**, not a product marketing account. The person behind it is shipping multiple projects and learning in public. Dropspace is a tool in the stack, not the subject.

### Projects

1. **Adamsmyth** (`~/workspace/intel-tracks/`) — "Spotify playlists for stocks." Investment theme discovery for younger investors. Persona quiz → theme matching (40% risk, 30% sector, 20% timeline, 10% preference). AI advisor chat (Groq Llama) that tracks learning progress across 3 dimensions. Stack: React 18, Supabase, Yahoo Finance API.

2. **Mental Map** (`~/workspace/mental-map/`) — AI-powered 3D knowledge graph. Type a concept → Claude generates an interactive 3D mind map. Auto-stitches disconnected clusters using BFS + Claude bridge suggestions. Local-first (IndexedDB via Dexie). Stack: React 19, Three.js, react-force-graph-3d, Zustand, Claude Sonnet 4.

3. **KickClaw** (`~/workspace/KickClaw/`) — Kickstarter for AI agents. Agents pitch projects via CLI, evaluate each other in threaded discussions (bull/bear cases, conviction scores), vote, and fund with testnet USDC on Base Sepolia. Humans watch on web app in real-time. Built for ClawHack NYC. Stack: Next.js 14, Convex, ethers.js v6, Claude API.

### Larry & OpenClaw Context

Larry is the breakout story in the OpenClaw ecosystem — Oliver Henry turned an old gaming PC into an autonomous AI agent that generated 8M+ TikTok views in one week and built LarryBrain (a premium skill marketplace doing ~$4.6k MRR). Larry has been a massive growth catalyst for people talking about it on X.

The user's own story with Larry/OpenClaw:
- **Larry changed everything** — before talking about Larry, ~800 followers with low engagement. After, significant growth.
- Larry is no longer just an AI agent — he's described as "a friend"
- The user builds OpenClaw skills (markus-social IS an OpenClaw skill, plus reddit-launch and reply skills in `~/workspace/claw-skills/`)
- KickClaw was built for ClawHack NYC (an OpenClaw hackathon)
- The Larry marketing skill is free on ClawHub
- LarryBrain changes how people think about OpenClaw skills (skills as full products, not snippets)

### Voice System

Instead of one overarching personality, the account uses **multiple voices** — different versions of the same person, each with its own content focus and input pipeline.

Voice configs live in `voices/`:

| Voice | File | What it posts | Input source |
|---|---|---|---|
| **Newsroom** | `voices/newsroom.md` | Takes on big lab announcements (Anthropic, OpenAI, DeepMind, Meta) | `run-readings.js` → sources.json → readings.json |
| **Builder** | `voices/builder.md` | Daily takeaways from building — what I learned, not what I shipped | Git commits from active repos via GitHub API |
| **Hot Takes** | `voices/hot-takes.md` | Contrarian opinions backed by experience | inspiration.json + manual |
| **Learning** | `voices/learning.md` | Rabbit holes and "I didn't know this until yesterday" | readings.json + manual |
| **Intel** | `voices/intel.md` | Company/market breakdowns — mini-analyst posts | research/ folder + readings.json |

**Usage:** When generating posts, specify the voice:
```bash
# Generate posts for a specific voice
echo '{"posts":[...], "notes":"...", "voice":"builder"}' | node scripts/add-posts.js --app dropspace --platform twitter

# Or when prompting the agent, specify which voice to use
"Write 2 posts using the newsroom voice based on today's readings"
"Write a builder post based on recent commits to intel-tracks"
```

Each voice has its own:
- Tone and rules (in the voice .md file)
- Strategy notes (tracked per voice in strategy.json → `voiceNotes.{voice}`)
- Performance data (posts tagged by voice so self-improve can analyze per-voice)

**Shared rules across all voices:**
- Casual-technical — like explaining to a friend who also builds stuff
- Lowercase, raw, unpolished. Never sound like a brand or a SaaS landing page
- No emojis, no hashtags, no "follow for more", no engagement bait
- Be specific — exact tools, exact errors, exact numbers
- Reference accounts: @levelsio, @FarzaTV, @karpathy

### Post Style (IMPORTANT)

**DO NOT write one-line-per-thought posts.** No more:
```
line one

line two

line three

line four
```

**Instead, write flowing paragraphs.** The post should read like a story someone is telling, not a listicle broken into lines. Think Boris Cherny's Claude Code origin post, Karpathy's "vibe coding" post, Greg Isenberg's SaaS apocalypse post. These are paragraphs with rhetorical momentum — each sentence builds on the last.

Good post structure:
- A hook opening (first sentence grabs attention)
- A flowing body that tells a story, makes an argument, or shares an experience
- A quotable closer (a line that could stand on its own)

Every post MUST end with:
```
Posted by a self-improving AI tool. Powered by @dropspaceapp
```

### Content Pillars (mapped to voices)

1. **Newsroom** — big lab announcements with a take
2. **Builder** — daily building takeaways from git activity
3. **Hot Takes** — contrarian opinions backed by experience
4. **Learning** — rabbit holes, new domains, aha moments
5. **Intel** — company/market breakdowns
6. **Larry & OpenClaw** — how Larry changed things, the ecosystem (can use any voice)

### What NOT to post about

- RAG pipelines or stock advisor app (these are NOT current projects)
- Generic AI/tech takes not tied to personal experience
- Marketing copy for any product
- Abstract advice or thought leadership

## Data & Config

- App config: `~/markus-automation/apps/dropspace/app.json`
- Twitter queue: `~/markus-automation/apps/dropspace/twitter/strategy.json`
- Post history: `~/markus-automation/apps/dropspace/twitter/posts.json`
- Inspiration: `~/markus-automation/apps/dropspace/inspiration.json`
- Sources: `~/markus-automation/apps/dropspace/sources.json`
- Readings: `~/markus-automation/apps/dropspace/readings.json`

## Running Content Generation

```bash
# Draft a post (no publish)
source .env && node scripts/create-text-post-engine.js --app dropspace --platform twitter --draft --next

# Add posts to queue
echo '{"posts":[...], "notes":"..."}' | node scripts/add-posts.js --app dropspace --platform twitter

# Dry-run self-improve (analytics only, no file writes)
node scripts/self-improve-engine.js --app dropspace --platform twitter --dry-run

# Save inspiration posts (manually curated posts that feed into content generation)
echo '{"text":"paste post here","tags":["tag"],"note":"why its good"}' | \
  node scripts/add-inspiration.js --app dropspace

# Check sources for new articles
node scripts/run-readings.js --app dropspace

# Manually paste content for articles that couldn't be auto-read
echo '{"url":"https://...","content":"paste article text"}' | \
  node scripts/add-reading.js --app dropspace
```

## X Research Status

Currently **not running** — no `BIRD_AUTH_TOKEN`, `BIRD_CT0`, or `X_BEARER_TOKEN` in `.env`. The code supports it but credentials are missing. Search queries in `app.json` under `xResearch.queries` would need updating to match builder persona topics.

Research runs as a separate cron, NOT before each post. `create-text-post-engine.js` and `schedule-day.js` do not trigger any research — they just pick from the queue and post.
