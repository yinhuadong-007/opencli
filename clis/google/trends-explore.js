/**
 * Google Trends Explore (interest over time + related queries).
 *
 * Uses public Trends API endpoints (XSSI-prefixed JSON):
 * - /trends/api/explore -> widgets with request + token
 * - /trends/api/widgetdata/multiline -> time series
 * - /trends/api/widgetdata/relatedsearches -> related queries
 *
 * This is significantly more stable than scraping the Explore DOM.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRENDS_EXPLORE_MIN_CALL_INTERVAL_MS = 30_000;
const TRENDS_EXPLORE_RATE_FILE = path.join(
  os.homedir(),
  '.opencli',
  'cache',
  'google',
  'trends-explore-last-call.json',
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLastCallTimestamp() {
  try {
    const raw = fs.readFileSync(TRENDS_EXPLORE_RATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.startedAt || 0);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

function writeLastCallTimestamp(ts) {
  try {
    fs.mkdirSync(path.dirname(TRENDS_EXPLORE_RATE_FILE), { recursive: true });
    fs.writeFileSync(
      TRENDS_EXPLORE_RATE_FILE,
      JSON.stringify({ startedAt: ts }, null, 2),
      'utf-8',
    );
  } catch {
    // Best effort only. Rate limiter must not break command execution.
  }
}

async function enforceStartInterval(vlog) {
  const now = Date.now();
  const lastStartedAt = readLastCallTimestamp();
  const elapsed = now - lastStartedAt;
  if (lastStartedAt > 0 && elapsed < TRENDS_EXPLORE_MIN_CALL_INTERVAL_MS) {
    const waitMs = TRENDS_EXPLORE_MIN_CALL_INTERVAL_MS - elapsed;
    vlog(`rate-guard: last_call=${lastStartedAt}, waiting=${waitMs}ms`);
    await sleep(waitMs);
  }
  const startedAt = Date.now();
  writeLastCallTimestamp(startedAt);
  vlog(`rate-guard: current_call_started=${startedAt}`);
}

function parseRelatedRanks(data) {
  const ranked = data?.default?.rankedList;
  const list = Array.isArray(ranked) ? ranked : [];
  const pickText = (keyword) => {
    const query = keyword?.query;
    if (typeof query === 'string' && query.trim() !== '') return query;
    const topicTitle = keyword?.topic?.title;
    return typeof topicTitle === 'string' ? topicTitle : '';
  };
  const pickDetail = (keyword) => ({
    query: (() => {
      if (typeof keyword?.query === 'string' && keyword.query.trim() !== '') return keyword.query;
      if (typeof keyword?.topic?.title === 'string') return keyword.topic.title;
      return '';
    })(),
    value: typeof keyword?.value === 'number' ? keyword.value : null,
    formattedValue: typeof keyword?.formattedValue === 'string' ? keyword.formattedValue : '',
  });
  const topKeywords = list[0]?.rankedKeyword || [];
  const risingKeywords = list[1]?.rankedKeyword || [];
  const top = topKeywords.map(pickText).filter(Boolean);
  const rising = risingKeywords.map(pickText).filter(Boolean);
  const topDetails = topKeywords.map(pickDetail).filter((keyword) => Boolean(keyword.query));
  const risingDetails = risingKeywords.map(pickDetail).filter((keyword) => Boolean(keyword.query));
  return { top, rising, topDetails, risingDetails };
}

function isLegacyQueryRelatedEmpty(data) {
  const rankedList = data?.default?.rankedList;
  if (!Array.isArray(rankedList) || rankedList.length < 2) return false;
  const top = Array.isArray(rankedList[0]?.rankedKeyword) ? rankedList[0].rankedKeyword : null;
  const rising = Array.isArray(rankedList[1]?.rankedKeyword) ? rankedList[1].rankedKeyword : null;
  if (!top || !rising) return false;
  return top.length === 0 && rising.length === 0;
}

function getLegacyRankedListLength(data) {
  const rankedList = data?.default?.rankedList;
  return Array.isArray(rankedList) ? rankedList.length : 0;
}

function getLegacyRelatedKeywordTypeFromUrl(url) {
  const input = String(url || '');
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Keep original when decode fails.
  }
  if (decoded.includes('"keywordType":"QUERY"')) return 'QUERY';
  if (decoded.includes('"keywordType":"ENTITY"')) return 'ENTITY';
  return 'UNKNOWN';
}

function stripXssiPrefix(text) {
  return String(text || '').replace(/^\)\]\}',?\s*\n/, '');
}

function parseXssiJson(text) {
  const cleaned = stripXssiPrefix(text).trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function parseChunkedBatchexecute(rawBody) {
  const cleaned = stripXssiPrefix(rawBody).trim();
  if (!cleaned) return [];
  const lines = cleaned.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) {
      const nextLine = lines[i + 1];
      if (!nextLine) continue;
      try {
        chunks.push(JSON.parse(nextLine));
      } catch {
        // Keep scanning.
      }
      i += 1;
      continue;
    }
    if (line.startsWith('[')) {
      try {
        chunks.push(JSON.parse(line));
      } catch {
        // Keep scanning.
      }
    }
  }
  return chunks;
}

function extractRpcPayloads(rawBody, rpcId) {
  const chunks = parseChunkedBatchexecute(rawBody);
  const out = [];
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];
    for (const item of items) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr' || item[1] !== rpcId) continue;
      let payload = item[2];
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          // Keep raw payload string if it is not JSON.
        }
      }
      out.push(payload);
    }
  }
  return out;
}

function findFirst(node, predicate) {
  const queue = [node];
  while (queue.length) {
    const cur = queue.shift();
    if (predicate(cur)) return cur;
    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
    } else if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur)) queue.push(v);
    }
  }
  return null;
}

function findAll(node, predicate, maxCount = 50) {
  const out = [];
  const queue = [node];
  while (queue.length && out.length < maxCount) {
    const cur = queue.shift();
    if (predicate(cur)) out.push(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
    } else if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur)) queue.push(v);
    }
  }
  return out;
}

function toNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractTimelineFromPayload(payload) {
  // Newer g4kJzf payload shape example:
  // [[
  //   ["queryA", null, null, score, [[float, intValue, [[startTs],[endTs]], ...], ...]],
  //   ["queryB", null, null, score, [[...], ...]]
  // ]]
  // Parse all query blocks so multi-keyword explore can return values per term.
  const agentBlocks = findFirst(
    payload,
    (node) =>
      Array.isArray(node) &&
      node.length > 0 &&
      node.every(
        (item) =>
          Array.isArray(item) &&
          typeof item[0] === 'string' &&
          Array.isArray(item[4]),
      ),
  );
  if (Array.isArray(agentBlocks) && agentBlocks.length > 0) {
    let labels = [];
    const series = [];
    for (const block of agentBlocks) {
      const points = Array.isArray(block[4]) ? block[4] : [];
      if (points.length === 0) continue;
      const values = points
        .map((row) => (Array.isArray(row) ? toNumeric(row[1]) : null))
        .filter((value) => value !== null);
      if (values.length === 0) continue;
      if (labels.length === 0) {
        labels = points.map((row, index) => {
          const ts = toNumeric(row?.[2]?.[0]?.[0]);
          if (ts === null) return String(index + 1);
          try {
            return new Date(ts * 1000).toISOString().slice(0, 10);
          } catch {
            return String(index + 1);
          }
        });
      }
      series.push(values);
    }
    if (labels.length > 0 && series.length > 0) return { labels, series };
  }

  const fromDefaultTimelineData = findFirst(
    payload,
    (node) =>
      node &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      Array.isArray(node?.default?.timelineData),
  );

  let timeline = fromDefaultTimelineData?.default?.timelineData || null;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    const candidates = findAll(
      payload,
      (node) => Array.isArray(node) && node.length > 0,
      200,
    );
    let best = null;
    let bestScore = -1;
    for (const arr of candidates) {
      let score = 0;
      for (const item of arr) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        if (Array.isArray(item.value)) score += 3;
        if (item.formattedTime || item.formattedAxisTime || item.time) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = arr;
      }
    }
    timeline = best;
  }

  if (!Array.isArray(timeline) || timeline.length === 0) return { labels: [], series: [] };

  const labels = timeline
    .map((point) => point.formattedTime || point.formattedAxisTime || point.time || '')
    .map((value) => String(value))
    .filter((value) => value.length > 0);

  const firstValues = Array.isArray(timeline[0]?.value) ? timeline[0].value : [];
  const seriesCount = firstValues.length;
  const series = [];
  for (let index = 0; index < seriesCount; index += 1) {
    const values = timeline
      .map((point) => (Array.isArray(point.value) ? toNumeric(point.value[index]) : null))
      .filter((value) => value !== null);
    series.push(values);
  }
  return { labels, series };
}

function extractRelatedFromPayload(payload) {
  let normalized = payload;
  for (let i = 0; i < 2; i += 1) {
    if (typeof normalized !== 'string') break;
    try {
      normalized = JSON.parse(normalized);
    } catch {
      break;
    }
  }

  const isRowList = (rows) =>
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every((row) => Array.isArray(row) && typeof row[0] === 'string');

  // fXqlme payload shapes seen in the wild:
  // 1) [["agent", [rows...], [rows...]]]
  // 2) [["<query>", [rows...], [rows...]]]
  // We only care that [1] and [2] are row lists.
  const relatedContainer = findFirst(
    normalized,
    (node) =>
      Array.isArray(node) &&
      node.length >= 3 &&
      typeof node[0] === 'string' &&
      isRowList(node[1]) &&
      isRowList(node[2]),
  );
  if (Array.isArray(relatedContainer) && relatedContainer.length >= 3) {
    const risingRows = Array.isArray(relatedContainer[1]) ? relatedContainer[1] : [];
    const topRows = Array.isArray(relatedContainer[2]) ? relatedContainer[2] : [];
    const toQuery = (row) => String(row?.[0] || '').trim();
    const toValue = (row) => {
      const n = toNumeric(row?.[1]);
      return n === null ? null : n;
    };
    const toDelta = (row) => {
      const n = toNumeric(row?.[2]);
      return n === null ? null : n;
    };
    const toDetail = (row) => {
      const query = toQuery(row);
      return {
        query,
        value: toValue(row),
        delta: toDelta(row),
        formattedValue: toValue(row) === null ? '' : String(toValue(row)),
      };
    };
    const risingDetails = risingRows.map(toDetail).filter((item) => Boolean(item.query));
    const topDetails = topRows.map(toDetail).filter((item) => Boolean(item.query));
    return {
      top: topDetails.map((item) => item.query),
      rising: risingDetails.map((item) => item.query),
      topDetails,
      risingDetails,
    };
  }

  const rankedList = findFirst(
    normalized,
    (node) =>
      Array.isArray(node) &&
      node.length > 0 &&
      node.every((item) => item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.rankedKeyword)),
  );
  if (!Array.isArray(rankedList)) return { top: [], rising: [], topDetails: [], risingDetails: [] };
  return parseRelatedRanks({ default: { rankedList } });
}

function normalizeCaptureEntry(entry) {
  const url = String(entry?.url || '');
  const status = Number(entry?.responseStatus || 0);
  const responsePreview = typeof entry?.responsePreview === 'string' ? entry.responsePreview : '';
  const timestamp = Number(entry?.timestamp || 0);
  return { url, status, responsePreview, timestamp };
}

function hashString(input) {
  let h = 2166136261;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function payloadDedupeKey(rpcId, payload) {
  let serialized = '';
  if (typeof payload === 'string') {
    serialized = payload;
  } else {
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = String(payload);
    }
  }
  return `${rpcId}:${hashString(serialized)}`;
}

function summarizePayloadShape(payload) {
  if (Array.isArray(payload)) return `array(len=${payload.length})`;
  if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload).slice(0, 10);
    return `object(keys=${keys.join(',')})`;
  }
  return typeof payload;
}

function normalizeGeo(rawGeo) {
  const geo = String(rawGeo ?? '').trim();
  if (!geo) return '';
  if (/^worldwide$/i.test(geo) || /^global$/i.test(geo)) return '';
  return geo;
}

function parseQueries(rawQuery) {
  const input = String(rawQuery || '').trim();
  if (!input) return [];
  // Default: treat the whole string as a single query, even if it contains commas.
  // Multi-query mode: explicit bracket list syntax, e.g. "[a1],[a2]".
  const bracketPairPattern = /^\s*\[[\s\S]*\]\s*(,\s*\[[\s\S]*\]\s*)*$/;
  if (!bracketPairPattern.test(input)) {
    return [input];
  }

  const matches = [...input.matchAll(/\[([\s\S]*?)\]/g)];
  const queries = matches
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
  return queries.length > 0 ? queries : [input];
}

function encodeExploreQueryParam(queries) {
  // Google Explore treats commas in q as multi-term delimiters.
  // To preserve literal commas inside one term, pre-encode each term first.
  // Example: "hello, world" -> "hello%2C%20world" (later whole q is encoded again -> %252C).
  return queries.map((query) => encodeURIComponent(String(query))).join(', ');
}

async function simulateHumanScroll(page) {
  const script = `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randInt = (min, max) => {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    };
    const root = document.scrollingElement || document.documentElement || document.body;
    const beforeY = Number(window.scrollY || root.scrollTop || 0);
    const viewport = Math.max(600, Number(window.innerHeight || 900));

    // Trends often uses nested lazy sections; drive both the document and nested
    // scroll containers to the bottom so lazy sections reliably request data.
    const containers = Array.from(document.querySelectorAll('div, section, main'))
      .filter((el) => {
        try {
          const st = window.getComputedStyle(el);
          const scrollable = /(auto|scroll)/.test(st.overflowY || '');
          return scrollable && el.scrollHeight > el.clientHeight + 80;
        } catch {
          return false;
        }
      });

    const orderedContainers = containers
      .map((el) => ({ el, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map((item) => item.el);

    let iterations = 0;
    let lastHeight = 0;
    let stableHeightCount = 0;
    for (; iterations < 18; iterations += 1) {
      const docHeight = Math.max(
        root?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
      );
      const currentY = Number(window.scrollY || root.scrollTop || 0);
      const maxY = Math.max(0, docHeight - viewport);
      if (docHeight === lastHeight) stableHeightCount += 1;
      else stableHeightCount = 0;
      lastHeight = docHeight;

      if (currentY >= maxY - 8 && stableHeightCount >= 2) break;

      const step = Math.max(240, Math.floor(viewport * (0.24 + Math.random() * 0.16)) + randInt(-40, 60));
      const nextY = Math.min(maxY, currentY + step);
      try { window.scrollTo(0, nextY); } catch {}
      try { root.scrollTop = nextY; } catch {}

      for (const el of orderedContainers) {
        try {
          if (el.scrollHeight > el.clientHeight + 8) {
            const localStep = Math.max(120, Math.floor((el.clientHeight || 700) * 0.28));
            el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + localStep);
          }
        } catch {}
      }
      await sleep(randInt(260, 520));
    }

    const finalHeight = Math.max(
      root?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
    const finalY = Math.max(0, finalHeight - viewport);
    try { window.scrollTo(0, finalY); } catch {}
    try { root.scrollTop = finalY; } catch {}
    for (const el of orderedContainers) {
      try { el.scrollTop = el.scrollHeight; } catch {}
    }

    await sleep(randInt(900, 1400));

    let rollBackIterations = 0;
    const middleY = Math.max(0, Math.floor(finalY / 2));
    for (; rollBackIterations < 180; rollBackIterations += 1) {
      const currentY = Number(window.scrollY || root.scrollTop || 0);
      if (currentY <= middleY) break;
      const rollbackStep = randInt(35, 80);
      const nextY = Math.max(middleY, currentY - rollbackStep);
      try { window.scrollTo(0, nextY); } catch {}
      try { root.scrollTop = nextY; } catch {}

      for (const el of orderedContainers) {
        try {
          if (el.scrollTop > 0) {
            const elMiddle = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) / 2));
            el.scrollTop = Math.max(elMiddle, el.scrollTop - randInt(25, 65));
          }
        } catch {}
      }
      await sleep(randInt(220, 420));
    }

    try { window.scrollTo(0, middleY); } catch {}
    try { root.scrollTop = middleY; } catch {}
    for (const el of orderedContainers) {
      try { el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) / 2)); } catch {}
    }

    const afterY = Number(window.scrollY || root.scrollTop || 0);
    const scrollHeight = Math.max(
      root?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
    const reachedBottom = finalY + viewport >= finalHeight - 12;
    const nearMiddle = Math.abs(afterY - middleY) <= 12;
    return {
      beforeY,
      afterY,
      moved: afterY - beforeY,
      viewport,
      scrollHeight,
      reachedBottom,
      nearMiddle,
      middleY,
      iterations,
      rollBackIterations,
      containerCandidates: containers.length,
      containerTouched: orderedContainers.length,
    };
  })()`;
  return page.evaluate(script);
}

cli({
  site: 'google',
  name: 'trends-explore',
  description: 'Google Trends Explore: interest over time + related queries for a search term',
  domain: 'trends.google.com',
  strategy: Strategy.UI,
  access: 'read',
  browser: true,
  args: [
    {
      name: 'query',
      positional: true,
      type: 'string',
      required: true,
      help: 'Search query. A plain string is treated as ONE term (e.g. "hello, world"). For multiple terms, use bracket list syntax: "[a1],[a2]".',
    },
    { name: 'geo', type: 'string', default: 'US', help: 'Country/region code (e.g. US, CN, GB) or Worldwide' },
    {
      name: 'date',
      type: 'string',
      default: 'now 7-d',
      help: 'Time range: now 7-d, today 1-m, today 3-m, today 12-m, today 5-y, or absolute range "YYYY-MM-DD YYYY-MM-DD"',
    },
    {
      name: 'details',
      type: 'boolean',
      required: false,
      default: false,
      help: 'Include top_details and rising_details in trend_json (default: false)',
    },
    {
      name: 'force_legacy',
      type: 'boolean',
      required: false,
      default: false,
      help: 'Force legacy fallback mode for testing (/trends/api/widgetdata/* capture)',
    },
    {
      name: 'legacy_fallback',
      type: 'boolean',
      required: false,
      default: true,
      help: 'When modern capture has no timeline, fallback to legacy widgetdata (default: true)',
    },
    { name: 'hl', type: 'string', default: 'en-US', help: 'UI language (e.g. en-US, zh-CN)' },
    { name: 'tz', type: 'int', default: -480, help: 'Timezone offset minutes (e.g. -480 for PT)' },
  ],
  columns: ['query', 'geo', 'date_range', 'trend_json'],
  func: async (page, kwargs, debug = false) => {
    const verbose = Boolean(debug || process.env.OPENCLI_VERBOSE);
    const vlog = (message) => {
      if (!verbose) return;
      process.stderr.write(`[google/trends-explore] ${message}\n`);
    };
    await enforceStartInterval(vlog);

    const rawQuery = String(kwargs.query || '').trim();
    const queries = parseQueries(rawQuery);
    const geo = normalizeGeo(kwargs.geo);
    const date = String(kwargs.date || 'now 7-d').trim();
    const includeRelatedDetails = Boolean(kwargs.details ?? false);
    const forceLegacy = Boolean(kwargs.force_legacy ?? kwargs['force-legacy'] ?? false);
    const legacyFallbackEnabled = Boolean(kwargs.legacy_fallback ?? kwargs['legacy-fallback'] ?? true);
    const hl = String(kwargs.hl || 'en-US').trim() || 'en-US';
    const tz = Number(kwargs.tz ?? -480);

    if (!queries.length) {
      throw new CliError(
        'INVALID_ARGS',
        '`query` is required',
        'Provide one or more search terms, e.g. opencli google trends-explore "ai,opencli,openclaw"',
      );
    }
    if (!Number.isFinite(tz)) {
      throw new CliError('INVALID_ARGS', '`tz` must be a number (minutes offset)', 'Example: --tz -480');
    }

    const qParam = encodeExploreQueryParam(queries);
    const explorePageUrl =
      `https://trends.google.com/explore?` +
      `geo=${encodeURIComponent(geo)}` +
      `&q=${encodeURIComponent(qParam)}` +
      `&date=${encodeURIComponent(date)}` +
      `&hl=${encodeURIComponent(hl)}`;
    const legacyExplorePageUrl =
      `https://trends.google.com/trends/explore?` +
      `geo=${encodeURIComponent(geo)}` +
      `&q=${encodeURIComponent(qParam)}` +
      `&date=${encodeURIComponent(date)}` +
      `&legacy&hl=${encodeURIComponent(hl)}`;

    const needRelated = includeRelatedDetails;
    let labels = [];
    let series = [];
    let related = { top: [], rising: [], topDetails: [], risingDetails: [] };
    const seenPayloads = new Set();
    let saw429 = false;
    const phaseStats = {
      modern: { batches: 0, g4kJzf: 0, fXqlme: 0, loops: 0 },
      legacy: { multiline: 0, relatedsearches: 0, loops: 0 },
    };

    const runModernPhase = async (timeoutMs) => {
      let deadlineMs = Date.now() + timeoutMs;
      let scrolledOnce = false;

      while (Date.now() < deadlineMs) {
        phaseStats.modern.loops += 1;
        const rawEntries = await page.readNetworkCapture?.().catch(() => []) || [];
        const entries = Array.isArray(rawEntries) ? rawEntries.map(normalizeCaptureEntry) : [];

        if (entries.length > 0) {
          vlog(`phase=modern poll#${phaseStats.modern.loops}: entries=${entries.length}`);
        }

        for (const entry of entries) {
          if (!entry.url.includes('/_/TrendsUi/data/batchexecute')) continue;
          phaseStats.modern.batches += 1;
          vlog(`phase=modern capture: status=${entry.status} url=${entry.url}`);
          if (entry.status === 429) {
            saw429 = true;
            vlog('phase=modern capture: saw HTTP 429');
            continue;
          }
          if (entry.status < 200 || entry.status >= 300) continue;
          if (!entry.responsePreview) continue;

          const timelinePayloads = extractRpcPayloads(entry.responsePreview, 'g4kJzf');
          if (timelinePayloads.length > 0) {
            phaseStats.modern.g4kJzf += timelinePayloads.length;
            vlog(`phase=modern g4kJzf payloads=${timelinePayloads.length}`);
          }
          for (const payload of timelinePayloads) {
            const key = payloadDedupeKey('g4kJzf', payload);
            if (seenPayloads.has(key)) continue;
            seenPayloads.add(key);
            vlog(`timeline payload shape=${summarizePayloadShape(payload)}`);
            const extracted = extractTimelineFromPayload(payload);
            if ((extracted.labels?.length || 0) > 0 && (extracted.series?.length || 0) > 0) {
              labels = extracted.labels;
              series = extracted.series;
              vlog(`timeline parsed: labels=${labels.length}, series=${series.length}`);
            }
          }

          if (needRelated) {
            const relatedPayloads = extractRpcPayloads(entry.responsePreview, 'fXqlme');
            if (relatedPayloads.length > 0) {
              phaseStats.modern.fXqlme += relatedPayloads.length;
              vlog(`phase=modern fXqlme payloads=${relatedPayloads.length}`);
            }
            for (const payload of relatedPayloads) {
              const key = payloadDedupeKey('fXqlme', payload);
              if (seenPayloads.has(key)) continue;
              seenPayloads.add(key);
              vlog(`related payload shape=${summarizePayloadShape(payload)}`);
              const extractedRelated = extractRelatedFromPayload(payload);
              if ((extractedRelated.topDetails.length + extractedRelated.risingDetails.length) > 0) {
                related = extractedRelated;
                vlog(`related parsed: top=${related.top.length}, rising=${related.rising.length}, topDetails=${related.topDetails.length}, risingDetails=${related.risingDetails.length}`);
              }
            }
          }
        }

        const hasTimeline = labels.length > 0 && series.length > 0;
        const hasRelated = !needRelated || related.topDetails.length > 0 || related.risingDetails.length > 0;
        if (hasTimeline && hasRelated) {
          vlog(`phase=modern ready: hasTimeline=${hasTimeline}, hasRelated=${hasRelated}`);
          return;
        }

        // Always simulate one human-like scroll to trigger lazy sections and stabilize capture behavior.
        if (!scrolledOnce && phaseStats.modern.loops >= 4) {
          try {
            const remainingBeforeResetMs = Math.max(0, deadlineMs - Date.now());
            const pass1 = await simulateHumanScroll(page);
            await page.wait(0.7);
            const pass2 = await simulateHumanScroll(page);
            await page.wait(0.7);
            scrolledOnce = true;
            deadlineMs = Date.now() + timeoutMs;
            vlog(`phase=modern simulated human scroll: pass1=${JSON.stringify(pass1)} pass2=${JSON.stringify(pass2)}`);
            vlog(`phase=modern deadline reset after scroll: remaining_before_ms=${remainingBeforeResetMs} new_deadline_ts=${deadlineMs}`);
          } catch {
            // Best effort only.
          }
        }

        if (saw429) return;
        await page.wait(0.5);
      }
    };

    const runLegacyPhase = async (timeoutMs) => {
      const captureEnabledLegacy = await page.startNetworkCapture?.('trends/api/widgetdata').catch(() => false);
      if (!captureEnabledLegacy) {
        throw new CliError(
          'UNSUPPORTED',
          'Network capture is unavailable for legacy widgetdata fallback',
          'Enable browser network capture support in your OpenCLI runtime and retry.',
        );
      }
      vlog('network capture switched to legacy widgetdata pattern');
      await page.goto(legacyExplorePageUrl, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(1);
      vlog(`navigated to legacy explore page: ${legacyExplorePageUrl}`);

      let deadlineMs = Date.now() + timeoutMs;
      let scrolledOnce = false;
      let relatedSettled = !needRelated;
      while (Date.now() < deadlineMs) {
        phaseStats.legacy.loops += 1;
        const rawEntries = await page.readNetworkCapture?.().catch(() => []) || [];
        const entries = Array.isArray(rawEntries) ? rawEntries.map(normalizeCaptureEntry) : [];
        if (entries.length > 0) {
          vlog(`phase=legacy poll#${phaseStats.legacy.loops}: entries=${entries.length}`);
        }

        for (const entry of entries) {
          if (entry.url.includes('/trends/api/widgetdata/')) {
            vlog(`phase=legacy capture: status=${entry.status} url=${entry.url}`);
          }
          if (entry.status < 200 || entry.status >= 300) continue;
          if (!entry.responsePreview) continue;
          if (entry.status === 429) {
            saw429 = true;
            continue;
          }

          if (entry.url.includes('/trends/api/widgetdata/multiline')) {
            phaseStats.legacy.multiline += 1;
            const parsed = parseXssiJson(entry.responsePreview);
            if (parsed) {
              const extracted = extractTimelineFromPayload(parsed);
              if ((extracted.labels?.length || 0) > 0 && (extracted.series?.length || 0) > 0) {
                labels = extracted.labels;
                series = extracted.series;
                vlog(`phase=legacy multiline parsed: labels=${labels.length}, series=${series.length}`);
              }
            }
          }

          if (needRelated && entry.url.includes('/trends/api/widgetdata/relatedsearches')) {
            phaseStats.legacy.relatedsearches += 1;
            const parsed = parseXssiJson(entry.responsePreview);
            const keywordType = getLegacyRelatedKeywordTypeFromUrl(entry.url);
            if (keywordType !== 'QUERY') {
              vlog(`phase=legacy related ignored: keywordType=${keywordType} (expect QUERY)`);
              continue;
            }
            const rankedListLen = getLegacyRankedListLength(parsed || {});
            if (rankedListLen < 2) {
              vlog(`phase=legacy related ignored: rankedList length=${rankedListLen} (<2)`);
            } else {
              if (isLegacyQueryRelatedEmpty(parsed || {})) {
                related = { top: [], rising: [], topDetails: [], risingDetails: [] };
                relatedSettled = true;
                vlog('phase=legacy related parsed: empty rankedKeyword accepted as target');
              } else {
                const extractedRelated = parseRelatedRanks(parsed || {});
                if ((extractedRelated.topDetails.length + extractedRelated.risingDetails.length) > 0) {
                  related = extractedRelated;
                  relatedSettled = true;
                  vlog(`phase=legacy related parsed: top=${related.top.length}, rising=${related.rising.length}, topDetails=${related.topDetails.length}, risingDetails=${related.risingDetails.length}`);
                } else {
                  vlog('phase=legacy related parsed with rankedList>=2 but no usable rows; waiting for next response');
                }
              }
            }
          }
        }

        const hasTimeline = labels.length > 0 && series.length > 0;
        const hasRelated = !needRelated || relatedSettled;
        if (hasTimeline && hasRelated) return;

        // Always simulate one human-like scroll to trigger lazy sections and refresh behavior.
        if (!scrolledOnce && phaseStats.legacy.loops >= 3) {
          try {
            const remainingBeforeResetMs = Math.max(0, deadlineMs - Date.now());
            const pass1 = await simulateHumanScroll(page);
            await page.wait(0.7);
            const pass2 = await simulateHumanScroll(page);
            await page.wait(0.7);
            scrolledOnce = true;
            deadlineMs = Date.now() + timeoutMs;
            vlog(`phase=legacy simulated human scroll: pass1=${JSON.stringify(pass1)} pass2=${JSON.stringify(pass2)}`);
            vlog(`phase=legacy deadline reset after scroll: remaining_before_ms=${remainingBeforeResetMs} new_deadline_ts=${deadlineMs}`);
          } catch {
            // Best effort only.
          }
        }
        if (saw429) return;
        await page.wait(0.5);
      }
    };

    if (!forceLegacy) {
      const capturePattern = 'TrendsUi/data/batchexecute';
      const captureEnabled = await page.startNetworkCapture?.(capturePattern).catch(() => false);
      if (!captureEnabled) {
        throw new CliError(
          'UNSUPPORTED',
          'Network capture is unavailable for google/trends-explore',
          'Enable browser network capture support in your OpenCLI runtime and retry.',
        );
      }
      vlog(`network capture enabled with pattern="${capturePattern}"`);
      await page.goto(explorePageUrl, { waitUntil: 'load', settleMs: 3000 });
      await page.wait(1);
      vlog(`navigated to explore page: ${explorePageUrl}`);
      await runModernPhase(20_000);
    } else {
      vlog('force-legacy=true, skipping modern phase');
    }

    if (!forceLegacy && saw429) {
      vlog(`phase=modern rate_limited stats=${JSON.stringify(phaseStats.modern)}`);
      throw new CliError(
        'RATE_LIMIT',
        'Google Trends rate limited this request (HTTP 429)',
        'Retry later, reduce request frequency, or increase OPENCLI_BROWSER_COMMAND_TIMEOUT',
      );
    }

    const modernTimelineMissing = labels.length === 0 || series.length === 0;
    if (forceLegacy || (modernTimelineMissing && legacyFallbackEnabled)) {
      vlog(`phase=modern switching to legacy fallback; modernTimelineMissing=${modernTimelineMissing} forceLegacy=${forceLegacy} stats=${JSON.stringify(phaseStats.modern)}`);
      await runLegacyPhase(20_000);
    }

    if (saw429) {
      vlog(`rate_limited stats=${JSON.stringify(phaseStats)}`);
      throw new CliError(
        'RATE_LIMIT',
        'Google Trends rate limited this request (HTTP 429)',
        'Retry later, reduce request frequency, or increase OPENCLI_BROWSER_COMMAND_TIMEOUT',
      );
    }

    if (labels.length === 0 || series.length === 0) {
      if (!forceLegacy && !legacyFallbackEnabled && modernTimelineMissing) {
        vlog(`failed: timeline missing in modern phase and legacy fallback disabled stats=${JSON.stringify(phaseStats)}`);
        throw new CliError(
          'UNKNOWN',
          'Failed to capture Trends timeline from modern RPC (legacy fallback disabled)',
          'Enable --legacy-fallback or run with --force-legacy, then retry with --verbose to inspect capture logs.',
        );
      }
      vlog(`failed: timeline missing after modern+legacy fallback stats=${JSON.stringify(phaseStats)}`);
      throw new CliError(
        'UNKNOWN',
        'Failed to capture Trends timeline from modern RPC and legacy widgetdata fallback',
        'Run with --verbose and verify batchexecute/widgetdata responses are present and not blocked.',
      );
    }

    if (needRelated && related.topDetails.length === 0 && related.risingDetails.length === 0) {
      vlog(`related details missing after modern+legacy capture; timeline preserved. stats=${JSON.stringify(phaseStats)}`);
    }

    vlog(`stats=${JSON.stringify(phaseStats)}`);
    vlog(`success: labels=${labels.length}, series=${series.length}, includeRelatedDetails=${includeRelatedDetails}`);

    if (queries.length === 1) {
      const trendJson = {
        labels,
        values: series[0] || [],
      };
      if (includeRelatedDetails) {
        trendJson.top_details = related.topDetails || [];
        trendJson.rising_details = related.risingDetails || [];
      }
      return [
        {
          query: queries[0],
          geo: geo || 'Worldwide',
          date_range: date,
          trend_json: JSON.stringify(trendJson),
        },
      ];
    }

    return queries.map((query, index) => ({
      query,
      geo: geo || 'Worldwide',
      date_range: date,
      trend_json: JSON.stringify({
        labels,
        values: Array.isArray(series[index]) ? series[index] : [],
      }),
    }));
  },
});
