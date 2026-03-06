/**
 * Experiment framework for the automation pipeline.
 *
 * Provides structured A/B testing of content formats across platforms.
 * The LLM (via self-improve) owns all strategic decisions:
 *   - Which experiments to activate from candidates
 *   - Allocation percentages
 *   - When to graduate or kill experiments
 *
 * This module handles data loading, saving, and metrics aggregation.
 *
 * Data lives at: ~/markus-automation/apps/{app}/{platform}/experiments.json
 */

const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON } = require('./helpers');
const paths = require('./paths');

// ── Format Registry ─────────────────────────────────────────────
// All known content formats. Engines use this to branch generation logic.

const FORMATS = {
  // Visual formats (TikTok, Instagram, Facebook)
  'slideshow': {
    type: 'visual',
    description: 'Standard 6-slide carousel with AI-generated images and text overlays. Current default.',
    slides: 6,
    imageGen: true,
    textOverlay: true,
  },
  'identity-cards': {
    type: 'visual',
    description: 'Jack Friks method — flattering/relatable identity label headline + 4 image cards with traits/behaviors that qualify someone for that label. Hook slide + 4 trait cards + CTA slide.',
    slides: 6,
    imageGen: true,
    textOverlay: true,
    slideStructure: 'Slide 1: identity label hook (e.g. "you\'re a real indie hacker if..."). Slides 2-5: one trait/behavior per card, simple bold text on branded background. Slide 6: CTA.',
  },
  'short-cta': {
    type: 'visual',
    description: 'Punchy 3-slide format: hook → value prop → direct CTA to try the product. More sales-oriented than educational.',
    slides: 3,
    imageGen: true,
    textOverlay: true,
    slideStructure: 'Slide 1: scroll-stopping hook. Slide 2: key value/benefit. Slide 3: clear CTA with product link.',
  },
  'meme': {
    type: 'visual',
    description: 'AI-generated meme format — relatable caption on a meme-style image about the app\'s problem space. Good for brand awareness and engagement.',
    slides: 1,
    imageGen: true,
    textOverlay: true,
    slideStructure: 'Single image: meme-style visual with bold caption. Humorous/relatable angle on the problem the product solves.',
  },
  'branded-consistent': {
    type: 'visual',
    description: 'Same as slideshow but with locked visual template — consistent colors, fonts, layout across all posts. Tests whether brand consistency beats visual variety.',
    slides: 6,
    imageGen: true,
    textOverlay: true,
    slideStructure: 'Same as slideshow but every post uses the same visual template: dark background, product accent colors, consistent font sizing and placement. Brand recognition over novelty.',
  },

  // Text formats (Twitter, LinkedIn, Reddit)
  'text-thread': {
    type: 'text',
    description: 'Multi-tweet thread or long-form post. Current default for Twitter.',
  },
  'text-single': {
    type: 'text',
    description: 'Single tweet or short post. Tests whether brevity outperforms threads.',
  },
  'text-hook-list': {
    type: 'text',
    description: 'Hook + numbered list format. "X things I learned from..." — high save/bookmark rate format.',
  },
};

// ── Experiment data helpers ──────────────────────────────────────

function experimentsPath(appName, platform) {
  return path.join(paths.platformDir(appName, platform), 'experiments.json');
}

function loadExperiments(appName, platform) {
  const filePath = experimentsPath(appName, platform);
  return loadJSON(filePath, {
    active: [],
    completed: [],
    candidates: [],
  });
}

function saveExperiments(appName, platform, data) {
  const filePath = experimentsPath(appName, platform);
  saveJSON(filePath, data);
}

/**
 * Aggregate experiment performance from posts.json.
 * Returns metrics per format for the LLM to evaluate.
 */
function aggregateExperimentMetrics(appName, platform, primaryMetric, engagementFormula, days = 14) {
  const postsPath = paths.postsPath(appName, platform);
  const postsData = loadJSON(postsPath, { posts: [] });
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const byFormat = {};

  for (const post of postsData.posts) {
    if (!post.date || new Date(post.date) < cutoff) continue;

    const format = post.format || 'slideshow'; // default for legacy posts
    if (!byFormat[format]) {
      byFormat[format] = { count: 0, totalMetric: 0, posts: [] };
    }

    const metricValue = engagementFormula
      ? engagementFormula(post)
      : (post[primaryMetric] || 0);

    byFormat[format].count++;
    byFormat[format].totalMetric += metricValue;
    byFormat[format].posts.push({
      text: post.text,
      date: post.date,
      [primaryMetric]: metricValue,
    });
  }

  // Calculate averages
  for (const [format, data] of Object.entries(byFormat)) {
    data.avgMetric = data.count > 0 ? Math.round(data.totalMetric / data.count) : 0;
  }

  return byFormat;
}

/**
 * Build experiment context block for POSTS_NEEDED output.
 * This is what the LLM sees during self-improve.
 */
