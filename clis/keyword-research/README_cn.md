# Keyword Research

`keyword-research` 当前提供一个基于 SERP 的关键词难度命令：

```bash
opencli keyword-research serp_kd "AI for teacher"
```

## 用法

```bash
opencli keyword-research serp_kd "<keyword>" [--country US] [--lang en] [--limit 10]
```

示例：

```bash
opencli keyword-research serp_kd "AI"
opencli keyword-research serp_kd "AI for teacher" -f json
opencli keyword-research serp_kd "best math app for teachers" --country US --lang en
```

## 参数

- `query`：必填，目标关键词
- `country`：可选，Google 市场，默认 `US`
- `lang`：可选，Google 界面语言，默认 `en`
- `limit`：可选，自然结果数量，默认 `10`
- `openpagerank_key`：可选，OpenPageRank API key

你也可以通过全局环境变量提供 OpenPageRank key：

```powershell
$env:OPENPAGERANK_API_KEY="your_key"
```

兼容的环境变量：

- `OPEN_PAGE_RANK_API_KEY`
- `API_OPR`

## 输出

默认表格列：

- `kd`
- `kd_level`
- `allintitle_count`
- `search_volume`
- `avg_opr_decimal`
- `ugc_count`
- `openpagerank_used`
- `why`

`json` / `yaml` 还会额外输出：

- `search_volume_source`
- `kd_breakdown`
- `serp_results`
- `ugc_results`
- `kd_components`
- `source_url`
- `allintitle_url`

## 算法

这个命令计算的是一套 `SERP KD`，不是 Ahrefs 那种基于大型外链数据库的官方 KD。

当前公式：

```text
kd = allintitle_kd + serp_authority_kd + ugc_relief
```

最终分数会被限制在 `0-100`。

正向分值分配：

- `allintitle_kd`：最大 `45`
- `serp_authority_kd`：最大 `55`
- `ugc_relief`：最大减分 `-20`

结果里还包含：

```text
kd_breakdown = "allintitle_kd=..., serp_authority_kd=..., ugc_relief=..."
```

这个字段会用更直观的方式说明最终 `kd` 是由哪三部分组成的。

### 1. allintitle_kd

命令会搜索：

```text
allintitle:"<keyword>"
```

如果 Keyword Surfer 提供了搜索量，则使用：

```text
ratio = search_volume / max(allintitle_count, 1)
```

- `ratio >= 20` => `0`
- `ratio >= 10` => `12`
- `ratio >= 5` => `24`
- `ratio >= 2` => `34`
- 其他情况 => `45`

同时，`allintitle_count` 仍然会继续按照下面的 count 梯度规则计分。当两种信号都存在时，命令会取下面两者中的较大值：

- 基于 `ratio` 的分数
- 基于 `allintitle_count` 梯度区间的分数

如果没有搜索量，则直接按 `allintitle_count` 计算：

- `<= 50` => `0`
- `50-200` => 基础分 `0`，再加上区间内的比例分，逐步接近 `9`
- `200-1000` => 基础分 `9`，再加上区间内的比例分，逐步接近 `18`
- `1000-5000` => 基础分 `18`，再加上区间内的比例分，逐步接近 `27`
- `5000-20000` => 基础分 `27`，再加上区间内的比例分，逐步接近 `34`
- `20000-100000` => 基础分 `34`，再加上区间内的比例分，逐步接近 `39`
- `100000-1000000` => 基础分 `39`，再加上区间内的比例分，逐步接近 `42`
- `> 1000000` => `45`

也就是说，count 分支本身使用的是：

```text
allintitle_kd = 梯度基础分 + 当前 count 区间内的比例分
```

如果存在搜索量，则最终的 `allintitle_kd` 是：

```text
max(ratio_score, count_gradient_score)
```

另外还有一个最低保底规则：只要 `allintitle_count > 100`，那么 `allintitle_kd` 至少会是 `10`，即使搜索量比例本来会把它压得更低。

### 2. serp_authority_kd

Authority 由 `OpenPageRank` 驱动。

对于 Google 首页的每一个自然结果，命令会读取 `opr_page_rank_decimal`，并按排名递减权重计算加权平均值：

```text
weights = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
avg_opr_decimal = sum(opr_page_rank_decimal * weight) / sum(weight)
```

排名越靠前，权重越高。

然后把加权平均值映射为 `serp_authority_kd`：

- `< 2.0` => `5`
- `>= 2.0 and < 3.0` => 基础分 `14`，再加上区间内的比例分，逐步接近 `24`
- `>= 3.0 and < 4.0` => 基础分 `24`，再加上区间内的比例分，逐步接近 `35`
- `>= 4.0 and < 5.0` => 基础分 `35`，再加上区间内的比例分，逐步接近 `44`
- `>= 5.0 and < 6.0` => 基础分 `44`，再加上区间内的比例分，逐步接近 `55`
- `>= 6.0` => `55`

也就是说：

```text
serp_authority_kd = 梯度基础分 + 当前 OPR 区间内的比例分
```

这样分数会在每个 OPR 区间内部平滑上升，而不是只在边界上突然跳变。

### 3. ugc_relief

如果首页出现较多 UGC / 社区类结果，会降低实际难度：

- `ugc_count >= 3` => `-20`
- `ugc_count == 2` => `-14`
- `ugc_count == 1` => `-8`
- `ugc_count == 0` => `0`

## KD 等级

- `0-19` => `very_easy`
- `20-39` => `easy`
- `40-59` => `medium`
- `60-79` => `hard`
- `80-100` => `very_hard`

## 数据来源

优先级：

1. `OpenPageRank` 用于 authority
2. `Keyword Surfer` 用于搜索量（如果当前 SERP 页面上可读取）

这个命令不再使用 MozBar。

## 与 Ahrefs KD 的区别

Ahrefs KD 更接近一套“外链竞争分”，通常依赖：

- 页面级 backlinks
- referring domains
- 大规模链接图数据

而这个命令是一套更轻量的 SERP 代理分，重点看的是：

- 标题精确竞争
- 首页加权 authority 强度
- UGC 结果占比

所以它可能和 Ahrefs KD 有相关性，但不能把两者当成同一个指标。

## 解读建议

- `very_easy` / `easy`：通常表示标题竞争较低、首页加权 authority 较低，或者存在明显的 UGC 缺口
- `medium`：说明已经有一定竞争，但仍然可能通过更好的内容与定位切入
- `hard` / `very_hard`：说明首页 authority 很强，或 `allintitle` 压力很高
