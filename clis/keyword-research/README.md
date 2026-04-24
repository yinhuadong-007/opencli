# Keyword Research

`keyword-research` currently exposes a SERP-based keyword difficulty command:

```bash
opencli keyword-research serp_kd "AI for teacher"
```

## Usage

```bash
opencli keyword-research serp_kd "<keyword>" [--country US] [--lang en] [--limit 10]
```

Examples:

```bash
opencli keyword-research serp_kd "AI"
opencli keyword-research serp_kd "AI for teacher" -f json
opencli keyword-research serp_kd "best math app for teachers" --country US --lang en
```

## Arguments

- `query`: required target keyword
- `country`: optional Google market, default `US`
- `lang`: optional Google UI language, default `en`
- `limit`: optional natural-result count, default `10`
- `openpagerank_key`: optional OpenPageRank API key

You can also provide the OpenPageRank key globally:

```powershell
$env:OPENPAGERANK_API_KEY="your_key"
```

Compatible env vars:

- `OPEN_PAGE_RANK_API_KEY`
- `API_OPR`

## Output

Default table columns:

- `kd`
- `kd_level`
- `allintitle_count`
- `search_volume`
- `avg_opr_decimal`
- `ugc_count`
- `openpagerank_used`
- `why`

`json` / `yaml` output also includes:

- `search_volume_source`
- `kd_breakdown`
- `serp_results`
- `ugc_results`
- `kd_components`
- `source_url`
- `allintitle_url`

## Algorithm

This command estimates a `SERP KD`, not an Ahrefs-style backlink-database KD.

Current formula:

```text
kd = allintitle_kd + serp_authority_kd + ugc_relief
```

The final score is clamped into `0-100`.

Positive allocation:

- `allintitle_kd`: max `45`
- `serp_authority_kd`: max `55`
- `ugc_relief`: max reduction `-20`

The result also includes:

```text
kd_breakdown = "allintitle_kd=..., serp_authority_kd=..., ugc_relief=..."
```

This is a human-readable explanation of how the final `kd` was composed.

### 1. allintitle_kd

The command runs:

```text
allintitle:"<keyword>"
```

If search volume is available from Keyword Surfer, it uses:

```text
ratio = search_volume / max(allintitle_count, 1)
```

- `ratio >= 20` => `0`
- `ratio >= 10` => `12`
- `ratio >= 5` => `24`
- `ratio >= 2` => `34`
- otherwise => `45`

At the same time, `allintitle_count` still continues to score using the count gradient bands below. When both signals exist, the command keeps the higher of:

- the ratio-based score
- the count-based gradient score

If search volume is unavailable, it uses `allintitle_count` directly:

- `<= 50` => `0`
- `50-200` => base `0`, then add a proportional range score toward `9`
- `200-1000` => base `9`, then add a proportional range score toward `18`
- `1000-5000` => base `18`, then add a proportional range score toward `27`
- `5000-20000` => base `27`, then add a proportional range score toward `34`
- `20000-100000` => base `34`, then add a proportional range score toward `39`
- `100000-1000000` => base `39`, then add a proportional range score toward `42`
- `> 1000000` => `45`

In other words, the count branch uses:

```text
allintitle_kd = gradient base score + proportional score within the current count band
```

When search volume exists, the final `allintitle_kd` is:

```text
max(ratio_score, count_gradient_score)
```

There is also a minimum floor: if `allintitle_count > 100`, then `allintitle_kd` will be at least `10`, even when the search-volume ratio would otherwise push it lower.

### 2. serp_authority_kd

Authority is driven by `OpenPageRank`.

For each page-one result, the command reads `opr_page_rank_decimal` and computes a weighted average using descending rank weights:

```text
weights = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
avg_opr_decimal = sum(opr_page_rank_decimal * weight) / sum(weight)
```

Higher-ranked results contribute more than lower-ranked ones.

The weighted average is then mapped to `serp_authority_kd` using gradient bands:

- `< 2.0` => `5`
- `>= 2.0 and < 3.0` => base `14`, then add a proportional range score toward `24`
- `>= 3.0 and < 4.0` => base `24`, then add a proportional range score toward `35`
- `>= 4.0 and < 5.0` => base `35`, then add a proportional range score toward `44`
- `>= 5.0 and < 6.0` => base `44`, then add a proportional range score toward `55`
- `>= 6.0` => `55`

In other words, `serp_authority_kd = gradient base score + proportional score within the current band`, so scores rise smoothly inside each OPR range instead of jumping only at the boundaries.

### 3. ugc_relief

UGC and community results lower the effective difficulty:

- `ugc_count >= 3` => `-20`
- `ugc_count == 2` => `-14`
- `ugc_count == 1` => `-8`
- `ugc_count == 0` => `0`

## KD Levels

- `0-19` => `very_easy`
- `20-39` => `easy`
- `40-59` => `medium`
- `60-79` => `hard`
- `80-100` => `very_hard`

## Data Sources

Priority order:

1. `OpenPageRank` for authority
2. `Keyword Surfer` for search volume when present on the SERP page

MozBar is not used by this command.

## Difference From Ahrefs KD

Ahrefs KD is much closer to a backlink-competition score built from:

- page-level backlinks
- referring domains
- large-scale link graph data

This command is a lighter-weight SERP proxy focused on:

- exact-title competition
- weighted authority strength on page one
- UGC presence

So it can correlate with Ahrefs KD, but it should not be treated as the same metric.

## Interpretation Tips

- `very_easy` / `easy`: usually lower title competition, lower weighted page-one authority, or obvious UGC gaps
- `medium`: some real competition, but still workable with sharper content and positioning
- `hard` / `very_hard`: high weighted authority on page one or very high allintitle pressure
