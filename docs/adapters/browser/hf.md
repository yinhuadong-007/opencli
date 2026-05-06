# Hugging Face

**Mode**: 🌐 Public · **Domain**: `huggingface.co`

## Commands

| Command | Description |
|---------|-------------|
| `opencli hf top` | Top upvoted Hugging Face papers |
| `opencli hf models` | Top Hugging Face models (downloads / likes / trending / freshness) |
| `opencli hf datasets` | Top Hugging Face datasets |

## Usage Examples

```bash
# Today's top papers
opencli hf top --limit 10

# All papers (no limit)
opencli hf top --all

# Specific date
opencli hf top --date 2025-03-01

# Weekly/monthly top papers
opencli hf top --period weekly
opencli hf top --period monthly

# Top models by downloads (default)
opencli hf models --limit 20

# Top text-generation models with name filter
opencli hf models --pipeline text-generation --search llama --sort likes --limit 10

# Top datasets by likes
opencli hf datasets --sort likes --limit 10

# JSON output
opencli hf top -f json
```

### `top` Options

| Option | Description |
|--------|-------------|
| `--limit` | Number of papers (default: 20) |
| `--all` | Return all papers, ignoring limit |
| `--date` | Date in `YYYY-MM-DD` format (defaults to most recent) |
| `--period` | Time period: `daily`, `weekly`, or `monthly` (default: daily) |

### `models` Options

| Option | Description |
|--------|-------------|
| `--sort` | `downloads` / `likes` / `trending` / `created_at` / `last_modified` (default: `downloads`) |
| `--search` | Optional name/owner substring filter (e.g. `llama`, `mistralai/`) |
| `--pipeline` | Pipeline tag filter (e.g. `text-generation`, `image-classification`) |
| `--limit` | Max models (1–100, default: 20) |

### `datasets` Options

| Option | Description |
|--------|-------------|
| `--sort` | Same set as `models` (default: `downloads`) |
| `--search` | Optional name/owner substring filter |
| `--limit` | Max datasets (1–100, default: 20) |

## Prerequisites

- No browser required — uses public Hugging Face API
