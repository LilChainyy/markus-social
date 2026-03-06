#!/usr/bin/env node
/**
 * Shared Batch Prepare Engine — pre-submits OpenAI Batch API jobs for tomorrow's posts.
 *
 * Platform-specific batch-prepare.js files are thin wrappers that call:
 *   runBatchPrepare({ platform: 'tiktok', defaultDir: 'tiktok' })
 *
 * Usage:
 *   node batch-prepare-engine.js --app dropspace --platform tiktok --count 3
 *   node batch-prepare-engine.js --app dropspace --platform facebook --count 2
 *
 * Reads next N posts from strategy.json postQueue, uses slidePrompts
 * to submit OpenAI batch image generation jobs. Saves to pending-batches.json.
 *
 * Env vars:
 *   OPENAI_API_KEY — required
 */

const fs = require('fs');
const path = require('path');

const { parseArgs, loadJSON } = require('./helpers');
const paths = require('./paths');

function runBatchPrepare(config = {}) {
  const { getArg, hasFlag } = parseArgs();

  const appName = getArg('app');
  const platformName = getArg('platform') || config.platform;
  const count = parseInt(getArg('count') || '3');
  const onlyFormat = getArg('only-format');
  const skipFormat = getArg('skip-format');

  if (!appName || !platformName) {
    console.error('Usage: node batch-prepare-engine.js --app <name> --platform <platform> [--count 3]');
    process.exit(1);
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }

  const strategyPath = paths.strategyPath(appName, platformName);
  const pendingPath = paths.pendingBatchesPath(appName, platformName);

  let strategy;
  try {
    strategy = JSON.parse(fs.readFileSync(strategyPath, 'utf-8'));
  } catch (e) {
    console.error(`❌ Failed to parse ${strategyPath}: ${e.message}`);
    process.exit(1);
  }
  const model = strategy.imageGen?.model || 'gpt-image-1.5';

  if (!strategy.postQueue || strategy.postQueue.length === 0) {
    console.log('⚠️  Post queue is empty — nothing to prepare.');
    process.exit(0);
  }

  // Load existing pending batches (don't re-submit for hooks already pending)
  const pending = loadJSON(pendingPath, { batches: [] });

  // Clean up expired/completed entries older than 48h
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  pending.batches = pending.batches.filter(b => new Date(b.submittedAt).getTime() > cutoff);

  const pendingHooks = new Set(pending.batches.map(b => b.hook.toLowerCase()));

  // Pick next N hooks that aren't already pending
  const hooksToProcess = [];
  for (const h of strategy.postQueue) {
    if (hooksToProcess.length >= count) break;
    const hookText = h.text || h;
    const hookFormat = h.format || null;

    // Format filtering: skip hooks that don't match --only-format or match --skip-format
    if (onlyFormat && hookFormat && hookFormat !== onlyFormat) {
      console.log(`  ⏭ Skipping (format "${hookFormat}" != "${onlyFormat}"): "${hookText.substring(0, 50)}..."`);
      continue;
    }
    if (skipFormat && hookFormat === skipFormat) {
      console.log(`  ⏭ Skipping (format "${hookFormat}" excluded): "${hookText.substring(0, 50)}..."`);
      continue;
    }

    if (pendingHooks.has(hookText.toLowerCase())) {
      console.log(`  ⏭ Already pending: "${hookText.substring(0, 50)}..."`);
      continue;
    }
    // Skip agent prompts (these are placeholders, not real hooks)
    if (hookText.startsWith('[AGENT:')) continue;
    if (!h.slidePrompts || h.slidePrompts.length !== 6) {
      console.log(`  ⏭ No slidePrompts: "${hookText.substring(0, 50)}..."`);
      continue;
    }
    hooksToProcess.push({
      text: hookText,
      slidePrompts: h.slidePrompts,
    });
  }

  if (hooksToProcess.length === 0) {
    console.log('✅ All upcoming hooks already have pending batches.');
    process.exit(0);
  }

  console.log(`\n📦 Preparing ${hooksToProcess.length} batch jobs for ${appName} (${model})\n`);

  // slidePrompts required per post — no legacy fallbacks

  (async () => {
    // Preflight: verify API key has batch access
    try {
      const testRes = await fetch('https://api.openai.com/v1/batches?limit=1', {
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}` }
      });
      if (!testRes.ok) {
        const err = await testRes.json().catch(() => ({}));
        console.error(`❌ OpenAI API key cannot access Batch API: ${testRes.status} ${err.error?.message || ''}`);
        console.error('   Ensure the key has "Batch" permissions at https://platform.openai.com/api-keys');
        process.exit(1);
      }
    } catch (e) {
      console.error(`❌ Could not reach OpenAI API: ${e.message}`);
      process.exit(1);
    }

    for (const hookEntry of hooksToProcess) {
      const hook = hookEntry.text;
      const slidePrompts = hookEntry.slidePrompts;
      console.log(`\n🎣 Hook: "${hook.substring(0, 60)}..."`);

      console.log(`  🎨 Using LLM-generated slide prompts`);

      // Build JSONL for this hook's 6 slides
      const jsonlLines = [];
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      for (let i = 0; i < 6; i++) {
        const slidePrompt = slidePrompts[i];

        jsonlLines.push(JSON.stringify({
          custom_id: `${batchId}-slide-${i + 1}`,
          method: 'POST',
          url: '/v1/images/generations',
          body: { model, prompt: slidePrompt, n: 1, size: '1024x1536', quality: 'high', output_format: 'png' }
        }));
      }

      if (jsonlLines.length !== 6) {
        console.error(`  ❌ Skipping hook — only ${jsonlLines.length}/6 slide prompts available`);
        continue;
      }

      const jsonlContent = jsonlLines.join('\n');

      // Upload JSONL file
      const formData = new FormData();
      formData.append('purpose', 'batch');
      formData.append('file', new Blob([jsonlContent]), 'batch_input.jsonl');

      const uploadRes = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      if (uploadData.error) {
        console.error(`  ❌ Upload failed: ${uploadData.error.message}`);
        continue;
      }
      console.log(`  ✅ Uploaded: ${uploadData.id}`);

      // Create batch
      const batchRes = await fetch('https://api.openai.com/v1/batches', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_file_id: uploadData.id,
          endpoint: '/v1/images/generations',
          completion_window: '24h'
        })
      });
      const batchData = await batchRes.json();
      if (batchData.error) {
        console.error(`  ❌ Batch creation failed: ${batchData.error.message}`);
        continue;
      }
      console.log(`  ✅ Batch created: ${batchData.id}`);

      // Save to pending
      pending.batches.push({
        openAiBatchId: batchData.id,
        inputFileId: uploadData.id,
        localBatchId: batchId,
        hook,
        model,
        slideCount: 6,
        submittedAt: new Date().toISOString(),
        status: 'pending'
      });
    }

    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
    console.log(`\n✅ Saved ${pending.batches.length} pending batches to ${pendingPath}`);
  })().catch(e => {
    console.error(`\n❌ Fatal: ${e.message}`);
    process.exit(1);
  });
}

// CLI entry point
if (require.main === module) {
  runBatchPrepare({});
}

module.exports = { runBatchPrepare };