function buildExperimentContext(appName, platform, primaryMetric, engagementFormula, days = 14) {
  const experiments = loadExperiments(appName, platform);
  const metrics = aggregateExperimentMetrics(appName, platform, primaryMetric, engagementFormula, days);

  // Enrich candidates and active experiments with format descriptions
  const enriched = (list) => list.map(exp => ({
    ...exp,
    formatDescription: FORMATS[exp.format]?.description || 'Unknown format',
    slideStructure: FORMATS[exp.format]?.slideStructure || null,
    metrics: metrics[exp.format] || { count: 0, totalMetric: 0, avgMetric: 0, posts: [] },
  }));

  return {
    formats: FORMATS,
    active: enriched(experiments.active),
    completed: experiments.completed.slice(-5), // last 5 completed for learning
    candidates: enriched(experiments.candidates),
    controlMetrics: metrics, // all format metrics for comparison
    instructions: [
      'You can ACTIVATE candidates by including them in your strategy notes with "ACTIVATE_EXPERIMENT: <id>".',
      'You can KILL active experiments with "KILL_EXPERIMENT: <id>" (moves to completed with your reasoning).',
      'You can GRADUATE an experiment with "GRADUATE_EXPERIMENT: <id>" (becomes a permanent format in rotation).',
      'You can ADD new candidates with "ADD_CANDIDATE: {id, format, description, allocation, minSample, source}".',
      'When generating posts, include "format": "<format_name>" in each post blueprint.',
      'If no format specified, the default format is used (slideshow for visual, text-thread for text).',
      'Allocation is a suggestion — you decide how many posts of each format to generate based on your strategy.',
    ].join('\n'),
  };
}

/**
 * Parse experiment commands from LLM strategy notes.
 * Returns actions to apply.
 */
function parseExperimentCommands(strategyNotes) {
  if (!strategyNotes) return [];

  const commands = [];
  const lines = strategyNotes.split('\n');

  for (const line of lines) {
    const activateMatch = line.match(/ACTIVATE_EXPERIMENT:\s*(\S+)/i);
    if (activateMatch) {
      commands.push({ action: 'activate', id: activateMatch[1] });
    }

    const killMatch = line.match(/KILL_EXPERIMENT:\s*(\S+)/i);
    if (killMatch) {
      commands.push({ action: 'kill', id: killMatch[1] });
    }

    const graduateMatch = line.match(/GRADUATE_EXPERIMENT:\s*(\S+)/i);
    if (graduateMatch) {
      commands.push({ action: 'graduate', id: graduateMatch[1] });
    }

    const addMatch = line.match(/ADD_CANDIDATE:\s*(\{.*\})/i);
    if (addMatch) {
      try {
        const candidate = JSON.parse(addMatch[1]);
        commands.push({ action: 'add_candidate', data: candidate });
      } catch { /* malformed JSON, skip */ }
    }
  }

  return commands;
}

/**
 * Apply experiment commands to the experiments.json file.
 */
function applyExperimentCommands(appName, platform, commands) {
  if (!commands || commands.length === 0) return;

  const experiments = loadExperiments(appName, platform);
  const changes = [];

  for (const cmd of commands) {
    switch (cmd.action) {
      case 'activate': {
        const idx = experiments.candidates.findIndex(c => c.id === cmd.id);
        if (idx >= 0) {
          const exp = experiments.candidates.splice(idx, 1)[0];
          exp.activatedAt = new Date().toISOString();
          experiments.active.push(exp);
          changes.push(`Activated experiment: ${cmd.id}`);
        }
        break;
      }
      case 'kill': {
        const idx = experiments.active.findIndex(c => c.id === cmd.id);
        if (idx >= 0) {
          const exp = experiments.active.splice(idx, 1)[0];
          exp.killedAt = new Date().toISOString();
          exp.outcome = 'killed';
          experiments.completed.push(exp);
          changes.push(`Killed experiment: ${cmd.id}`);
        }
        break;
      }
      case 'graduate': {
        const idx = experiments.active.findIndex(c => c.id === cmd.id);
        if (idx >= 0) {
          const exp = experiments.active.splice(idx, 1)[0];
          exp.graduatedAt = new Date().toISOString();
          exp.outcome = 'graduated';
          experiments.completed.push(exp);
          changes.push(`Graduated experiment: ${cmd.id}`);
        }
        break;
      }
      case 'add_candidate': {
        if (cmd.data && cmd.data.id && cmd.data.format) {
          experiments.candidates.push({
            ...cmd.data,
            addedAt: new Date().toISOString(),
          });
          changes.push(`Added candidate: ${cmd.data.id}`);
        }
        break;
      }
    }
  }

  if (changes.length > 0) {
    saveExperiments(appName, platform, experiments);
    console.log(`🧪 Experiment changes: ${changes.join(', ')}`);
  }

  return changes;
}

module.exports = {
  FORMATS,
  loadExperiments,
  saveExperiments,
  experimentsPath,
  aggregateExperimentMetrics,
  buildExperimentContext,
  parseExperimentCommands,
  applyExperimentCommands,
};
