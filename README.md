<div align="center">

# ✨ pi-hypercharm-provider

**17+ models through [Charm Hyper](https://hyper.charm.land/)**

_Hyperoptimized coding models — DeepSeek, GLM, Kimi, Qwen, MiniMax, Gemma, GPT-OSS, and Llama for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **19+ AI Models** including DeepSeek V4 Flash/Pro, GLM 5/5.1, Kimi K2.5/K2.6, Qwen3.6/3.7, MiniMax M2.7, Gemma 4, GPT-OSS, and Llama
- **DeepSeek Native Thinking** — Uses the `deepseek` thinking format with `reasoning_effort` and 384K max output for DeepSeek V4 models
- **OpenAI-compatible API** via Charm Hyper's `/v1/chat/completions` endpoint
- **Cost Tracking** with per-model pricing from the API
- **Reasoning Models** with `reasoning_effort` parameter support on select models
- **Vision Support** for image-capable models (Kimi K2.5/K2.6, GLM 5.1, Qwen3.6/3.7, Gemma 4)

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V4 Flash | Text | 1.0M | 384K | $0.14 | $0.28 |
| DeepSeek V4 Pro | Text | 1.0M | 384K | $0.43 | $0.87 |
| Gemma 4 26B A4B | Text + Image | 256K | 26K | $0.10 | $0.39 |
| GLM 5.1 | Text + Image | 203K | 64K | $1.40 | $4.40 |
| GLM-5 | Text | 203K | 20K | $0.95 | $3.04 |
| GPT-OSS 120B | Text | 131K | 13K | $0.18 | $0.68 |
| Kimi K2.5 | Text + Image | 262K | 26K | $0.54 | $2.71 |
| Kimi K2.6 | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.7 Code | Text | 256K | 33K | $0.95 | $4.00 |
| Llama 3.3 70B Instruct | Text | 128K | 13K | $0.61 | $1.04 |
| Llama 4 Maverick 17B 128E FP8 | Text | 430K | 43K | $0.28 | $0.90 |
| MiniMax M2.7 | Text | 205K | 131K | $0.30 | $1.20 |
| Qwen3 Coder 480B A35B INT4 | Text | 106K | 11K | $0.45 | $2.15 |
| Qwen3 Next 80B A3B | Text | 262K | 26K | $0.13 | $1.22 |
| Qwen3.6-Flash | Text + Image | 1.0M | 64K | $1.00 | $4.00 |
| Qwen3.6-Max | Text + Image | 256K | 64K | $2.00 | $12.00 |
| Qwen3.6-Plus | Text + Image | 1.0M | 64K | $2.00 | $6.00 |
| Qwen3.7-Max | Text + Image | 1.0M | 64K | $2.50 | $7.50 |
| Qwen3.7-Plus | Text | 1.0M | 64K | $1.20 | $4.80 |
*Costs are per million tokens. Prices subject to change — check [hyper.charm.land](https://hyper.charm.land) for current pricing.*

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-hypercharm-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export HYPERCHARM_API_KEY=your-api-key-here

pi
```

Get your API key from [hyper.charm.land](https://hyper.charm.land).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-hypercharm-provider.git
   cd pi-hypercharm-provider
   ```

2. Set your HyperCharm API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export HYPERCHARM_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-hypercharm-provider
   ```

## Usage

After loading the extension, select a model with:

```
/model hypercharm deepseek-v4-pro
```

Or start pi directly with a HyperCharm model:

```bash
pi --provider hypercharm --model deepseek-v4-pro
```

### Reasoning Effort

For reasoning models that support `reasoning_effort`, control thinking depth:

```bash
pi --provider hypercharm --model deepseek-v4-pro --reasoning-effort max
```

Values: `none`, `low`, `medium`, `high`, `max`

### Thinking Mode

DeepSeek V4 models use the `deepseek` thinking format — the same native format as the [pi-deepseek-provider](https://github.com/monotykamary/pi-deepseek-provider). This sends `thinking: {type: "enabled/disabled"}` plus `reasoning_effort` mapped via `thinkingLevelMap` (`high` → `"high"`, `max` → `"max"`). Replayed assistant messages include empty `reasoning_content` as required by DeepSeek's API.

## Authentication

The HyperCharm API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "hypercharm": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `HYPERCHARM_API_KEY`

Get your API key from [hyper.charm.land](https://hyper.charm.land).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HYPERCHARM_API_KEY` | No | Your Charm Hyper API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-hypercharm-provider"
  ]
}
```

### Compat Settings

Charm Hyper uses an OpenAI-compatible API. Compatibility settings are managed via `patch.json`:

**DeepSeek models** use the `deepseek` thinking format (identical to the native DeepSeek API):

- **`thinkingFormat: "deepseek"`** — Sends `thinking: {type: "enabled/disabled"}` to toggle thinking mode
- **`supportsReasoningEffort: true`** — Supports `reasoning_effort: "high" | "max"` via `thinkingLevelMap`
- **`requiresReasoningContentOnAssistantMessages: true`** — Replayed assistant messages include empty `reasoning_content` when reasoning is enabled
- **`maxTokensField: "max_tokens"`** — Uses `max_tokens` (not `max_completion_tokens`)

**Other reasoning models** (GLM, Kimi, Qwen, MiniMax, Gemma, GPT-OSS) use the `openai` thinking format:

- **`thinkingFormat: "openai"`** — Returns `reasoning_content` in OpenAI format
- **`supportsReasoningEffort: true`** — Accepts `reasoning_effort` parameter on supported models
- **`maxTokensField: "max_tokens"`** — Uses `max_tokens` (not `max_completion_tokens`)
- **`supportsDeveloperRole: true`** — Developer role messages are accepted
- **`supportsStore: false`** — The `store` parameter is not supported

> **Note:** The HyperCharm `/v1/models` endpoint reports `supports_reasoning: true` for all models,
> including those that don't natively support extended thinking (e.g., Llama 3.3 70B). `models.json`
> curates reasoning flags based on known model capabilities; `patch.json` adds compat overrides.

### Patch Overrides

The `patch.json` file contains overrides applied on top of `models.json` data:

- Correcting API-derived values (e.g., DeepSeek `maxTokens` from 8000 to 384000)
- Adding compat settings that the API doesn't provide
- Setting `thinkingFormat: "deepseek"` + `thinkingLevelMap` for DeepSeek V4 models
- Overriding pricing when official rates change

## Updating Models

Run the update script to fetch the latest models from the HyperCharm API:

```bash
export HYPERCHARM_API_KEY=your-api-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://hyper.charm.land/v1/models`
2. Preserve curated data (reasoning, vision, DeepSeek compat) from existing `models.json`
3. Apply overrides from `patch.json`
4. Remove custom models now available upstream from `custom-models.json`
5. Update `models.json` and the README model table

A GitHub Actions workflow runs this daily and creates a PR if models have changed.

## License

MIT
