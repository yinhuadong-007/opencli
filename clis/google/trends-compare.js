import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';

function stripXssiPrefix(text) {
  return String(text || '').replace(/^\)\]\}',?\s*\n/, '');
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
      } catch {}
      i += 1;
      continue;
    }
    if (line.startsWith('[')) {
      try {
        chunks.push(JSON.parse(line));
      } catch {}
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
        } catch {}
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

function toNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractCompareSeriesFromPayload(payload) {
  const blocks = findFirst(
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
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { labels: [], series: [] };
  }

  let labels = [];
  const series = [];
  for (const block of blocks) {
    const query = String(block[0] || '').trim();
    const points = Array.isArray(block[4]) ? block[4] : [];
    if (!query || points.length === 0) continue;

    const values = points
      .map((row) => (Array.isArray(row) ? toNumeric(row[1]) : null))
      .filter((v) => v !== null);
    if (values.length === 0) continue;

    if (labels.length === 0) {
      labels = points.map((row, idx) => {
        const ts = toNumeric(row?.[2]?.[0]?.[0]);
        if (ts === null) return String(idx + 1);
        try {
          return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
        } catch {
          return String(idx + 1);
        }
      });
    }

    series.push({ query, values });
  }
  return { labels, series };
}

function normalizeCaptureEntry(entry) {
  return {
    url: String(entry?.url || ''),
    status: Number(entry?.responseStatus || 0),
    responsePreview: typeof entry?.responsePreview === 'string' ? entry.responsePreview : '',
    timestamp: Number(entry?.timestamp || 0),
  };
}

function normalizeGeo(rawGeo) {
  const geo = String(rawGeo ?? '').trim();
  if (!geo) return '';
  if (/^worldwide$/i.test(geo) || /^global$/i.test(geo)) return '';
  return geo;
}

cli({
  site: 'google',
  name: 'trends-compare',
  description: 'Compare multiple keywords using Trends g4kJzf relative series',
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
      help: 'Multiple search terms separated by commas, e.g. "agent,night agent,openai"',
    },
    { name: 'geo', type: 'string', default: 'Worldwide', help: 'Country/region code (e.g. US, CN, GB) or Worldwide' },
    {
      name: 'date',
      type: 'string',
      default: 'now 7-d',
      help: 'Time range: now 7-d, today 1-m, today 3-m, today 12-m, today 5-y, or absolute range "YYYY-MM-DD YYYY-MM-DD"',
    },
  ],
  columns: ['query', 'geo', 'date_range', 'trend_json'],
  func: async (page, kwargs, debug = false) => {
    const verbose = Boolean(debug || process.env.OPENCLI_VERBOSE);
    const vlog = (message) => {
      if (!verbose) return;
      process.stderr.write(`[google/trends-compare] ${message}\n`);
    };

    const rawQuery = String(kwargs.query || '').trim();
    const queries = rawQuery.split(',').map((q) => q.trim()).filter(Boolean);
    if (queries.length < 2) {
      throw new CliError(
        'INVALID_ARGS',
        '`query` must include at least two terms separated by commas',
        'Example: opencli google trends-compare "agent,night agent,openai"',
      );
    }

    const geo = normalizeGeo(kwargs.geo);
    const date = String(kwargs.date || 'now 7-d').trim();
    const explorePageUrl =
      `https://trends.google.com/explore?` +
      `geo=${encodeURIComponent(geo)}` +
      `&q=${encodeURIComponent(queries.join(','))}` +
      `&date=${encodeURIComponent(date)}`;

    const captureEnabled = await page.startNetworkCapture?.('TrendsUi/data/batchexecute').catch(() => false);
    if (!captureEnabled) {
      throw new CliError(
        'UNSUPPORTED',
        'Network capture is unavailable for google/trends-compare',
        'Enable browser network capture support in your OpenCLI runtime and retry.',
      );
    }
    vlog(`navigating: ${explorePageUrl}`);

    await page.goto(explorePageUrl, { waitUntil: 'load', settleMs: 3000 });
    await page.wait(1);

    const deadlineMs = Date.now() + 30_000;
    let lastSeenTs = 0;
    let labels = [];
    let series = [];

    while (Date.now() < deadlineMs) {
      const rawEntries = await page.readNetworkCapture?.().catch(() => []) || [];
      const entries = Array.isArray(rawEntries) ? rawEntries.map(normalizeCaptureEntry) : [];
      const fresh = entries.filter((entry) => entry.timestamp > lastSeenTs);
      if (fresh.length > 0) lastSeenTs = Math.max(lastSeenTs, ...fresh.map((entry) => entry.timestamp));

      for (const entry of fresh) {
        if (!entry.url.includes('rpcids=g4kJzf')) continue;
        if (entry.status < 200 || entry.status >= 300) continue;
        if (!entry.responsePreview) continue;

        const payloads = extractRpcPayloads(entry.responsePreview, 'g4kJzf');
        vlog(`g4kJzf payloads=${payloads.length}`);
        for (const payload of payloads) {
          const extracted = extractCompareSeriesFromPayload(payload);
          if ((extracted.labels?.length || 0) > 0 && (extracted.series?.length || 0) > 0) {
            labels = extracted.labels;
            series = extracted.series;
            vlog(`parsed labels=${labels.length} series=${series.length}`);
          }
        }
      }

      if (labels.length > 0 && series.length > 0) break;
      await page.wait(0.5);
    }

    if (labels.length === 0 || series.length === 0) {
      throw new CliError(
        'UNKNOWN',
        'Failed to parse multi-keyword g4kJzf data',
        'Retry with --verbose and confirm g4kJzf is captured with HTTP 200.',
      );
    }

    return [
      {
        query: queries.join(','),
        geo: geo || 'Worldwide',
        date_range: date,
        trend_json: JSON.stringify({
          labels,
          series,
        }),
      },
    ];
  },
});
