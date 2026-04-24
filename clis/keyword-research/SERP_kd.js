import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { clampInt, requireNonEmptyQuery } from '../_shared/common.js';

const GOOGLE_DOMAIN = 'www.google.com';
const SEARCH_URL = `https://${GOOGLE_DOMAIN}/search`;
const OPENPAGERANK_URL = 'https://openpagerank.com/api/v1.0/getPageRank';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;
const DEFAULT_COUNTRY = 'US';
const DEFAULT_LANG = 'en';
const OPENPAGERANK_ENV_VARS = ['OPENPAGERANK_API_KEY', 'OPEN_PAGE_RANK_API_KEY', 'API_OPR'];
const POSITION_WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

const UGC_HOSTS = [
    /^reddit\.com$/i,
    /\.reddit\.com$/i,
    /^quora\.com$/i,
    /\.quora\.com$/i,
    /^zhihu\.com$/i,
    /\.zhihu\.com$/i,
    /^stackoverflow\.com$/i,
    /\.stackoverflow\.com$/i,
];

function normalizeCountry(value) {
    const normalized = String(value || DEFAULT_COUNTRY).trim().toUpperCase();
    return /^[A-Z]{2}$/.test(normalized) ? normalized : DEFAULT_COUNTRY;
}

function normalizeLang(value) {
    const normalized = String(value || DEFAULT_LANG).trim();
    return normalized || DEFAULT_LANG;
}

function buildSearchUrl(query, { country, lang, limit = DEFAULT_LIMIT, allintitle = false } = {}) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', allintitle ? `allintitle:"${query}"` : query);
    url.searchParams.set('gl', normalizeCountry(country));
    url.searchParams.set('hl', normalizeLang(lang));
    if (!allintitle) {
        url.searchParams.set('num', String(clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT)));
    }
    return url.toString();
}

function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/^www\./, '');
}

function matchesHost(host, patterns) {
    return patterns.some((pattern) => pattern.test(host));
}

function toPositiveNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toNonNegativeNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function toOptionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function readOpenPageRankApiKey(kwargs = {}) {
    const explicit = String(kwargs.openpagerankKey || kwargs.openpagerank_key || '').trim();
    if (explicit) return explicit;

    for (const name of OPENPAGERANK_ENV_VARS) {
        const value = String(process.env[name] || '').trim();
        if (value) return value;
    }

    return '';
}

function normalizeDomainList(domains) {
    return Array.from(
        new Set(
            (Array.isArray(domains) ? domains : [])
                .map((domain) => normalizeHost(domain))
                .filter(Boolean),
        ),
    );
}

