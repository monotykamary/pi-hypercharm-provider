#!/usr/bin/env node

/**
 * Update HyperCharm models from API
 *
 * Fetches models from https://hyper.charm.land/v1/models and updates:
 * - models.json: Model definitions with curated reasoning/vision flags + API pricing
 * - README.md: Model table with patch.json overrides applied
 *
 * The HyperCharm API provides: id, display_name, supports_reasoning,
 * supports_reasoning_effort, supports_attachments, context_window,
 * max_output_tokens, and cost.usd pricing.
 *
 * Note: supports_reasoning is unreliable for some models (reports true for
 * Llama 3.3 70B which doesn't support extended thinking). models.json
 * curates reasoning flags based on known model capabilities; patch.json
 * adds compat flags and corrections.
 *
 * Merge order for README: models.json → apply patch.json → merge custom-models.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_API_URL = 'https://hyper.charm.land/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const PATCH_JSON_PATH = path.join(__dirname, '..', 'patch.json');
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function convertPricing(v) {
  if (!v) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  // API returns $/M directly; round to 6 decimals to preserve sub-cent cache prices.
  return Math.round(n * 1e6) / 1e6;
}

// ─── Patch application ────────────────────────────────────────────────────────

function applyPatch(model, patch) {
  const result = { ...model };
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };
  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }
  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }
  return result;
}

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) modelMap.set(model.id, model);
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) modelMap.set(id, applyPatch(existing, patchEntry));
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
    if (existing && patchEntry) modelMap.set(model.id, applyPatch(model, patchEntry));
    else if (existing) modelMap.set(model.id, model);
    else if (patchEntry) modelMap.set(model.id, applyPatch(model, patchEntry));
    else modelMap.set(model.id, model);
  }
  return Array.from(modelMap.values());
}

// ─── Model transformation ─────────────────────────────────────────────────────

// Known non-reasoning models (API incorrectly reports supports_reasoning: true)
const NON_REASONING_IDS = new Set([
  'llama-3.3-70b-instruct',
  'llama-4-maverick-17b-128e-instruct-fp8',
]);

// Known vision models
const VISION_IDS = new Set([
  'kimi-k2.5',
  'kimi-k2.6',
  'glm-5.1',
  'gemma-4-26b-a4b-it',
  'qwen3.6-flash',
  'qwen3.6-max',
  'qwen3.6-plus',
  'qwen3.7-max',
]);

function transformModel(apiModel, existingModelsMap) {
  const modelId = apiModel.id;

  // Preserve existing curated data
  if (existingModelsMap[modelId]) {
    const existing = { ...existingModelsMap[modelId] };

    // Update fields from API that may change
    const cost = apiModel.cost?.usd || {};
    const inputCost = convertPricing(cost['1m_in']);
    const outputCost = convertPricing(cost['1m_out']);
    const cacheReadCost = convertPricing(cost['1m_in_cache']);
    const cacheWriteCost = convertPricing(cost['1m_out_cache']);

    if (inputCost > 0) existing.cost.input = inputCost;
    if (outputCost > 0) existing.cost.output = outputCost;
    if (cacheReadCost > 0) existing.cost.cacheRead = cacheReadCost;
    if (cacheWriteCost > 0) existing.cost.cacheWrite = cacheWriteCost;
    if (apiModel.context_window) existing.contextWindow = apiModel.context_window;
    // Don't override maxTokens from API for DeepSeek — it reports 8000 but the
    // actual max is 384K (set in models.json / patch.json)
    if (apiModel.max_output_tokens && !/^deepseek-v/.test(modelId)) {
      existing.maxTokens = apiModel.max_output_tokens;
    }

    return existing;
  }

  // New model — build from API data + curated defaults
  const cost = apiModel.cost?.usd || {};
  const isReasoning = apiModel.supports_reasoning === true && !NON_REASONING_IDS.has(modelId);
  const isVision = VISION_IDS.has(modelId);
  const isDeepSeek = /^deepseek-v/.test(modelId);

  const model = {
    id: modelId,
    name: apiModel.display_name || modelId,
    reasoning: isReasoning,
    input: isVision ? ['text', 'image'] : ['text'],
    cost: {
      input: convertPricing(cost['1m_in']),
      output: convertPricing(cost['1m_out']),
      cacheRead: convertPricing(cost['1m_in_cache']),
      cacheWrite: convertPricing(cost['1m_out_cache']),
    },
    contextWindow: apiModel.context_window || 0,
    maxTokens: apiModel.max_output_tokens || 0,
  };

  // DeepSeek models: override maxTokens (API reports 8000, actual is 384K)
  // and add thinkingLevelMap + deepseek compat
  if (isDeepSeek && isReasoning) {
    model.maxTokens = 384000;
    model.thinkingLevelMap = {
      minimal: null, low: null, medium: null, high: 'high', xhigh: 'max',
    };
    model.compat = {
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: true,
      supportsStore: false,
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    };
  }

  return model;
}

// ─── README generation ────────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0) return 'Free';
  if (cost === null || cost === undefined) return '-';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${Math.round(num / 1000)}K`;
  return num.toString();
}

function getInputTypes(inputTypes) {
  const types = inputTypes || ['text'];
  if (types.includes('image') && types.includes('text')) return 'Text + Image';
  if (types.includes('image')) return 'Image';
  return 'Text';
}

function generateReadmeRow(model) {
  const cost = model.cost || {};
  return `| ${model.name} | ${getInputTypes(model.input)} | ${formatNumber(model.contextWindow)} | ${formatNumber(model.maxTokens)} | ${formatCost(cost.input)} | ${formatCost(cost.output)} |`;
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');

  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const tableRows = sortedModels.map(generateReadmeRow).join('\n');
  const newTable = `| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
${tableRows}`;

  const tableRegex = /\| Model \| Type \| Context \| Max Tokens \| Input Cost \| Output Cost \|[\s\S]*?(?=\n\*Costs are per million)/;
  readme = readme.replace(tableRegex, newTable);

  readme = readme.replace(/\*\*\d+\+ AI Models\*\*/, `**${models.length}+ AI Models**`);

  fs.writeFileSync(README_PATH, readme);
  console.log(`✓ Updated README.md with ${models.length} models`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.HYPERCHARM_API_KEY;
  if (!apiKey) {
    console.error('Error: HYPERCHARM_API_KEY environment variable is required');
    console.error('Usage: HYPERCHARM_API_KEY=your-key node scripts/update-models.js');
    process.exit(1);
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);

  try {
    const response = await fetch(MODELS_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const apiResponse = await response.json();
    const apiModels = apiResponse.data || apiResponse;

    if (!Array.isArray(apiModels)) {
      throw new Error('API response does not contain an array of models');
    }

    console.log(`✓ Fetched ${apiModels.length} models from API`);

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf8'));
    } catch {
      // File might not exist yet
    }
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    // Transform models from API, preserving existing curated data
    let apiTransformed = apiModels.map(m => transformModel(m, existingModelsMap));
    apiTransformed.sort((a, b) => a.name.localeCompare(b.name));

    // Log new models (not in patch.json)
    const patch = loadJson(PATCH_JSON_PATH);
    for (const m of apiTransformed) {
      if (!patch[m.id]) {
        console.log(`  🆕 New model: ${m.id} (${m.name}) — add to patch.json for compat overrides`);
      }
    }

    // Update models.json — curated API data
    fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(apiTransformed, null, 2) + '\n');
    console.log(`✓ Updated models.json (${apiTransformed.length} models)`);

    // Load custom-models.json
    const customModels = Array.isArray(loadJson(CUSTOM_MODELS_JSON_PATH))
      ? loadJson(CUSTOM_MODELS_JSON_PATH)
      : [];

    // Check for custom models now available upstream (remove duplicates)
    const upstreamIds = new Set(apiTransformed.map(m => m.id));
    const duplicates = customModels.filter(m => upstreamIds.has(m.id));
    if (duplicates.length > 0) {
      console.log(`\nFound ${duplicates.length} custom model(s) now available upstream:`);
      for (const dup of duplicates) {
        console.log(`  - ${dup.id} (${dup.name})`);
      }
      const cleaned = customModels.filter(m => !upstreamIds.has(m.id));
      saveJson(CUSTOM_MODELS_JSON_PATH, cleaned);
      console.log(`✓ Removed ${duplicates.length} duplicate(s) from custom-models.json`);
      customModels.length = 0;
      customModels.push(...cleaned);
    }

    // Build merged models with patches for README
    const readmeModels = buildModels(apiTransformed, customModels, patch);
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));

    // Update README
    updateReadme(readmeModels);

    // Summary
    console.log('\n--- Summary ---');
    console.log(`Total models: ${readmeModels.length}`);
    console.log(`Reasoning models: ${readmeModels.filter(m => m.reasoning).length}`);
    console.log(`Vision models: ${readmeModels.filter(m => m.input.includes('image')).length}`);

    const newIds = new Set(apiTransformed.map(m => m.id));
    const oldIds = new Set(existingModels.map(m => m.id));

    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    if (added.length > 0) console.log(`\nNew models: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`\nRemoved models: ${removed.join(', ')}`);

    // Show pricing changes
    for (const model of apiTransformed) {
      const oldModel = existingModels.find(m => m.id === model.id);
      if (oldModel) {
        const oldInput = oldModel.cost?.input || 0;
        const oldOutput = oldModel.cost?.output || 0;
        if (oldInput !== model.cost.input || oldOutput !== model.cost.output) {
          console.log(`\nPricing change for ${model.id}:`);
          if (oldInput !== model.cost.input) {
            console.log(`  Input: $${oldInput}/M → $${model.cost.input}/M`);
          }
          if (oldOutput !== model.cost.output) {
            console.log(`  Output: $${oldOutput}/M → $${model.cost.output}/M`);
          }
        }
      }
    }

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
