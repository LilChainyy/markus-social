#!/usr/bin/env node
/**
 * Shared Visual Post Creation Engine
 *
 * Consolidates the image generation → text overlay → JPEG compression →
 * Dropspace upload → publish pipeline used by TikTok, Instagram, and Facebook.
 *
 * Platform-specific create-post.js files are thin wrappers that call:
 *   runCreateVisualPost({ platform: 'tiktok', defaultDir: 'tiktok', ... })
 *
 * Config shape:
 * {
 *   platform: 'tiktok',
 *   defaultDir: 'tiktok',
 *   defaultPlatforms: ['tiktok'],          // default --platforms value
 *   minMedia: 1,                           // minimum media for this platform (Instagram: 2)
 *   platformContentsExtra: (platform, caption, hook) => ({}),  // extra fields per platform_contents entry
 *   draftMessage: (launchId, hook, caption) => string,         // draft mode instructions
 *   postMetricFields: () => ({}),          // extra metric fields for posts.json entries
 * }
 */

const fs = require('fs');
const path = require('path');
const { dropspaceRequest: _dropspaceReq, verifyPublish, retryFailedPlatforms } = require('./api');
const { etDate, etHour, etTimestamp, loadJSON, parseArgs, recordFailure: _recordFailure } = require('./helpers');
const pathsLib = require('./paths');
const { getPlatformDef } = require('./platforms');