export async function fetchOpenPageRankScores(domains, apiKey, fetchImpl = fetch) {
    const normalizedDomains = normalizeDomainList(domains).slice(0, 100);
    if (!apiKey || !normalizedDomains.length) {
        return new Map();
    }

    const url = new URL(OPENPAGERANK_URL);
    for (const domain of normalizedDomains) {
        url.searchParams.append('domains[]', domain);
    }

    const response = await fetchImpl(url.toString(), {
        headers: {
            'API-OPR': apiKey,
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        throw new Error(`OpenPageRank HTTP ${response.status}`);
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.response) ? payload.response : [];
    const scores = new Map();
    for (const item of items) {
        const domain = normalizeHost(item?.domain);
        if (!domain) continue;
        scores.set(domain, {
            domain,
            rank: toNonNegativeNumber(item?.rank),
            pageRankInteger: toNonNegativeNumber(item?.page_rank_integer),
            pageRankDecimal: toOptionalNumber(item?.page_rank_decimal),
            statusCode: toNonNegativeNumber(item?.status_code),
            error: String(item?.error || ''),
        });
    }

    return scores;
}

export function classifySerpResult(result) {
    const host = normalizeHost(result?.host || result?.domain || '');
    const title = String(result?.title || '');
    const snippet = String(result?.snippet || '');
    const url = String(result?.url || '');
    const haystack = `${host} ${title} ${snippet} ${url}`.toLowerCase();

    if (matchesHost(host, UGC_HOSTS)) {
        return 'ugc';
    }

    if (/\b(forum|forums|community|communities|thread|threads|q&a|question|questions)\b/i.test(haystack)) {
        if (/\b(q&a|question|questions)\b/i.test(haystack)) return 'qna';
        if (/\b(forum|forums|thread|threads)\b/i.test(haystack)) return 'forum';
        return 'community';
    }

    return 'unknown';
}

export function scoreAllintitleKD({ allintitleCount, searchVolume }) {
    const count = Math.max(0, Number(allintitleCount) || 0);
    const volume = Number(searchVolume);
    const withMinimumFloor = (score) => (count > 100 ? Math.max(10, score) : score);

    const interpolateBand = (value, lowerBound, upperBound, baseScore, upperScore) => {
        const progress = (value - lowerBound) / (upperBound - lowerBound);
        return Math.round(baseScore + progress * (upperScore - baseScore));
    };

    const countScore = (() => {
        if (count <= 50) return withMinimumFloor(0);
        if (count < 200) return withMinimumFloor(interpolateBand(count, 50, 200, 0, 9));
        if (count < 1000) return withMinimumFloor(interpolateBand(count, 200, 1000, 9, 18));
        if (count < 5000) return withMinimumFloor(interpolateBand(count, 1000, 5000, 18, 27));
        if (count < 20000) return withMinimumFloor(interpolateBand(count, 5000, 20000, 27, 34));
        if (count < 100000) return withMinimumFloor(interpolateBand(count, 20000, 100000, 34, 39));
        if (count < 1000000) return withMinimumFloor(interpolateBand(count, 100000, 1000000, 39, 42));
        return withMinimumFloor(45);
    })();

    if (Number.isFinite(volume) && volume > 0) {
        const ratio = volume / Math.max(count, 1);
        const ratioScore = (() => {
            if (ratio >= 20) return withMinimumFloor(0);
            if (ratio >= 10) return withMinimumFloor(12);
            if (ratio >= 5) return withMinimumFloor(24);
            if (ratio >= 2) return withMinimumFloor(34);
            return withMinimumFloor(45);
        })();
        return Math.max(countScore, ratioScore);
    }

    return countScore;
}

export function computeWeightedAverageOprDecimal(results) {
    const safeResults = Array.isArray(results) ? results : [];
    let weightedSum = 0;
    let totalWeight = 0;

    for (let index = 0; index < safeResults.length && index < POSITION_WEIGHTS.length; index += 1) {
        const decimal = toOptionalNumber(safeResults[index]?.oprPageRankDecimal);
        if (decimal === null) continue;
        const weight = POSITION_WEIGHTS[index];
        weightedSum += decimal * weight;
        totalWeight += weight;
    }

    if (!totalWeight) return null;
    return Number((weightedSum / totalWeight).toFixed(2));
}

export function scoreSerpAuthorityKD({ avgOprDecimal }) {
    const average = toOptionalNumber(avgOprDecimal);
    if (average === null) return 5;
    if (average < 2) return 5;

    const interpolateBand = (value, lowerBound, upperBound, baseScore, upperScore) => {
        const progress = (value - lowerBound) / (upperBound - lowerBound);
        return Math.round(baseScore + progress * (upperScore - baseScore));
    };

    if (average < 3) return interpolateBand(average, 2, 3, 14, 24);
    if (average < 4) return interpolateBand(average, 3, 4, 24, 35);
    if (average < 5) return interpolateBand(average, 4, 5, 35, 44);
    if (average < 6) return interpolateBand(average, 5, 6, 44, 55);
    return 55;
}

export function scoreUgcRelief({ ugcCount }) {
    const count = Math.max(0, Number(ugcCount) || 0);
    if (count >= 3) return -20;
    if (count === 2) return -14;
    if (count === 1) return -8;
    return 0;
}

export function toKdLevel(kd) {
    const score = Math.max(0, Math.min(100, Number(kd) || 0));
    if (score <= 19) return 'very_easy';
    if (score <= 39) return 'easy';
    if (score <= 59) return 'medium';
    if (score <= 79) return 'hard';
    return 'very_hard';
}

function buildWhy(reasons) {
    return reasons.filter(Boolean).join('; ');
}

function buildKdBreakdown({ allintitleKd, serpAuthorityKd, ugcRelief }) {
    return `allintitle_kd=${allintitleKd}, serp_authority_kd=${serpAuthorityKd}, ugc_relief=${ugcRelief}`;
}

function buildReasonLines({ allintitleCount, searchVolume, ugcCount, openPageRankUsed, avgOprDecimal }) {
    const reasons = [];

    if (Number.isFinite(Number(searchVolume)) && Number(searchVolume) > 0) {
        const ratio = Number(searchVolume) / Math.max(Number(allintitleCount) || 0, 1);
        if (ratio >= 10) reasons.push('search volume materially exceeds exact-title competition');
        else if (ratio < 2) reasons.push('exact-title competition is high relative to search volume');
    } else if ((Number(allintitleCount) || 0) <= 200) {
        reasons.push('allintitle count is low');
    } else if ((Number(allintitleCount) || 0) > 5000) {
        reasons.push('allintitle count is very high');
    }

    if ((avgOprDecimal ?? 0) >= 6) reasons.push('page one is dominated by high-authority domains');
    else if ((avgOprDecimal ?? 0) >= 4) reasons.push('page one shows a meaningful authority wall');
    else reasons.push('page one has relatively low weighted authority');

    if (ugcCount >= 3) reasons.push('ugc/community results reduce effective SERP difficulty');
    else if (ugcCount === 0) reasons.push('no meaningful ugc relief on page one');

    reasons.push(openPageRankUsed ? 'authority source: OpenPageRank' : 'authority source: free domain heuristics');

    return reasons;
}

function toPublicSerpResult(result) {
    return {
        position: result.position,
        title: result.title,
        url: result.url,
        host: result.host,
        snippet: result.snippet,
        opr_rank: result.oprRank ?? null,
        opr_page_rank_integer: result.oprPageRankInteger ?? null,
        opr_page_rank_decimal: result.oprPageRankDecimal ?? null,
        authority_source: result.authoritySource ?? 'heuristic',
        result_type: result.resultType,
    };
}

export function analyzeKdReport({ query, country, lang, allintitleCount, searchVolume, serpResults, openPageRankUsed = false, sourceUrl, allintitleUrl }) {
    const safeResults = Array.isArray(serpResults) ? serpResults : [];
    const normalizedSearchVolume = toPositiveNumber(searchVolume);
    const ugcResults = [];

    for (const result of safeResults) {
        if (['ugc', 'forum', 'qna', 'community'].includes(result.resultType)) ugcResults.push(toPublicSerpResult(result));
    }

    const avgOprDecimal = computeWeightedAverageOprDecimal(safeResults);
    const ugcCount = ugcResults.length;
    const allintitleKd = scoreAllintitleKD({ allintitleCount, searchVolume });
    const serpAuthorityKd = scoreSerpAuthorityKD({ avgOprDecimal });
    const ugcRelief = scoreUgcRelief({ ugcCount });
    const kd = Math.max(0, Math.min(100, allintitleKd + serpAuthorityKd + ugcRelief));
    const reasons = buildReasonLines({
        allintitleCount,
        searchVolume,
        ugcCount,
        openPageRankUsed,
        avgOprDecimal,
    });

    return {
        query,
        country,
        lang,
        kd,
        kd_level: toKdLevel(kd),
        allintitle_count: allintitleCount,
        search_volume: normalizedSearchVolume,
        search_volume_source: normalizedSearchVolume ? 'keyword_surfer' : 'none',
        openpagerank_used: !!openPageRankUsed,
        avg_opr_decimal: avgOprDecimal,
        ugc_count: ugcCount,
        why: buildWhy(reasons),
        kd_breakdown: buildKdBreakdown({
            allintitleKd,
            serpAuthorityKd,
            ugcRelief,
        }),
        reasons,
        ugc_results: ugcResults,
        serp_results: safeResults.map(toPublicSerpResult),
        source_url: sourceUrl,
        allintitle_url: allintitleUrl,
        kd_components: {
            allintitle_kd: allintitleKd,
            serp_authority_kd: serpAuthorityKd,
            ugc_relief: ugcRelief,
        },
    };
}

function buildSerpExtractionScript(limit) {
    return `
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const toHost = (value) => {
          try {
            return new URL(value).hostname.replace(/^www\\./, '').toLowerCase();
          } catch {
            return '';
          }
        };
        const parseSearchVolume = () => {
          const widget = document.querySelector('.surfer-main-keyword-widget, .ks-main-keyword-widget');
          if (!widget) return null;
          const text = clean(widget.innerText || widget.textContent || '');
          const matches = text.match(/\\b\\d{1,3}(?:,\\d{3})+\\b|\\b\\d{4,}\\b/g) || [];
          const values = matches
            .map((value) => Number(value.replace(/,/g, '')))
            .filter((value) => Number.isFinite(value) && value >= 100);
          if (!values.length) return null;
          return Math.max(...values);
        };

        const rso = document.querySelector('#rso');
        if (!rso) {
          return { rows: [], searchVolume: parseSearchVolume(), sourceUrl: location.href };
        }

        const rows = [];
        const seen = new Set();
        const links = Array.from(rso.querySelectorAll('a'));
        for (const link of links) {
          const h3 = link.querySelector('h3');
          if (!h3) continue;
          const href = link.href || '';
          if (!/^https?:\\/\\//i.test(href)) continue;
          if (href.includes('google.com/search')) continue;
          if (seen.has(href)) continue;
          seen.add(href);

          let container = link;
          for (let i = 0; i < 6; i += 1) {
            if (container.parentElement && container.parentElement !== rso) {
              container = container.parentElement;
            }
            if (container.getAttribute && container.getAttribute('data-hveid')) break;
          }

          let snippet = '';
          const title = clean(h3.textContent);
          for (const candidate of Array.from(container.querySelectorAll('span, div'))) {
            if (candidate.querySelector('h3') || candidate.querySelector('a[href]')) continue;
            const text = clean(candidate.textContent);
            if (text.length < 40 || text.length > 500) continue;
            if (text === title) continue;
            if (text.includes('\\u203A')) continue;
            if (/https?:\\/\\//i.test(text.slice(0, 60))) continue;
            snippet = text;
            break;
          }

          rows.push({
            position: rows.length + 1,
            title,
            url: href,
            host: toHost(href),
            snippet,
          });
          if (rows.length >= ${limit}) break;
        }

        return {
          rows,
          searchVolume: parseSearchVolume(),
          sourceUrl: location.href,
        };
      })()
    `;
}

function buildAllintitleExtractionScript() {
    return `
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const candidates = [
          document.querySelector('#result-stats'),
          ...Array.from(document.querySelectorAll('div, span')).filter((node) => {
            const text = clean(node.textContent);
            return /results?/i.test(text) && /\\d/.test(text);
          }).slice(0, 5),
        ].filter(Boolean);

        for (const node of candidates) {
          const text = clean(node.textContent);
          const matches = text.match(/\\d{1,3}(?:,\\d{3})+|\\d+/g) || [];
          const values = matches
            .map((value) => Number(value.replace(/,/g, '')))
            .filter((value) => Number.isFinite(value) && value >= 0);
          if (values.length) {
            return {
              count: Math.max(...values),
              statsText: text,
              sourceUrl: location.href,
            };
          }
        }

        return {
          count: null,
          statsText: '',
          sourceUrl: location.href,
        };
      })()
    `;
}

function enrichSerpResults(rows, openPageRankScores = new Map()) {
    return (Array.isArray(rows) ? rows : []).map((row, index) => {
        const openPageRank = openPageRankScores.get(normalizeHost(row?.host));
        const authoritySource = openPageRank ? 'openpagerank' : 'heuristic';

        return {
            position: index + 1,
            title: String(row?.title || ''),
            url: String(row?.url || ''),
            host: normalizeHost(row?.host || ''),
            snippet: String(row?.snippet || ''),
            oprRank: openPageRank?.rank ?? null,
            oprPageRankInteger: openPageRank?.pageRankInteger ?? null,
            oprPageRankDecimal: openPageRank?.pageRankDecimal ?? null,
            authoritySource,
            resultType: classifySerpResult(row),
        };
    }).filter((row) => row.title && row.url);
}

cli({
    site: 'keyword-research',
    name: 'serp_kd',
    description: 'Estimate keyword difficulty from Google SERP, allintitle, OpenPageRank, and UGC signals',
    domain: GOOGLE_DOMAIN,
    strategy: Strategy.PUBLIC,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'query', positional: true, required: true, help: 'Keyword to evaluate' },
        { name: 'country', type: 'string', default: DEFAULT_COUNTRY, help: 'Two-letter Google market code, e.g. US, GB, CA' },
        { name: 'lang', type: 'string', default: DEFAULT_LANG, help: 'Google UI language, e.g. en, zh-CN' },
        { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of natural results to analyze (max ${MAX_LIMIT})` },
        { name: 'openpagerank_key', type: 'string', help: 'Optional OpenPageRank API key. You can also set OPENPAGERANK_API_KEY, OPEN_PAGE_RANK_API_KEY, or API_OPR globally.' },
    ],
    columns: ['kd', 'kd_level', 'allintitle_count', 'search_volume', 'avg_opr_decimal', 'ugc_count', 'openpagerank_used', 'why'],
    func: async (page, kwargs) => {
        const query = requireNonEmptyQuery(kwargs.query, 'query');
        const country = normalizeCountry(kwargs.country);
        const lang = normalizeLang(kwargs.lang);
        const limit = clampInt(kwargs.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

        const sourceUrl = buildSearchUrl(query, { country, lang, limit });
        await page.goto(sourceUrl, { waitUntil: 'load', settleMs: 2500 });
        await page.wait(2);

        const serpPayload = await page.evaluate(buildSerpExtractionScript(limit));
        let openPageRankScores = new Map();
        let openPageRankUsed = false;
        const openPageRankApiKey = readOpenPageRankApiKey(kwargs);

        if (openPageRankApiKey) {
            try {
                openPageRankScores = await fetchOpenPageRankScores(
                    (Array.isArray(serpPayload?.rows) ? serpPayload.rows : []).map((row) => row?.host),
                    openPageRankApiKey,
                );
                openPageRankUsed = openPageRankScores.size > 0;
            } catch {
                openPageRankScores = new Map();
            }
        }

        const serpResults = enrichSerpResults(serpPayload?.rows, openPageRankScores);

        if (!serpResults.length) {
            throw new CliError('NOT_FOUND', 'No Google search results were extracted', 'Try a different keyword or check whether Google showed a CAPTCHA or empty page');
        }

        const allintitleUrl = buildSearchUrl(query, { country, lang, allintitle: true });
        await page.goto(allintitleUrl, { waitUntil: 'load', settleMs: 2500 });
        await page.wait(2);

        const allintitlePayload = await page.evaluate(buildAllintitleExtractionScript());
        const allintitleCount = toNonNegativeNumber(allintitlePayload?.count);
        if (allintitleCount === null) {
            throw new CliError(
                'ALLINTITLE_PARSE',
                'Could not parse the allintitle result count from Google',
                'Retry the command or check whether Google changed the result stats layout',
            );
        }

        const report = analyzeKdReport({
            query,
            country,
            lang,
            allintitleCount,
            searchVolume: serpPayload?.searchVolume,
            serpResults,
            openPageRankUsed,
            sourceUrl: serpPayload?.sourceUrl || sourceUrl,
            allintitleUrl: allintitlePayload?.sourceUrl || allintitleUrl,
        });

        return [report];
    },
});
