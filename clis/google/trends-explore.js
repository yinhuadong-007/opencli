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

function pickWidget(widgets, predicate) {
  for (const widget of widgets) {
    if (predicate(widget)) return widget;
  }
  return undefined;
}

function parseRelatedRanks(data) {
  const ranked = data?.default?.rankedList;
  const list = Array.isArray(ranked) ? ranked : [];
  const pickText = (keyword) => {
    const query = keyword?.query;
    return typeof query === 'string' ? query : '';
  };
  const pickDetail = (keyword) => ({
    query: typeof keyword?.query === 'string' ? keyword.query : '',
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

cli({
  site: 'google',
  name: 'trends-explore',
  description: 'Google Trends Explore: interest over time + related queries for a search term',
  domain: 'trends.google.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: 'query',
      positional: true,
      type: 'string',
      required: true,
      help: 'Search term(s) to explore; for multiple terms, separate with commas, e.g. "ai,opencli,openclaw"',
    },
    { name: 'geo', type: 'string', default: 'US', help: 'Country/region code (e.g. US, CN, GB)' },
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
    { name: 'hl', type: 'string', default: 'en-US', help: 'UI language (e.g. en-US, zh-CN)' },
    { name: 'tz', type: 'int', default: -480, help: 'Timezone offset minutes (e.g. -480 for PT)' },
  ],
  columns: ['query', 'geo', 'date_range', 'trend_json'],
  func: async (page, kwargs) => {
    const waitWithHeartbeat = async (totalMs) => {
      const heartbeatMs = 8000;
      let remaining = Math.max(0, Number(totalMs) || 0);
      while (remaining > 0) {
        const chunk = Math.min(heartbeatMs, remaining);
        await page.wait(chunk / 1000);
        remaining -= chunk;
        if (remaining > 0) {
          await page.evaluate('1');
        }
      }
    };

    const rawQuery = String(kwargs.query || '').trim();
    const queries = rawQuery
      .split(',')
      .map((query) => query.trim())
      .filter(Boolean);
    const geo = String(kwargs.geo || 'US').trim();
    const date = String(kwargs.date || 'now 7-d').trim();
    const includeRelatedDetails = Boolean(kwargs.details ?? false);
    const hl = String(kwargs.hl || 'en-US').trim();
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

    const req = {
      comparisonItem: queries.map((query) => ({ keyword: query, geo, time: date })),
      category: 0,
      property: '',
    };

    const explorePageUrl =
      `https://trends.google.com/explore?` +
      `geo=${encodeURIComponent(geo)}` +
      `&q=${encodeURIComponent(queries.join(', '))}` +
      `&date=${encodeURIComponent(date)}`;

    await page.goto(explorePageUrl, { waitUntil: 'load', settleMs: 3000 });
    await page.wait(1);

    const evalScript = `(async function() {
        function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
        function stripXssiPrefix(text) {
          return text.replace(/^\\)\\]\\}',?\\s*\\n/, '');
        }
        async function fetchTrendsJson(url, retryDelaysMs) {
          var delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
          var lastErr = null;
          for (var attempt = 0; attempt <= delays.length; attempt++) {
            try {
              const resp = await fetch(url, { credentials: 'include' });
              const text = await resp.text();
              if (!resp.ok) {
                const msg = (text || '').trim().slice(0, 200);
                if (resp.status === 429 && attempt < delays.length) {
                  await sleep(delays[attempt]);
                  continue;
                }
                throw new Error('HTTP ' + resp.status + (msg ? (': ' + msg) : ''));
              }
              const cleaned = stripXssiPrefix(text).trim();
              return JSON.parse(cleaned);
            } catch (e) {
              lastErr = e;
              var msg2 = (e && e.message) ? String(e.message) : String(e);
              if ((msg2.indexOf('Failed to fetch') !== -1 || msg2.indexOf('NetworkError') !== -1) && attempt < delays.length) {
                await sleep(delays[attempt]);
                continue;
              }
              throw e;
            }
          }
          throw lastErr || new Error('Failed to fetch');
        }
        function pickWidget(widgets, pred) {
          for (var i = 0; i < widgets.length; i++) {
            if (pred(widgets[i])) return widgets[i];
          }
          return null;
        }
        function parseRelatedRanks(data) {
          var ranked = data && data.default && data.default.rankedList;
          var list = Array.isArray(ranked) ? ranked : [];
          var pickText = function(keyword) {
            var q = keyword && keyword.query;
            return (typeof q === 'string') ? q : '';
          };
          var pickDetail = function(keyword) {
            return {
              query: (keyword && typeof keyword.query === 'string') ? keyword.query : '',
              value: (keyword && typeof keyword.value === 'number') ? keyword.value : null,
              formattedValue: (keyword && typeof keyword.formattedValue === 'string') ? keyword.formattedValue : '',
            };
          };
          var topKeywords = ((list[0] && list[0].rankedKeyword) || []);
          var risingKeywords = ((list[1] && list[1].rankedKeyword) || []);
          var top = topKeywords.map(pickText).filter(Boolean);
          var rising = risingKeywords.map(pickText).filter(Boolean);
          var topDetails = topKeywords.map(pickDetail).filter(function(k) { return !!k.query; });
          var risingDetails = risingKeywords.map(pickDetail).filter(function(k) { return !!k.query; });
          return { top: top, rising: rising, topDetails: topDetails, risingDetails: risingDetails };
        }

        var hl = ${JSON.stringify(hl)};
        var tz = ${JSON.stringify(tz)};
        var req = ${JSON.stringify(req)};
        var queries = ${JSON.stringify(queries)};

        var exploreUrl =
          'https://trends.google.com/trends/api/explore' +
          '?hl=' + encodeURIComponent(hl) +
          '&tz=' + encodeURIComponent(String(tz)) +
          '&req=' + encodeURIComponent(JSON.stringify(req));

        var retryDelays = [4000, 8000, 12000];
        var explore = await fetchTrendsJson(exploreUrl, retryDelays);
        var widgets = Array.isArray(explore && explore.widgets) ? explore.widgets : [];
        if (!widgets.length) throw new Error('No widgets returned');

        var timeSeriesWidget =
          pickWidget(widgets, function(w) { return w && w.id === 'TIMESERIES'; }) ||
          pickWidget(widgets, function(w) { return String((w && w.type) || '').toUpperCase().indexOf('TIMESERIES') !== -1; }) ||
          pickWidget(widgets, function(w) { return String((w && w.title) || '').toLowerCase().indexOf('interest over time') !== -1; });

        var relatedWidget =
          pickWidget(widgets, function(w) { return w && w.id === 'RELATED_QUERIES'; }) ||
          pickWidget(widgets, function(w) { return String((w && w.type) || '').toUpperCase().indexOf('RELATED_QUERIES') !== -1; }) ||
          pickWidget(widgets, function(w) { return String((w && w.title) || '').toLowerCase().indexOf('related queries') !== -1; });

        if (!timeSeriesWidget || !timeSeriesWidget.token || !timeSeriesWidget.request) {
          throw new Error('Missing time series widget token/request');
        }

        var multilineUrl =
          'https://trends.google.com/trends/api/widgetdata/multiline' +
          '?hl=' + encodeURIComponent(hl) +
          '&tz=' + encodeURIComponent(String(tz)) +
          '&req=' + encodeURIComponent(JSON.stringify(timeSeriesWidget.request)) +
          '&token=' + encodeURIComponent(String(timeSeriesWidget.token));

        var multiline = await fetchTrendsJson(multilineUrl, retryDelays);
        var timelineData = multiline && multiline.default && multiline.default.timelineData;
        var timeline = Array.isArray(timelineData) ? timelineData : [];
        var labels = timeline.map(function(p) { return p && p.formattedTime; }).filter(function(x) { return typeof x === 'string'; });

        var seriesCount = 0;
        if (timeline.length > 0 && Array.isArray(timeline[0].value)) {
          seriesCount = timeline[0].value.length;
        }

        var series = [];
        for (var s = 0; s < seriesCount; s++) {
          var values = timeline.map(function(p) {
            var arr = p && p.value;
            var v = Array.isArray(arr) ? arr[s] : undefined;
            return (typeof v === 'number') ? v : null;
          }).filter(function(v) { return typeof v === 'number'; });
          series.push(values);
        }

        var related = { top: [], rising: [], topDetails: [], risingDetails: [] };
        if (relatedWidget && relatedWidget.token && relatedWidget.request) {
          var relatedUrl =
            'https://trends.google.com/trends/api/widgetdata/relatedsearches' +
            '?hl=' + encodeURIComponent(hl) +
            '&tz=' + encodeURIComponent(String(tz)) +
            '&req=' + encodeURIComponent(JSON.stringify(relatedWidget.request)) +
            '&token=' + encodeURIComponent(String(relatedWidget.token));
          var relatedResp = await fetchTrendsJson(relatedUrl, retryDelays);
          related = parseRelatedRanks(relatedResp);
        }

        return { labels: labels, series: series, related: related, queries: queries };
      })()`;

    const runEvaluateWith429Recovery = async () => {
      const pageRetryDelays = [5000, 10000, 15000];
      let lastErr;

      for (let attempt = 0; attempt <= pageRetryDelays.length; attempt++) {
        try {
          return await page.evaluate(evalScript);
        } catch (error) {
          lastErr = error;
          const message = error instanceof Error ? error.message : String(error);
          const is429 = /\b429\b/.test(message);

          if (is429 && attempt < pageRetryDelays.length) {
            await page.goto(explorePageUrl, { waitUntil: 'load', settleMs: 3000 });
            await page.wait(1);
            await waitWithHeartbeat(pageRetryDelays[attempt]);
            continue;
          }

          throw error;
        }
      }

      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };

    const data = await runEvaluateWith429Recovery();

    const labels = (data && data.labels) || [];
    const series = (data && data.series) || [];
    const related = (data && data.related) || { top: [], rising: [], topDetails: [], risingDetails: [] };

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
          geo,
          date_range: date,
          trend_json: JSON.stringify(trendJson),
        },
      ];
    }

    return queries.map((query, index) => ({
      query,
      geo,
      date_range: date,
      trend_json: JSON.stringify({
        labels,
        values: series[index] || [],
      }),
    }));
  },
});
