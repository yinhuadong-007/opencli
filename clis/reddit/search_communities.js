import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';

cli({
  site: 'reddit',
  name: 'search_communities',
  description: 'Search Reddit communities (subreddits) by keyword',
  domain: 'reddit.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'query', type: 'string', required: true, positional: true, help: 'Community search query' },
    { name: 'limit', type: 'int', default: 15, help: 'Number of communities to return' },
    {
      name: 'include_over_18',
      type: 'boolean',
      default: true,
      help: 'Whether to include NSFW communities',
    },
  ],
  columns: ['name', 'title', 'subscribers', 'nsfw', 'url', 'description'],
  func: async (page, kwargs) => {
    const query = String(kwargs.query || '').trim();
    const limit = Math.max(1, Math.min(Number(kwargs.limit) || 15, 100));
    const includeOver18 = kwargs.include_over_18 !== false;

    if (!query) {
      throw new CliError(
        'INVALID_ARGS',
        '`query` is required',
        'Example: opencli reddit search_communities OpenAI',
      );
    }

    await page.goto('https://www.reddit.com', { waitUntil: 'load', settleMs: 2500 });
    await page.wait(1);

    const data = await page.evaluate(`
      (async () => {
        const q = ${JSON.stringify(query)};
        const limit = ${JSON.stringify(limit)};
        const includeOver18 = ${JSON.stringify(includeOver18)};
        const params = new URLSearchParams({
          q,
          limit: String(limit),
          include_over_18: includeOver18 ? 'on' : 'off',
          raw_json: '1',
        });
        const url = '/subreddits/search.json?' + params.toString();
        const res = await fetch(url, {
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
            const path = item.url || ('/r/' + (item.display_name || '') + '/');
            return {
              name: item.display_name_prefixed || (item.display_name ? ('r/' + item.display_name) : ''),
              title: item.title || '',
              subscribers: typeof item.subscribers === 'number' ? item.subscribers : null,
              nsfw: !!item.over18,
              url: path ? new URL(path, 'https://www.reddit.com').toString() : '',
              description: item.public_description || item.submit_text_label || '',
            };
          }),
        };
      })()
    `);

    if (!data?.ok) {
      throw new CliError(
        'FETCH_ERROR',
        `Reddit community search failed with HTTP ${data?.status ?? 'unknown'}`,
        data?.bodyPreview?.includes('whoa there')
          ? 'Reddit blocked the request. Make sure you are logged in in the connected browser session.'
          : 'Try again after opening Reddit in the connected browser session.',
      );
    }

    const items = Array.isArray(data.items) ? data.items.filter((item) => item.name && item.url) : [];
    if (!items.length) {
      throw new CliError(
        'NOT_FOUND',
        `No communities found for "${query}"`,
        'Try a broader search keyword or verify that Reddit is accessible in the browser session.',
      );
    }

    return items.slice(0, limit);
  },
});
