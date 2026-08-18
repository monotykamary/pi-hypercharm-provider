#!/usr/bin/env node

/**
 * Update HyperCharm models from Charm's official typed provider catalog
 *
 * Fetches models from https://hyper.charm.land/v1/provider and updates:
 * - models.json: canonical API-owned metadata used by @charmland/pi-hyper-provider
 * - README.md: model table with patch.json overrides applied
 *
 * The endpoint provides canonical names, $/M pricing, context/output limits,
 * can_reason, optional reasoning levels, and attachment support. models.json is
 * pure API data. patch.json is reserved for verified endpoint regressions and
 * currently contains no overrides.
 *
 * Merge order for README: models.json → apply patch.json → merge custom-models.json
 *
 * API key: the stored `hypercharm` credential in ~/.pi/agent/auth.json wins, then
 * the HYPERCHARM_API_KEY environment variable. The script refuses to run without one.
 */

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `hypercharm` credential in ~/.pi/agent/auth.json wins, then
 * the HYPERCHARM_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.hypercharm;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.HYPERCHARM_API_KEY || undefined;
}

const MODELS_API_URL = 'https://hyper.charm.land/v1/provider';
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
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
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

const PI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Charm's official extension treats a reasoning-capable model with no levels as
// a boolean on/off model: Pi's max level selects the single on state.
const ON_OFF_THINKING_LEVEL_MAP = {
  off: 'off',
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: 'max',
};

function buildThinkingLevelMap(levels) {
  if (levels.length === 0) return undefined;
  const available = new Set(levels);
  const result = {
    // The provider enum uses "none" for the off state on newer deployments;
    // the official extension looked only for the older "off" spelling.
    off: available.has('off') ? 'off' : available.has('none') ? 'none' : null,
  };
  for (const level of PI_THINKING_LEVELS) {
    result[level] = available.has(level) ? level : null;
  }
  return result;
}

function transformModel(apiModel) {
  const reasoningLevels = Array.isArray(apiModel.reasoning_levels)
    ? apiModel.reasoning_levels.filter(level => typeof level === 'string')
    : [];
  const supportsReasoningEffort = reasoningLevels.length > 0;
  const thinkingLevelMap = supportsReasoningEffort
    ? buildThinkingLevelMap(reasoningLevels)
    : apiModel.can_reason === true
      ? ON_OFF_THINKING_LEVEL_MAP
      : undefined;

  return {
    id: apiModel.id,
    name: apiModel.name,
    reasoning: apiModel.can_reason === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: apiModel.supports_attachments === true ? ['text', 'image'] : ['text'],
    cost: {
      input: typeof apiModel.cost_per_1m_in === 'number' ? apiModel.cost_per_1m_in : 0,
      output: typeof apiModel.cost_per_1m_out === 'number' ? apiModel.cost_per_1m_out : 0,
      // Matches Charm's official extension: cacheRead is the discounted cached-output
      // price, cacheWrite the cached-input price.
      cacheRead: typeof apiModel.cost_per_1m_out_cached === 'number' ? apiModel.cost_per_1m_out_cached : 0,
      cacheWrite: typeof apiModel.cost_per_1m_in_cached === 'number' ? apiModel.cost_per_1m_in_cached : 0,
    },
    contextWindow: apiModel.context_window || 0,
    maxTokens: apiModel.default_max_tokens || apiModel.context_window || 0,
    compat: {
      supportsStore: false,
      supportsReasoningEffort,
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_tokens',
    },
  };
}

// ─── README generation ────────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0) return '—';
  if (cost === null || cost === undefined) return '—';
  return '$' + cost.toFixed(2);
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

// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map(m => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
}

/**
 * Grace-period deprecated models (deprecatedAt within TTL) with metadata stripped.
 * Keeps the README table serving models that are delisted but still within their
 * 14-day grace window.
 */
function withDeprecatedForReadme(models) {
  const deprecatedPath = path.join(process.cwd(), 'deprecated-models.json');
  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }
  const now = Date.now();
  const seen = new Set(models.map(m => m.id));
  const extras = [];
  for (const entry of Object.values(deprecated)) {
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    const removedAt = Date.parse(entry.deprecatedAt || '');
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const m = { ...entry };
    delete m.deprecatedAt;
    extras.push(m);
  }
  return extras.length > 0 ? [...models, ...extras] : models;
}
async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('Error: No API key found: no `hypercharm` credential resolved from ' + AUTH_JSON_PATH + ' and HYPERCHARM_API_KEY is not set');
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
    const apiModels = Array.isArray(apiResponse)
      ? apiResponse
      : (apiResponse.models || apiResponse.data || []);

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
    let apiTransformed = apiModels.map(m => transformModel(m));
    apiTransformed.sort((a, b) => a.name.localeCompare(b.name));

    // Load patch overrides for README rendering. Canonical metadata already
    // comes from /v1/provider, so new models do not require a patch entry.
    const patch = loadJson(PATCH_JSON_PATH);

    // Update models.json — curated API data
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    updateDeprecatedModels(MODELS_JSON_PATH, apiTransformed);
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
    const readmeModels = buildModels(withDeprecatedForReadme(apiTransformed), customModels, patch);
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
