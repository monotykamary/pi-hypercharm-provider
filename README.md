<div align="center">

# ✨ pi-hypercharm-provider

**17+ models through [Charm Hyper](https://hyper.charm.land/)**

_Hyperoptimized coding models — DeepSeek, GLM, Kimi, Qwen, MiniMax, Gemma, GPT-OSS, and Llama for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **24+ AI Models** including DeepSeek V4 Flash/Pro, GLM 5/5.1, Kimi K2.5/K2.6, Qwen3.6/3.7, MiniMax M2.7, Gemma 4, GPT-OSS, and Llama
- **DeepSeek Native Thinking** — Uses the `deepseek` thinking format for Charm Hyper requests, with native `reasoning_effort` on models that publish levels
- **OpenAI-compatible API** via Charm Hyper's `/v1/chat/completions` endpoint
- **Official Catalog Sync** from Charm's typed `/v1/provider` endpoint, matching `@charmland/pi-hyper-provider`
- **Reasoning Models** with provider-published on/off states and exact effort levels
- **Attachment Support** for models the official catalog marks as attachment-capable

## Available Models

| Model | Type | Context | Max Tokens | Input Cost | Output Cost |
|-------|------|---------|------------|------------|-------------|
| DeepSeek V4 Flash | Text | 1.0M | 384K | $0.20 | $0.40 |
| DeepSeek V4 Flash 0731 | Text | 1.0M | 384K | $0.15 | $0.30 |
| DeepSeek V4 Pro | Text | 1.0M | 384K | $2.40 | $4.80 |
| Gemma 4 26B A4B | Text | 256K | 26K | $0.13 | $0.43 |
| GLM-5 | Text | 203K | 20K | $0.85 | $2.62 |
| GLM-5.1 | Text | 203K | 131K | $1.52 | $4.79 |
| GLM-5.2 | Text | 1.0M | 128K | $1.40 | $4.40 |
| gpt-oss-120b | Text | 131K | 13K | $0.19 | $0.70 |
| Kimi K2.5 | Text | 262K | 26K | $0.56 | $2.82 |
| Kimi K2.6 | Text + Image | 262K | 262K | $0.95 | $4.00 |
| Kimi K2.7 Code | Text + Image | 256K | 16K | $0.95 | $4.00 |
| Kimi K3 | Text + Image | 1.0M | 131K | $3.27 | $16.33 |
| Llama 3.3 70B Instruct | Text | 128K | 13K | $0.51 | $1.04 |
| Llama 4 Maverick 17B 128E Instruct FP8 | Text | 430K | 43K | $0.28 | $0.93 |
| MiniMax M2.7 | Text | 205K | 20K | $0.44 | $1.72 |
| MiniMax M3 | Text + Image | 512K | 512K | $0.33 | $1.31 |
| Qwen3 Coder 480B A35B Instruct INT4 Mixed AR | Text | 106K | 11K | $0.57 | $2.13 |
| Qwen3 Next 80B A3B Instruct | Text | 262K | 26K | $0.12 | $1.14 |
| Qwen3.6-Flash | Text + Image | 1.0M | 64K | $1.00 | $4.00 |
| Qwen3.6-Max | Text | 256K | 64K | $2.00 | $12.00 |
| Qwen3.6-Plus | Text + Image | 1.0M | 64K | $2.00 | $6.00 |
| Qwen3.7-Flash | Text + Image | 1.0M | 64K | $0.20 | $0.80 |
| Qwen3.7-Max | Text | 1.0M | 64K | $2.50 | $7.50 |
| Qwen3.7-Plus | Text + Image | 1.0M | 64K | $1.20 | $4.80 |
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

Supported levels are model-specific and come from Charm's `/v1/provider` catalog (for example `low`/`medium`/`high` on Kimi K2.6). Models with no published levels support the Hyper thinking on state through Pi's `max` level.

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

### Catalog and Compat Settings

Model metadata matches Charm's official [`@charmland/pi-hyper-provider`](https://github.com/charmbracelet/pi-hyper-provider) transform:

- canonical `/v1/provider` names, prices, context windows, output caps, attachment flags, and `can_reason`
- `thinkingFormat: "deepseek"`, which maps Pi thinking levels onto Hyper's `thinking` envelope
- `reasoning_effort` only when the catalog publishes concrete level names
- `maxTokensField: "max_tokens"` and `supportsStore: false`
- zero `cacheWrite`, because Hyper reports discounted cached-output pricing, not cache-write cost

`patch.json` is reserved only for a verified provider regression and is currently empty.

### Patch Overrides

`patch.json` is applied on top of `models.json` only for verified endpoint corrections. It is currently empty because every live field comes from Charm's canonical provider catalog.

## Updating Models

Run the update script to fetch the latest models from the HyperCharm API:

```bash
export HYPERCHARM_API_KEY=your-api-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://hyper.charm.land/v1/models`
2. Regenerate `models.json` as pure metadata from Charm's typed `/v1/provider` catalog
3. Apply overrides from `patch.json` only when building the README
4. Remove custom models now available upstream from `custom-models.json`
5. Reconcile delisted models through the 14-day `deprecated-models.json` grace layer
6. Update `models.json` and the README model table

A GitHub Actions workflow runs this daily and creates a PR if models have changed.

## License

MIT
