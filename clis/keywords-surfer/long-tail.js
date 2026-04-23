import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, EmptyResultError } from '@jackwener/opencli/errors';
import { clampInt, requireNonEmptyQuery } from '../_shared/common.js';

const SEARCH_DOMAIN = 'www.google.com';
const SEARCH_URL = `https://${SEARCH_DOMAIN}/search`;
const SIDEBAR_SELECTOR = 'keyword-surfer-sidebar';
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const EXTENSION_HINT = 'Install and enable the Keyword Surfer Chrome extension in Chrome, then rerun the command on a Google search results page.';

function buildSearchUrl(query) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', query);
    return url.toString();
}

function buildExtractionScript(limit) {
    return `
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const normalizeUrl = (value) => {
          const text = clean(value);
          if (!text) return '';
          try {
            return new URL(text, location.origin).toString();
          } catch {
            return text;
          }
        };
        const root = document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)});
        if (!root) {
          return { state: 'missing', rows: [], sourceUrl: location.href };
        }

        const findIdeasScope = () => {
          const candidates = Array.from(root.querySelectorAll('span, div, h2, h3, h4, p'));
          const heading = candidates.find((node) => clean(node.textContent) === 'Keyword ideas');
          if (!heading) return null;

          let current = heading.parentElement;
          while (current && current !== root) {
            if (current.querySelector('a.surfer-keyword-link') || /Unlucky\\.\\.\\. No results found/i.test(clean(current.textContent))) {
              return current;
            }
            current = current.parentElement;
          }
          return heading.parentElement || root;
        };

        const scope = findIdeasScope() || root;
        const scopeText = clean(scope.textContent);
        const links = Array.from(scope.querySelectorAll('a.surfer-keyword-link'));
        const rows = links.map((link, index) => {
          const keyword = clean(link.textContent);
          if (!keyword) return null;

          const row = link.closest('tr');
          const cells = Array.from(row?.querySelectorAll('td') || []);
          const cellTexts = cells.map((cell) => clean(cell.textContent)).filter(Boolean);
          const overlap = cellTexts.find((text) => /%$/.test(text) && text !== keyword) || '';
          const searchVolume = [...cellTexts].reverse().find((text) => text !== keyword && text !== overlap) || '';

          return {
            rank: index + 1,
            keyword,
            overlap,
            search_volume: searchVolume,
            url: normalizeUrl(link.getAttribute('href') || link.href || ''),
          };
        }).filter(Boolean);

        const hasNoResults = /Unlucky\\.\\.\\. No results found/i.test(scopeText);
        const isLoading = rows.length === 0 && !!scope.querySelector('.animate-pulse, [class*="animate-pulse"]');
        const state = rows.length > 0 ? 'ok' : (hasNoResults ? 'empty' : (isLoading ? 'loading' : 'empty'));

        return {
          state,
          rows: rows.slice(0, ${limit}),
          sourceUrl: location.href,
        };
      })()
    `;
}

cli({
    site: 'keywords-surfer',
    name: 'long-tail',
    description: 'Read Keyword Surfer long-tail keyword ideas from Google search results',
    domain: SEARCH_DOMAIN,
    strategy: Strategy.PUBLIC,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'query', positional: true, required: true, help: 'Google search query used to load Keyword Surfer keyword ideas' },
        { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Maximum number of long-tail keywords to return (1-${MAX_LIMIT})` },
    ],
    columns: ['rank', 'keyword', 'search_volume', 'overlap', 'url'],
    func: async (page, kwargs) => {
        const query = requireNonEmptyQuery(kwargs.query);
        const limit = clampInt(kwargs.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        const targetUrl = buildSearchUrl(query);

        await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });

        try {
            await page.wait({ selector: SIDEBAR_SELECTOR, timeout: 15 });
        } catch {
            throw new CliError(
                'EXTENSION_MISSING',
                'Keyword Surfer sidebar was not detected on the Google results page',
                EXTENSION_HINT,
            );
        }

        let payload = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            payload = await page.evaluate(buildExtractionScript(limit));
            if (payload?.state !== 'loading') {
                break;
            }
            await page.wait(2);
        }

        if (payload?.state === 'missing') {
            throw new CliError(
                'EXTENSION_MISSING',
                'Keyword Surfer sidebar was not detected on the Google results page',
                EXTENSION_HINT,
            );
        }

        if (payload?.state === 'loading') {
            throw new CliError(
                'EXTENSION_LOADING',
                'Keyword Surfer keyword ideas did not finish loading',
                'Retry the command, or open the Google results page in Chrome first so the extension can finish rendering.',
            );
        }

        if (!Array.isArray(payload?.rows) || payload.rows.length === 0) {
            throw new EmptyResultError(
                'keywords-surfer long-tail',
                `Keyword Surfer returned no long-tail keyword ideas for "${query}"`,
            );
        }

        return payload.rows.slice(0, limit).map((row, index) => ({
            rank: index + 1,
            keyword: row.keyword,
            search_volume: row.search_volume,
            overlap: row.overlap,
            url: row.url,
            query,
            source_url: payload.sourceUrl || targetUrl,
        }));
    },
});
