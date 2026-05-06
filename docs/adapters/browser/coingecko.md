# CoinGecko

Access **CoinGecko** crypto market data from the terminal via the public API (no authentication required).

**Mode**: 🌐 Public · **Domain**: `api.coingecko.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli coingecko top` | Top coins by market cap |
| `opencli coingecko coin <id>` | Single coin's market detail (price / supply / ATH / homepage) |
| `opencli coingecko trending` | Top trending coins on CoinGecko in the last 24h |

## Usage Examples

```bash
# Top 10 coins in USD (default)
opencli coingecko top

# Top 5 coins priced in CNY
opencli coingecko top --currency cny --limit 5

# Top 50 coins in EUR
opencli coingecko top --currency eur --limit 50

# Single coin detail (slug from `top` or coingecko URL)
opencli coingecko coin bitcoin
opencli coingecko coin ethereum --currency cny

# Trending in the last 24h (search-volume based)
opencli coingecko trending

# JSON output
opencli coingecko top -f json
```

## Options

### `top`

| Option | Description |
|--------|-------------|
| `--currency` | Quote currency (`usd` / `cny` / `eur` / `jpy` / etc., default: `usd`) |
| `--limit` | Number of coins to return (1–250, default: 10) |

### `coin`

| Option | Description |
|--------|-------------|
| `id` (positional) | CoinGecko coin slug (lowercase, e.g. `bitcoin`, `ethereum`, `solana`) |
| `--currency` | Quote currency (default: `usd`) |

### `trending`

No arguments — returns the current top-7 trending list.

## Output Columns

| Command | Columns |
|---------|---------|
| `top` | `rank, symbol, name, price, change24hPct, marketCap, volume24h, high24h, low24h` |
| `coin` | `id, symbol, name, rank, price, marketCap, volume24h, change24hPct, change7dPct, change30dPct, ath, athDate, atl, atlDate, circulatingSupply, totalSupply, maxSupply, genesisDate, homepage` |
| `trending` | `rank, id, symbol, name, marketCapRank, priceBtc, thumb` |

## Prerequisites

- No browser required — uses CoinGecko's public market-data endpoint

## Notes

- The public endpoint is rate-limited; retry briefly if you hit transient `HTTP 429` responses
- All numeric values are denominated in the selected `--currency`; `coin` fails fast if CoinGecko returns no market fields for that currency
- `change24hPct` is a raw percent (e.g. `2.34` means `+2.34%`), not a fraction
- `--limit` is validated upfront and rejected with `ArgumentError` if non-positive or above 250 (the CoinGecko `per_page` upper bound) — no silent clamp