function runCreateVisualPost(config) {
  const { getArg, hasFlag } = parseArgs();

  const platform = config.platform || getArg('platform');
  const appName = getArg('app');
  let hook = getArg('hook');
  const promptsPath = getArg('prompts');
  const textsPath = getArg('texts');
  let caption = getArg('caption');

  // Merge config with platform registry if called directly
  if (!config.defaultPlatforms && platform) {
    const platDef = getPlatformDef(platform);
    config = { ...platDef, ...config };
  }

  const platforms = (getArg('platforms') || config.defaultPlatforms.join(',')).split(',');
  const shouldPublish = hasFlag('publish');
  const draftMode = hasFlag('draft');
  const scheduledDate = getArg('schedule');
  const dryRun = hasFlag('dry-run');
  const useRealtime = hasFlag('realtime');
  const useNext = hasFlag('next');

  if (!appName || !platform || (!hook && !useNext) || (!textsPath && !useNext)) {
    console.error('Usage: node create-visual-post-engine.js --app <name> --platform <platform> --hook "..." --texts <texts.json>');
    console.error('  --next: auto-pick next hook from strategy.json postQueue');
    console.error('  --prompts: optional if queue entry has slidePrompts');
    process.exit(1);
  }

  const DROPSPACE_URL = 'https://api.dropspace.dev';
  const DROPSPACE_KEY = process.env.DROPSPACE_API_KEY_DROPSPACE;
  if (!DROPSPACE_KEY) { console.error('ERROR: DROPSPACE_API_KEY_DROPSPACE not set'); process.exit(1); }

  const appDir = pathsLib.platformDir(appName, platform);
  const appConfig = pathsLib.loadAppConfig(appName) || {};
  const profile = appConfig;
  const strategyFilePath = pathsLib.strategyPath(appName, platform);
  const strategy = loadJSON(strategyFilePath, {});

  // Blueprint data extracted from queue entries
  let blueprintSlideTexts = null;
  let blueprintSlidePrompts = null;
  let postFormat = 'slideshow'; // default, can be overridden by queue entry

  // --next: auto-pick from postQueue
  if (useNext && !hook) {
    if (!strategy.postQueue || strategy.postQueue.length === 0) {
      console.error('ERROR: --next specified but postQueue is empty in strategy.json');
      process.exit(1);
    }
    const nextEntry = strategy.postQueue.find(h => !(h.text || h).startsWith('[AGENT:'));
    if (!nextEntry) { console.error('ERROR: no usable posts in postQueue'); process.exit(1); }
    hook = nextEntry.text || nextEntry;
    if (nextEntry.slideTexts) {
      console.log(`📋 Blueprint found — using pre-generated slide texts + caption`);
      blueprintSlideTexts = nextEntry.slideTexts;
      if (nextEntry.caption && !caption) caption = nextEntry.caption;
      if (nextEntry.slidePrompts) blueprintSlidePrompts = nextEntry.slidePrompts;
    }
    if (nextEntry.format) postFormat = nextEntry.format;
    console.log(`🎣 Auto-picked post from queue: "${hook}"`);
  }

  // When --hook is passed directly, look up blueprint from queue
  if (hook && !useNext) {
    const hookLower = hook.toLowerCase();
    const queueEntry = (strategy.postQueue || []).find(h => (h.text || '').toLowerCase() === hookLower);
    if (queueEntry && queueEntry.slideTexts) {
      console.log(`📋 Blueprint found in queue — using pre-generated slide texts + caption`);
      blueprintSlideTexts = queueEntry.slideTexts;
      if (queueEntry.caption && !caption) caption = queueEntry.caption;
      if (queueEntry.slidePrompts) blueprintSlidePrompts = queueEntry.slidePrompts;
    }
    if (queueEntry && queueEntry.format) postFormat = queueEntry.format;
  }

  // Load prompts: LLM slidePrompts or prompts file
  let prompts;

  if (blueprintSlidePrompts && blueprintSlidePrompts.length === 6) {
    console.log(`🎨 Using LLM-generated slide prompts`);
    prompts = {
      base: '',
      slides: blueprintSlidePrompts,
      llmControlled: true,
    };
  } else if (promptsPath) {
    prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  } else {
    console.error('🎨 No slidePrompts — cannot generate images. Queue entries must have slidePrompts array.');
    process.exit(1);
  }

  const texts = textsPath
    ? JSON.parse(fs.readFileSync(textsPath, 'utf-8'))
    : blueprintSlideTexts;
  if (!texts) { console.error('ERROR: No texts provided (--texts or blueprint slideTexts)'); process.exit(1); }

  // Determine expected slide count from format
  const { FORMATS } = require('./experiments');
  const formatDef = FORMATS[postFormat];
  const expectedSlides = formatDef?.slides || 6;

  if (!prompts.slides || prompts.slides.length !== expectedSlides) {
    // Allow 6-slide prompts even for short formats (will use first N)
    if (prompts.slides && prompts.slides.length === 6 && expectedSlides < 6) {
      console.log(`  📐 Format "${postFormat}" uses ${expectedSlides} slides — trimming from 6`);
      prompts.slides = prompts.slides.slice(0, expectedSlides);
    } else {
      console.error(`ERROR: prompts must have exactly ${expectedSlides} slides for format "${postFormat}" (got ${prompts.slides?.length || 0})`);
      process.exit(1);
    }
  }
  if (texts.length !== expectedSlides) {
    if (texts.length === 6 && expectedSlides < 6) {
      console.log(`  📐 Trimming slide texts from 6 to ${expectedSlides}`);
      texts.length = expectedSlides;
    } else {
      console.error(`ERROR: texts must have exactly ${expectedSlides} entries for format "${postFormat}" (got ${texts.length})`);
      process.exit(1);
    }
  }

  // Failures
  const failuresPath = pathsLib.failuresPath(appName, platform);
  function recordFailure(rule, context = {}) {
    _recordFailure(failuresPath, rule, context);
  }

  if (fs.existsSync(failuresPath)) {
    const failures = JSON.parse(fs.readFileSync(failuresPath, 'utf-8'));
    if (failures.failures?.length > 0) {
      console.log(`\n⚠️  Checking ${failures.failures.length} failure rules...`);
      for (const f of failures.failures) console.log(`  📌 ${f.rule}`);
      console.log('');
    }
  }

  // Output directory
  const timestamp = etTimestamp(new Date());
  const postDir = pathsLib.postAssetsDir(appName, platform, timestamp);
  fs.mkdirSync(postDir, { recursive: true });

  // ── Image generation ──
  const imageModel = strategy.imageGen?.model || profile.imageGen?.model || 'gpt-image-1.5';
  const imageApiKey = process.env.OPENAI_API_KEY;

  if (!imageApiKey) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }

  async function generateOpenAI(prompt, outPath) {
    const body = { model: imageModel, prompt, n: 1, size: '1024x1536', quality: 'high', output_format: 'png' };
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${imageApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const b64 = data.data[0].b64_json;
    if (b64) {
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    } else if (data.data[0].url) {
      const imgRes = await fetch(data.data[0].url);
      fs.writeFileSync(outPath, Buffer.from(await imgRes.arrayBuffer()));
    } else {
      throw new Error('No image data in response');
    }
  }

  const providers = { openai: generateOpenAI };

  async function withRetry(fn, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (attempt < retries) {
          console.log(`  ⚠️ ${e.message}. Retrying (${attempt + 1}/${retries})...`);
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        } else throw e;
      }
    }
  }

  // ── Canvas / text overlay setup ──
  let canvasModule;
  const canvasSearchPaths = [
    'canvas',
    path.join(process.env.HOME || '', 'markus-automation', 'node_modules', 'canvas'),
    path.join(process.env.HOME || '', 'node_modules', 'canvas'),
  ];
  for (const cp of canvasSearchPaths) {
    try { canvasModule = require(cp); break; } catch {}
  }
  if (!canvasModule) {
    console.error(`ERROR: node-canvas not installed. Run: cd ~/markus && npm install canvas`);
    process.exit(1);
  }

  const { registerFont } = canvasModule;
  const FONT_SEARCH = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/LiberationSans-Bold.ttf',
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules/openclaw/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf'),
    path.join(pathsLib.platformDir(appName, platform), 'fonts', 'LiberationSans-Bold.ttf'),
    path.join(process.env.HOME || '', 'markus-automation', 'fonts', 'LiberationSans-Bold.ttf'),
  ];
  let fontRegistered = false;
  for (const fp of FONT_SEARCH) {
    if (fs.existsSync(fp)) {
      try { registerFont(fp, { family: 'Arial', weight: 'bold' }); fontRegistered = true; break; }
      catch (e) { console.warn(`⚠️ Could not register font ${fp}: ${e.message}`); }
    }
  }
  if (!fontRegistered) console.warn(`⚠️ No bold font found — text overlays may render as boxes.`);

  const FONT_REGULAR_SEARCH = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules/openclaw/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),
    path.join(pathsLib.platformDir(appName, platform), 'fonts', 'LiberationSans-Regular.ttf'),
    path.join(process.env.HOME || '', 'markus-automation', 'fonts', 'LiberationSans-Regular.ttf'),
  ];
  for (const fp of FONT_REGULAR_SEARCH) {
    if (fs.existsSync(fp)) {
      try { registerFont(fp, { family: 'Arial', weight: 'normal' }); break; } catch {}
    }
  }

  function wrapText(ctx, text, maxWidth) {
    const cleanText = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const lines = [];
    for (const line of cleanText.split('\n')) {
      if (ctx.measureText(line.trim()).width <= maxWidth) { lines.push(line.trim()); continue; }
      let current = '';
      for (const word of line.trim().split(/\s+/)) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) { current = test; }
        else { if (current) lines.push(current); current = word; }
      }
      if (current) lines.push(current);
    }
    return lines;
  }

  // ── Overlay styles per format ──
  const OVERLAY_STYLES = {
    'slideshow': { position: 'upper-third', fontScale: 'auto', stroke: true, fill: '#FFFFFF', strokeColor: '#000000', bg: null },
    'identity-cards': { position: 'center', fontScale: 'large', stroke: false, fill: '#FFFFFF', strokeColor: null, bg: 'rgba(0,0,0,0.65)', bgPadding: 0.04 },
    'short-cta': { position: 'center', fontScale: 'large', stroke: true, fill: '#FFFFFF', strokeColor: '#000000', bg: null },
    'meme': { position: 'top-bottom', fontScale: 'impact', stroke: true, fill: '#FFFFFF', strokeColor: '#000000', bg: null },
    'branded-consistent': { position: 'lower-third', fontScale: 'auto', stroke: false, fill: '#FFFFFF', strokeColor: null, bg: 'rgba(0,0,0,0.7)', bgPadding: 0.03 },
  };

  async function addOverlay(imgPath, text, outPath, slideIndex) {
    const img = await canvasModule.loadImage(imgPath);
    const canvas = canvasModule.createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const style = OVERLAY_STYLES[postFormat] || OVERLAY_STYLES['slideshow'];
    const wordCount = text.split(/\s+/).length;

    // Font sizing
    let fontSizePercent;
    if (style.fontScale === 'large') {
      fontSizePercent = wordCount <= 5 ? 0.085 : wordCount <= 12 ? 0.070 : 0.055;
    } else if (style.fontScale === 'impact') {
      fontSizePercent = wordCount <= 8 ? 0.090 : 0.065;
    } else {
      fontSizePercent = wordCount <= 5 ? 0.075 : wordCount <= 12 ? 0.065 : 0.050;
    }
    const fontSize = Math.round(img.width * fontSizePercent);
    const outlineWidth = Math.round(fontSize * 0.15);
    const maxWidth = img.width * (style.bg ? 0.85 : 0.75);
    const lineHeight = fontSize * 1.25;

    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const lines = wrapText(ctx, text, maxWidth);
    const totalHeight = lines.length * lineHeight;

    // Position calculation
    let safeY;
    if (style.position === 'center') {
      safeY = (img.height - totalHeight) / 2;
    } else if (style.position === 'lower-third') {
      safeY = img.height * 0.65 - totalHeight / 2;
    } else if (style.position === 'top-bottom') {
      // Meme style: text at top for odd slides, bottom for even
      safeY = (slideIndex || 0) % 2 === 0
        ? img.height * 0.05
        : img.height * 0.85 - totalHeight;
    } else {
      // upper-third (default/slideshow)
      const rawY = (img.height * 0.30) - (totalHeight / 2) + (lineHeight / 2);
      safeY = Math.max(img.height * 0.10, Math.min(rawY, img.height * 0.80 - totalHeight));
    }

    const x = img.width / 2;

    // Background box (for identity-cards, branded-consistent)
    if (style.bg) {
      const pad = img.width * (style.bgPadding || 0.03);
      const boxWidth = maxWidth + pad * 2;
      const boxHeight = totalHeight + pad * 2;
      const boxX = (img.width - boxWidth) / 2;
      const boxY = safeY - pad;
      ctx.fillStyle = style.bg;
      ctx.beginPath();
      // Rounded rect
      const r = Math.round(img.width * 0.02);
      ctx.moveTo(boxX + r, boxY);
      ctx.lineTo(boxX + boxWidth - r, boxY);
      ctx.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + r);
      ctx.lineTo(boxX + boxWidth, boxY + boxHeight - r);
      ctx.quadraticCurveTo(boxX + boxWidth, boxY + boxHeight, boxX + boxWidth - r, boxY + boxHeight);
      ctx.lineTo(boxX + r, boxY + boxHeight);
      ctx.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - r);
      ctx.lineTo(boxX, boxY + r);
      ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
      ctx.fill();
    }

    for (let i = 0; i < lines.length; i++) {
      const y = safeY + (i * lineHeight);
      if (style.stroke) {
        ctx.strokeStyle = style.strokeColor || '#000000';
        ctx.lineWidth = outlineWidth;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(lines[i], x, y);
      }
      ctx.fillStyle = style.fill || '#FFFFFF';
      ctx.fillText(lines[i], x, y);
    }

    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    return lines;
  }

  // Dropspace API wrapper
  async function dropspaceAPI(method, endpoint, body = null) {
    return _dropspaceReq(method, endpoint, body, DROPSPACE_KEY);
  }

  // ── MAIN ──
  (async () => {
    console.log(`\n🎬 Creating ${platform} post for ${appName}`);
    console.log(`   Hook: "${hook}"`);
    console.log(`   Platforms: ${platforms.join(', ')}`);
    console.log(`   Model: ${imageModel}`);
    console.log(`   Output: ${postDir}\n`);

    if (dryRun) console.log('🏃 Dry run — will generate images and overlays but not upload or publish.\n');

    // ── Step 1: Generate images ──
    console.log(`📸 Step 1: Generating ${expectedSlides} images (format: ${postFormat})...\n`);

    const genFn = providers.openai;

    // Check for pre-generated batch results
    const pendingBatchesPath = pathsLib.pendingBatchesPath(appName, platform);
    let usedPregenerated = false;

    if (!useRealtime && fs.existsSync(pendingBatchesPath)) {
      const pending = JSON.parse(fs.readFileSync(pendingBatchesPath, 'utf-8'));
      const match = pending.batches.find(b =>
        b.hook.toLowerCase() === hook.toLowerCase() && !['used', 'partial'].includes(b.status)
      );

      if (match) {
        console.log(`  📦 Found pre-submitted batch: ${match.openAiBatchId}`);
        const statusRes = await fetch(`https://api.openai.com/v1/batches/${match.openAiBatchId}`, {
          headers: { 'Authorization': `Bearer ${imageApiKey}` }
        });
        const batch = await statusRes.json();

        if (batch.status === 'completed' && batch.output_file_id) {
          console.log('  ✅ Batch completed — downloading results...\n');
          const dlRes = await fetch(`https://api.openai.com/v1/files/${batch.output_file_id}/content`, {
            headers: { 'Authorization': `Bearer ${imageApiKey}` }
          });
          const outputText = await dlRes.text();
          const results = outputText.trim().split('\n').map(line => JSON.parse(line));

          let successCount = 0;
          for (const result of results) {
            const slideMatch = result.custom_id.match(/slide-(\d+)/);
            if (!slideMatch) continue;
            const idx = parseInt(slideMatch[1]) - 1;
            const outPath = path.join(postDir, `slide${idx + 1}_raw.png`);
            if (result.error || !result.response?.body?.data?.[0]?.b64_json) {
              console.error(`  ❌ Slide ${idx + 1} failed in batch`);
              continue;
            }
            fs.writeFileSync(outPath, Buffer.from(result.response.body.data[0].b64_json, 'base64'));
            console.log(`  ✅ slide${idx + 1}_raw.png (from batch)`);
            successCount++;
          }

          if (successCount === expectedSlides) {
            usedPregenerated = true;
            match.status = 'used';
            fs.writeFileSync(pendingBatchesPath, JSON.stringify(pending, null, 2));
            console.log(`\n  📦 All ${expectedSlides} slides from pre-generated batch (~50% cost savings)\n`);
          } else {
            match.status = 'partial';
            fs.writeFileSync(pendingBatchesPath, JSON.stringify(pending, null, 2));
            console.log(`\n  ⚠️ Only ${successCount}/${expectedSlides} from batch — generating missing slides realtime\n`);
          }
        } else if (['failed', 'cancelled', 'expired'].includes(batch.status)) {
          console.log(`  ⚠️ Batch ${batch.status} — falling back to realtime generation\n`);
          match.status = batch.status;
          fs.writeFileSync(pendingBatchesPath, JSON.stringify(pending, null, 2));
        } else {
          console.log(`  ⏳ Batch still ${batch.status} — falling back to realtime generation\n`);
        }
      }
    }

    // Prune terminal/stale batch entries
    if (fs.existsSync(pendingBatchesPath)) {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingBatchesPath, 'utf-8'));
        const TERMINAL = ['used', 'failed', 'cancelled', 'expired', 'partial'];
        const STALE_MS = 7 * 24 * 60 * 60 * 1000;
        const before = pending.batches.length;
        pending.batches = pending.batches.filter(b => {
          if (TERMINAL.includes(b.status)) return false;
          if (b.submittedAt && Date.now() - new Date(b.submittedAt).getTime() > STALE_MS) return false;
          return true;
        });
        if (pending.batches.length < before) {
          fs.writeFileSync(pendingBatchesPath, JSON.stringify(pending, null, 2));
          console.log(`  🧹 Pruned ${before - pending.batches.length} terminal/stale batch entries`);
        }
      } catch { /* non-critical */ }
    }

    // Generate missing slides via realtime
    if (!usedPregenerated) {
      const slidePrompts = [], slideOutPaths = [], slideIndices = [];
      for (let i = 0; i < expectedSlides; i++) {
        const outPath = path.join(postDir, `slide${i + 1}_raw.png`);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
          console.log(`  ⏭ slide${i + 1}_raw.png exists, skipping`);
          continue;
        }
        // If LLM controls prompts, slides[i] is the full prompt; otherwise concat base + slide
        const fullPrompt = prompts.llmControlled
          ? prompts.slides[i]
          : `${prompts.base}\n\n${prompts.slides[i]}`;
        slidePrompts.push(fullPrompt);
        slideOutPaths.push(outPath);
        slideIndices.push(i);
      }

      if (slidePrompts.length === 0) {
        console.log('  All slides already generated.\n');
      } else {
        console.log(`  🔄 Generating ${slidePrompts.length} slides realtime...\n`);
        const CONCURRENCY = 3;
        for (let batch = 0; batch < slidePrompts.length; batch += CONCURRENCY) {
          const genPromises = [];
          for (let j = 0; j < Math.min(CONCURRENCY, slidePrompts.length - batch); j++) {
            const idx = batch + j;
            const slideNum = slideIndices[idx] + 1;
            console.log(`  Generating slide ${slideNum}...`);
            genPromises.push(
              withRetry(() => genFn(slidePrompts[idx], slideOutPaths[idx]))
                .then(() => console.log(`  ✅ slide${slideNum}_raw.png`))
                .catch(e => { console.error(`  ❌ Slide ${slideNum} failed: ${e.message}`); throw e; })
            );
          }
          try { await Promise.all(genPromises); }
          catch { console.error(`\n  Re-run to retry — completed slides are preserved.`); process.exit(1); }
        }
      }
    }

    // ── Step 2: Text overlays ──
    console.log('\n📝 Step 2: Adding text overlays...\n');
    for (let i = 0; i < expectedSlides; i++) {
      const rawPath = path.join(postDir, `slide${i + 1}_raw.png`);
      const outPath = path.join(postDir, `slide${i + 1}.png`);
      if (!fs.existsSync(rawPath)) { console.error(`  ❌ Missing: ${rawPath}`); process.exit(1); }
      const lines = await addOverlay(rawPath, texts[i], outPath, i);
      console.log(`  ✅ slide${i + 1}.png — ${lines.length} lines (${postFormat} style)`);
    }

    // ── Step 2.5: Validate generated images ──
    console.log('\n🔍 Validating slides...\n');
    let validationFailed = false;
    for (let i = 1; i <= expectedSlides; i++) {
      const overlayPath = path.join(postDir, `slide${i}.png`);
      const rawPath = path.join(postDir, `slide${i}_raw.png`);
      const stat = fs.statSync(overlayPath);
      const rawStat = fs.statSync(rawPath);

      // Check file size (raw image should be >10KB, overlay should be >10KB)
      if (rawStat.size < 10000) {
        console.error(`  ❌ slide${i}_raw.png is suspiciously small (${(rawStat.size / 1024).toFixed(1)}KB) — likely corrupted`);
        validationFailed = true;
        continue;
      }

      // Check dimensions via canvas
      const checkImg = await canvasModule.loadImage(overlayPath);
      if (checkImg.width < 512 || checkImg.height < 512) {
        console.error(`  ❌ slide${i}.png has wrong dimensions: ${checkImg.width}×${checkImg.height} (expected ~1024×1536)`);
        validationFailed = true;
        continue;
      }

      // Aspect ratio check (should be roughly 2:3 portrait)
      const ratio = checkImg.height / checkImg.width;
      if (ratio < 1.2 || ratio > 1.8) {
        console.warn(`  ⚠️ slide${i}.png has unusual aspect ratio: ${ratio.toFixed(2)} (expected ~1.5)`);
      }

      console.log(`  ✅ slide${i}.png — ${checkImg.width}×${checkImg.height}, ${(stat.size / 1024).toFixed(0)}KB`);
    }
    if (validationFailed) {
      console.error('\n❌ Image validation failed — aborting to prevent posting broken images.');
      console.error('   Re-run to regenerate failed slides (completed slides are preserved).');
      recordFailure('Image validation failed: corrupted or wrong-dimension slides', { hook });
      process.exit(1);
    }

    if (dryRun) { console.log(`\n✨ Dry run complete. Images in ${postDir}`); process.exit(0); }

    // ── Step 3: Compress + create launch ──
    console.log('\n📦 Compressing slides to JPEG...\n');
    const media = [];
    for (let i = 1; i <= expectedSlides; i++) {
      const pngPath = path.join(postDir, `slide${i}.png`);
      const jpgPath = path.join(postDir, `slide${i}.jpg`);
      const img = await canvasModule.loadImage(pngPath);
      const canvas = canvasModule.createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const jpgBuffer = canvas.toBuffer('image/jpeg', { quality: 0.70 });
      fs.writeFileSync(jpgPath, jpgBuffer);
      console.log(`  ✅ slide${i}.jpg — ${(jpgBuffer.length / 1024).toFixed(0)}KB (was ${(fs.statSync(pngPath).size / 1024).toFixed(0)}KB PNG)`);
      media.push({ source: 'base64', data: jpgBuffer.toString('base64'), filename: `slide${i}.jpg`, mime_type: 'image/jpeg' });
    }

    // Clean up raw PNGs and overlay PNGs (JPGs + Dropspace URLs are the source of truth now)
    for (let i = 1; i <= expectedSlides; i++) {
      const rawPath = path.join(postDir, `slide${i}_raw.png`);
      const pngPath = path.join(postDir, `slide${i}.png`);
      try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch {}
      try { if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath); } catch {}
    }
    console.log(`  🧹 Cleaned up ${expectedSlides * 2} PNG files (JPGs + Dropspace URLs are source of truth)`);

    // Minimum media check (Instagram needs ≥ 2)
    const minMedia = config.minMedia || 1;
    if (media.length < minMedia) {
      console.error(`❌ ${platform} requires ≥ ${minMedia} images, only ${media.length} generated`);
      recordFailure(`${platform} requires ≥ ${minMedia} images, only ${media.length} generated`, { hook });
      process.exit(1);
    }

    // Idempotency check
    const today = new Date().toISOString().slice(0, 10);
    try {
      const existingRes = await dropspaceAPI('GET', '/launches?page_size=50');
      const duplicate = existingRes.data?.find(l =>
        (l.name || "").toLowerCase().trim() === hook.toLowerCase().trim() &&
        l.created_at?.startsWith(today) &&
        l.platforms?.includes(platforms[0]) &&
        !['cancelled', 'failed'].includes(l.status)
      );
      if (duplicate) {
        console.log(`\n⚠️ Launch already exists for this hook today: ${duplicate.id} (${duplicate.status})`);
        console.log('Skipping to avoid duplicate. Use --force to override.');
        if (!hasFlag('force')) process.exit(0);
      }
    } catch (e) { console.warn('  ⚠️ Could not check for duplicates:', e.message); }

    // Build platform_contents
    const platformContents = {};
    for (const p of platforms) {
      const entry = { content: caption || hook };
      if (p === 'reddit') entry.title = hook;
      if (p === 'tiktok') {
        entry.tiktok_settings = {
          privacy_level: config.tiktokPrivacyLevel || 'PUBLIC_TO_EVERYONE',
          auto_add_music: true,
          allow_comments: true,
          allow_duet: true,
          allow_stitch: true,
        };
      }
      // Platform-specific extras
      if (config.platformContentsExtra) {
        Object.assign(entry, config.platformContentsExtra(p, caption, hook));
      }
      platformContents[p] = entry;
    }

    console.log('\n🚀 Creating Dropspace launch...\n');
    const launchBody = {
      title: hook,
      product_description: profile.description || 'Dropspace - launch your product everywhere in one click',
      platforms,
      dropspace_platforms: platforms,
      product_url: profile.url || null,
      media,
      media_attach_platforms: platforms,
      media_mode: 'images',
      platform_contents: platformContents,
    };
    if (scheduledDate) {
      launchBody.scheduled_date = scheduledDate;
      console.log(`  📅 Scheduled for: ${scheduledDate}`);
    }

    const launchRes = await dropspaceAPI('POST', '/launches', launchBody);
    if (launchRes.error || !launchRes.data?.id) {
      const errMsg = launchRes.error?.message || launchRes.error?.code || 'Launch creation failed';
      console.error(`  ❌ Launch creation failed: ${errMsg}`);
      recordFailure(`Launch creation failed: ${errMsg}`, { hook });
      process.exit(1);
    }
    const launchId = launchRes.data.id;
    console.log(`  ✅ Launch created: ${launchId}`);

    // ── Step 4: Publish / Schedule ──
    if (scheduledDate) {
      console.log(`\n📅 SCHEDULED — Launch ${launchId} will publish at ${scheduledDate}`);
      console.log(`   Dashboard: https://www.dropspace.dev/launches/${launchId}`);
    } else if (shouldPublish && !draftMode) {
      console.log('\n📤 Publishing...\n');
      const pubRes = await dropspaceAPI('POST', `/launches/${launchId}/publish`);
      if (pubRes.error) {
        const errMsg = pubRes.error.message || pubRes.error.code || 'Unknown publish error';
        console.error(`  ❌ Publish failed: ${errMsg}`);
        recordFailure(`Publish failed: ${errMsg}`, { launchId });
        process.exit(1);
      }
      console.log('  ✅ Publish queued');

      const verification = await verifyPublish(DROPSPACE_KEY, launchId, platform);
      if (verification.postUrl) console.log(`  🔗 Post URL: ${verification.postUrl}`);
      if (verification.status === 'partial') {
        console.warn(`\n⚠️  Partial success — retrying failed platforms...`);
        const retry = await retryFailedPlatforms(DROPSPACE_KEY, launchId);
        if (retry.retried) console.log(`  🔄 Retrying: ${retry.platforms.join(', ')}`);
        else console.warn(`  ⚠️  Retry: ${retry.error}`);
      }
      if (!verification.ok || verification.warnings.length > 0) {
        console.warn(`\n⚠️  POST-PUBLISH WARNINGS:`);
        for (const w of verification.warnings) console.warn(`  ⚠️  ${w}`);
        recordFailure(`Partial publish: ${verification.warnings.join('; ')}`, { launchId });
      }
    } else if (draftMode) {
      if (config.draftMessage) {
        console.log(config.draftMessage(launchId, hook, caption));
      } else {
        console.log(`\n📋 DRAFT MODE — Launch ${launchId} ready for publishing`);
      }
    } else {
      console.log(`\n📋 Launch created as draft. Publish with:`);
      console.log(`   curl -X POST ${DROPSPACE_URL}/launches/${launchId}/publish -H "Authorization: Bearer $DROPSPACE_API_KEY_DROPSPACE"`);
    }

    // Update posts.json
    const postsPath = pathsLib.postsPath(appName, platform);
    try {
      const postsData = JSON.parse(fs.readFileSync(postsPath, 'utf-8'));
      const existingPost = postsData.posts.find(p => p.launchId === launchId);
      const baseMetrics = {
        launchId,
        text: hook,
        format: postFormat,
        date: etDate(new Date()),
        hour: etHour(new Date()),
        conversions: 0, trials: 0, paid: 0, revenue: 0,

        lastChecked: new Date().toISOString(),
        caption: caption || null,
        slideTexts: texts || null,
        slidePrompts: blueprintSlidePrompts || null,
        ...(config.postMetricFields ? config.postMetricFields() : {}),
      };
      if (existingPost) {
        Object.assign(existingPost, baseMetrics);
      } else {
        postsData.posts.push(baseMetrics);
      }
      fs.writeFileSync(postsPath, JSON.stringify(postsData, null, 2));
      console.log(`  ✅ Post saved to posts.json`);
    } catch (e) { console.warn(`  ⚠️ Could not update posts.json: ${e.message}`); }

    // Dequeue from postQueue
    try {
      const freshStrategy = JSON.parse(fs.readFileSync(strategyFilePath, 'utf-8'));
      const hookLower = hook.toLowerCase();
      const before = freshStrategy.postQueue?.length || 0;
      freshStrategy.postQueue = (freshStrategy.postQueue || []).filter(h => (h.text || h).toLowerCase() !== hookLower);
      fs.writeFileSync(strategyFilePath, JSON.stringify(freshStrategy, null, 2));
      if (before > freshStrategy.postQueue.length) {
        console.log(`  ✅ Dequeued post from strategy.json (${freshStrategy.postQueue.length} remaining)`);
      }
    } catch (e) { console.warn(`  ⚠️ Could not dequeue hook: ${e.message}`); }

    // Save post metadata
    const meta = {
      launchId, app: appName, hook,
      format: postFormat,
      caption: caption || '(AI-generated)',
      platforms, model: imageModel,
      published: shouldPublish && !draftMode,
      createdAt: new Date().toISOString(),
      postDir,
    };
    fs.writeFileSync(path.join(postDir, 'meta.json'), JSON.stringify(meta, null, 2));

    console.log(`\n✨ Done! Launch ID: ${launchId}`);
  })().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
}

// CLI entrypoint — run directly with: node create-visual-post-engine.js --app X --platform Y [--next] [--schedule ISO]
if (require.main === module) {
  runCreateVisualPost({});
}

module.exports = { runCreateVisualPost };
