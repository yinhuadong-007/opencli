import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';

const SORT_ALIASES = {
  relevance: 'relevance',
  hot: 'hot',
  top: 'top',
  new: 'new',
  comments: 'comments',
  'comment count': 'comments',
};

const TIME_ALIASES = {
  all: 'all',
  'all time': 'all',
  year: 'year',
  'past year': 'year',
  month: 'month',
  'past month': 'month',
  week: 'week',
  'past week': 'week',
  day: 'day',
  today: 'day',
  hour: 'hour',
  'past hour': 'hour',
};

function normalizeChoice(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeSort(value) {
  const normalized = normalizeChoice(value) || 'relevance';
  return SORT_ALIASES[normalized] || 'relevance';
}

function normalizeTime(value) {
  const normalized = normalizeChoice(value) || 'all';
  return TIME_ALIASES[normalized] || 'all';
}

cli({
  site: 'reddit',
  name: 'search_posts',
  description: 'Search Reddit posts by keyword',
  domain: 'reddit.com',
  strategy: Strategy.COOKIE,
  access: 'read',
  browser: true,
  args: [
    { name: 'query', type: 'string', required: true, positional: true, help: 'Post search query' },
    {
      name: 'subreddit',
      type: 'string',
      default: '',
      help: 'Search within a specific subreddit',
    },
    {
      name: 'sort',
      type: 'string',
      default: 'relevance',
      help: 'sort: Relevance, Hot, Top, New, Comment count',
    },
    {
      name: 'time',
      type: 'string',
      default: 'all',
      help: 'Time: All time, Past year, Past month, Past week, Today, Past hour',
    },
    { name: 'limit', type: 'int', default: 15, help: 'Number of posts to return' },
  ],
  columns: ['title', 'subreddit', 'author', 'score', 'comments', 'created_at', 'url'],
  func: async (page, kwargs) => {
    const query = String(kwargs.query || '').trim();
    const subreddit = String(kwargs.subreddit || '').trim();
    const sort = normalizeSort(kwargs.sort);
    const time = normalizeTime(kwargs.time);
    const limit = Math.max(1, Math.min(Number(kwargs.limit) || 15, 100));

    if (!query) {
      throw new CliError(
        'INVALID_ARGS',
        '`query` is required',
        'Example: opencli reddit search_posts "ai for teachers"',
      );
    }

    await page.goto('https://www.reddit.com', { waitUntil: 'load', settleMs: 2500 });
    await page.wait(1);

    const data = await page.evaluate(`
      (async () => {
        const query = ${JSON.stringify(query)};
        const subreddit = ${JSON.stringify(subreddit)};
        const sort = ${JSON.stringify(sort)};
        const time = ${JSON.stringify(time)};
        const limit = ${JSON.stringify(limit)};
        const params = new URLSearchParams({
          q: query,
          sort,
          t: time,
          limit: String(limit),
          restrict_sr: subreddit ? 'on' : 'off',
          raw_json: '1',
        });
        const path = subreddit ? ('/r/' + subreddit + '/search.json') : '/search.json';
        const res = await fetch(path + '?' + params.toString(), {
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
          },
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return {
          ok: res.ok,
          status: res.status,
          bodyPreview: text.slice(0, 300),
          items: (json?.data?.children || []).map((child) => {
            const item = child?.data || {};
            return {
              title: item.title || '',
              subreddit: item.subreddit_name_prefixed || '',
              author: item.author || '',
              score: typeof item.score === 'number' ? item.score : null,
              comments: typeof item.num_comments === 'number' ? item.num_comments : null,
              created_at: item.created_utc ? new Date(item.created_utc * 1000).toISOString() : '',
              url: item.permalink ? new URL(item.permalink, 'https://www.reddit.com').toString() : '',
              text: item.selftext || '',
            };
          }),
        };
      })()
    `);

    if (!data?.ok) {
      throw new CliError(
        'FETCH_ERROR',
        `Reddit post search failed with HTTP ${data?.status ?? 'unknown'}`,
        data?.bodyPreview?.includes('whoa there')
          ? 'Reddit blocked the request. Make sure you are logged in in the connected browser session.'
          : 'Try again after opening Reddit in the connected browser session.',
      );
    }

    const items = Array.isArray(data.items) ? data.items.filter((item) => item.title && item.url) : [];
    if (!items.length) {
      throw new CliError(
        'NOT_FOUND',
        `No posts found for "${query}"`,
        'Try a broader search keyword or verify that Reddit is accessible in the browser session.',
      );
    }

    return items.slice(0, limit);
  },
});
