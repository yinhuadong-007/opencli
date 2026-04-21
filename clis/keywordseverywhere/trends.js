/**
 * Keywords Everywhere Trends list scraping via browser DOM extraction.
 *
 * Example target:
 * https://trends.keywordseverywhere.com/c/technology/s/ai?page_size=120&sort=growth_quarter
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';

const DOMAIN = 'trends.keywordseverywhere.com';
const BASE_URL = `https://${DOMAIN}`;
const ALLOWED_PAGE_SIZES = new Set([21, 30, 60, 90, 120]);
const ALLOWED_SORTS = new Set(['growth_5_years', 'growth_year', 'growth_quarter', 'volume', 'alphabetical']);

function normalizeSlug(value, fallback) {
  const text = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
}

function normalizePageSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return 120;
  if (ALLOWED_PAGE_SIZES.has(size)) return size;
  return 120;
}

function normalizeSort(value) {
  const sort = String(value || 'growth_quarter').trim().toLowerCase();
  return ALLOWED_SORTS.has(sort) ? sort : 'growth_quarter';
}

function buildCollectionUrl({ category, subcategory, pageSize, sort, page }) {
  const url = new URL(`${BASE_URL}/c/${category}/s/${subcategory}`);
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('sort', sort);
  if (page > 1) {
    url.searchParams.set('page', String(page));
  }
  return url.toString();
}

cli({
  site: 'keywordseverywhere',
  name: 'trends',
  description: 'Scrape Keywords Everywhere Trends category pages',
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'category', type: 'string', default: 'technology', help: 'Category slug, e.g. technology' },
    { name: 'subcategory', type: 'string', default: 'ai', help: 'Subcategory slug, e.g. ai' },
    {
      name: 'sort',
      type: 'string',
      default: 'growth_quarter',
      help: 'Sort: growth_5_years, growth_year, growth_quarter, volume, alphabetical',
    },
    { name: 'page_size', type: 'int', default: 120, help: 'One of 21, 30, 60, 90, 120' },
    { name: 'page', type: 'int', default: 1, help: 'Page number (1-based)' },
    { name: 'limit', type: 'int', default: 120, help: 'Max rows to return after scraping' },
  ],
  columns: [
    'title',
    'monthly_volume',
    'growth_5y',
    'growth_1y',
    'growth_3mo',
    'category',
    'subcategory',
    'status',
    'url',
  ],
  func: async (page, args) => {
    const category = normalizeSlug(args.category, 'technology');
    const subcategory = normalizeSlug(args.subcategory, 'ai');
    const sort = normalizeSort(args.sort);
    const pageSize = normalizePageSize(args.page_size);
    const pageNumber = Math.max(1, Number(args.page) || 1);
    const limit = Math.max(1, Math.min(Number(args.limit) || pageSize, pageSize));

    const warmupUrl = `${BASE_URL}/c/${category}/s/${subcategory}`;
    const targetUrl = buildCollectionUrl({
      category,
      subcategory,
      pageSize,
      sort,
      page: pageNumber,
    });

    // The site may bounce an initial direct visit; warming the category page first
    // makes the parameterized page load reliably in the same session.
    await page.goto(warmupUrl, { waitUntil: 'load', settleMs: 2500 });
    await page.wait(1);
    await page.goto(targetUrl, { waitUntil: 'load', settleMs: 2500 });
    await page.wait(1);

    const data = await page.evaluate(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const toAbsoluteUrl = (value) => {
          const text = clean(value);
          if (!text) return '';
          try {
            return new URL(text, location.origin).toString();
          } catch {
            return text;
          }
        };
        const readMetric = (header, label) => {
          const groups = Array.from(header.querySelectorAll('.stats .flex.flex-column, .stats .d-flex > div, .stats > div'));
          for (const group of groups) {
            const marker = clean(group.querySelector('span')?.textContent || group.textContent || '');
            if (!marker.includes(label)) continue;
            const valueEl = group.querySelector('div');
            const value = clean(valueEl?.textContent || '');
            if (value) return value;
          }
          return '';
        };

        const cards = Array.from(document.querySelectorAll('.card.h-100'));
        const rows = cards.map((card) => {
          const titleLink = card.querySelector('h2 a[href*="/trend/"]');
          const header = card.querySelector('.topic-card-header') || card;
          const body = card.querySelector('.card-body') || card;
          const volumeBlock = header.querySelector('.text-info');
          const textLinks = Array.from(body.querySelectorAll('a'));
          const categoryText = clean(body.querySelector('.text-category')?.textContent || '');
          const subcategoryText = clean(body.querySelector('.text-subcategory')?.textContent || '');
          const statusLink = textLinks.find((link) => /\\/status\\//.test(link.getAttribute('href') || ''));
          const descriptionNode = Array.from(body.querySelectorAll('p')).find((p) => clean(p.textContent));
          return {
            title: clean(titleLink?.textContent || ''),
            monthly_volume: clean(volumeBlock?.childNodes?.[0]?.textContent || volumeBlock?.textContent || '').replace(/\\s*vol\\/mo$/i, ''),
            growth_5y: readMetric(header, '(5y)'),
            growth_1y: readMetric(header, '(1y)'),
            growth_3mo: readMetric(header, '(3mo)'),
            description: clean(descriptionNode?.textContent || ''),
            category: categoryText,
            subcategory: subcategoryText,
            status: clean(statusLink?.textContent || ''),
            url: toAbsoluteUrl(titleLink?.getAttribute('href') || ''),
          };
        }).filter((row) => row.title && row.url);

        const showingText = clean(Array.from(document.querySelectorAll('p')).find((p) => /Showing\\s+\\d+\\s+to\\s+\\d+\\s+of\\s+\\d+\\s+results/i.test(clean(p.textContent)))?.textContent || '');
        const totalMatch = showingText.match(/of\\s+(\\d+)\\s+results/i);
        const dropdownValues = Array.from(document.querySelectorAll('.form-control .dropdown-value'))
          .map((el) => clean(el.textContent))
          .filter(Boolean);
        const effectiveSortLabel = dropdownValues.find((value) => /growth|volume|alphabetical/i.test(value)) || '';
        const effectivePageSize = dropdownValues.find((value) => /^\\d+$/.test(value)) || '';

        return {
          rows,
          total_results: totalMatch ? Number(totalMatch[1]) : null,
          showing_text: showingText,
          effective_page_size: effectivePageSize ? Number(effectivePageSize) : null,
          effective_sort_label: effectiveSortLabel,
          final_url: location.href,
        };
      })()
    `);

    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (!rows.length) {
      throw new CliError(
        'NOT_FOUND',
        'No trend cards found on the Keywords Everywhere page',
        `Check whether ${targetUrl} still exposes public category listings`,
      );
    }

    return rows.slice(0, limit).map((row, index) => ({
      rank: index + 1 + (pageNumber - 1) * pageSize,
      title: row.title,
      monthly_volume: row.monthly_volume,
      growth_5y: row.growth_5y,
      growth_1y: row.growth_1y,
      growth_3mo: row.growth_3mo,
      category: row.category || category,
      subcategory: row.subcategory || subcategory,
      status: row.status,
      url: row.url,
      description: row.description,
      total_results: data?.total_results ?? null,
      showing: data?.showing_text || '',
      effective_page_size: data?.effective_page_size ?? pageSize,
      effective_sort_label: data?.effective_sort_label || '',
      source_url: data?.final_url || targetUrl,
    }));
  },
});
