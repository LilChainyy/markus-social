/**
 * Path resolution for the automation pipeline.
 *
 * ALL scripts use these functions to resolve data paths.
 * Single source of truth — change the layout here, everything follows.
 *
 * Layout:
 *   ~/markus-automation/apps/{app}/{platform}/         — per-platform data
 *   ~/markus-automation/apps/{app}/app.json            — app config
 *   ~/markus-automation/apps/{app}/shared-failures.json
 *   ~/markus-automation/apps/{app}/insights.json       — cross-platform strategy notes
 *   ~/markus-automation/apps/{app}/x-research-signals.json
 *   ~/markus-automation/apps/{app}/reports/            — cross-platform analysis reports
 *   ~/markus-automation/cache/                         — shared API response cache
 */

const path = require('path');
const fs = require('fs');

const HOME = process.env.HOME || '';
const DATA_ROOT = process.env.MARKUS_DATA_ROOT || path.join(HOME, 'markus-automation', 'apps');

/**
 * Root directory for an app's data.
 * e.g. ~/markus-automation/apps/myapp/
 */
function appRoot(appName) {
  return path.join(DATA_ROOT, appName);
}

/**
 * Per-platform data directory.
 * e.g. ~/markus-automation/apps/myapp/tiktok/
 */
function platformDir(appName, platform) {
  return path.join(DATA_ROOT, appName, platform);
}

/**
 * App config file.
 * e.g. ~/markus-automation/apps/myapp/app.json
 */
function appConfigPath(appName) {
  return path.join(appRoot(appName), 'app.json');
}

/**
 * Load app.json config. Returns null if not found.
 */
function loadAppConfig(appName) {
  try {
    return JSON.parse(fs.readFileSync(appConfigPath(appName), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Shared failures file for an app.
 * e.g. ~/markus-automation/apps/myapp/shared-failures.json
 */
function sharedFailuresPath(appName) {
  return path.join(appRoot(appName), 'shared-failures.json');
}

/**
 * Cross-platform strategy insights for an app.
 * e.g. ~/markus-automation/apps/myapp/insights.json
 */
function insightsPath(appName) {
  return path.join(appRoot(appName), 'insights.json');
}

/**
 * X research signals file for an app.
 * e.g. ~/markus-automation/apps/myapp/x-research-signals.json
 */
function xResearchSignalsPath(appName) {
  return path.join(appRoot(appName), 'x-research-signals.json');
}

/**
 * Cross-platform reports directory for an app.
 * e.g. ~/markus-automation/apps/myapp/reports/
 */
function reportsDir(appName) {
  return path.join(appRoot(appName), 'reports');
}

/**
 * Shared cache directory.
 * e.g. ~/markus-automation/cache/
 */
function cacheDir() {
  return path.join(HOME, 'markus-automation', 'cache');
}

/**
 * Self-improve cache path for an app.
 * e.g. ~/markus-automation/cache/self-improve-dropspace-14d.json
 */
function selfImproveCachePath(appName, days) {
  return path.join(cacheDir(), `self-improve-${appName}-${days}d.json`);
}

/**
 * X research snapshot directory for an app.
 * e.g. ~/markus-automation/apps/myapp/tiktok/research/  (platform-specific)
 * or ~/markus-automation/apps/myapp/research/             (app-level)
 */
function researchDir(appName, platform) {
  if (platform) return path.join(platformDir(appName, platform), 'research');
  return path.join(appRoot(appName), 'research');
}

/**
 * Strategy.json for a platform.
 * e.g. ~/markus-automation/apps/myapp/tiktok/strategy.json
 */
function strategyPath(appName, platform) {
  return path.join(platformDir(appName, platform), 'strategy.json');
}

/**
 * Posts.json for a platform.
 */
function postsPath(appName, platform) {
  return path.join(platformDir(appName, platform), 'posts.json');
}

/**
 * Failures.json for a platform.
 */
function failuresPath(appName, platform) {
  return path.join(platformDir(appName, platform), 'failures.json');
}

/**
 * Pending batches for a visual platform.
 */
function pendingBatchesPath(appName, platform) {
  return path.join(platformDir(appName, platform), 'pending-batches.json');
}

/**
 * Post assets directory for a specific post.
 */
function postAssetsDir(appName, platform, timestamp) {
  return path.join(platformDir(appName, platform), 'posts', timestamp);
}

/**
 * Posts directory root for a platform.
 */
function postsAssetsRoot(appName, platform) {
  return path.join(platformDir(appName, platform), 'posts');
}

/**
 * Get list of enabled platforms for an app from app.json.
 */
function getEnabledPlatforms(appName) {
  const config = loadAppConfig(appName);
  if (!config || !config.platforms) return [];
  return Object.entries(config.platforms)
    .filter(([_, cfg]) => cfg.enabled !== false)
    .map(([name]) => name);
}

/**
 * Get platform config from app.json.
 */
function getPlatformConfig(appName, platform) {
  const config = loadAppConfig(appName);
  if (!config || !config.platforms) return null;
  return config.platforms[platform] || null;
}

module.exports = {
  HOME,
  DATA_ROOT,
  appRoot,
  platformDir,
  appConfigPath,
  loadAppConfig,
  sharedFailuresPath,
  insightsPath,
  xResearchSignalsPath,
  reportsDir,
  cacheDir,
  selfImproveCachePath,
  researchDir,
  strategyPath,
  postsPath,
  failuresPath,
  pendingBatchesPath,
  postAssetsDir,
  postsAssetsRoot,
  getEnabledPlatforms,
  getPlatformConfig,
};
