import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    analyzeKdReport,
    classifySerpResult,
    computeWeightedAverageOprDecimal,
    fetchOpenPageRankScores,
    scoreAllintitleKD,
    scoreSerpAuthorityKD,
    scoreUgcRelief,
    toKdLevel,
} from './SERP_kd.js';

describe('keyword-research serp_kd adapter', () => {
    const command = getRegistry().get('keyword-research/serp_kd');
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        } else {
            delete globalThis.fetch;
        }
    });

    it('registers as a public browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('keyword-research');
        expect(command.strategy).toBe('public');
        expect(command.browser).toBe(true);
    });

    it('rejects empty queries before browser navigation', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { query: '   ' })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('scores allintitle by ratio when search volume is available', () => {
        expect(scoreAllintitleKD({ allintitleCount: 50, searchVolume: 1500 })).toBe(0);
        expect(scoreAllintitleKD({ allintitleCount: 300, searchVolume: 1500 })).toBe(24);
        expect(scoreAllintitleKD({ allintitleCount: 1000, searchVolume: 1200 })).toBe(45);
        expect(scoreAllintitleKD({ allintitleCount: 1000, searchVolume: 300 })).toBe(45);
        expect(scoreAllintitleKD({ allintitleCount: 161, searchVolume: 3600 })).toBe(10);
    });

    it('scores allintitle by count when search volume is unavailable', () => {
        expect(scoreAllintitleKD({ allintitleCount: 40, searchVolume: null })).toBe(0);
        expect(scoreAllintitleKD({ allintitleCount: 180, searchVolume: null })).toBe(10);
        expect(scoreAllintitleKD({ allintitleCount: 500, searchVolume: null })).toBe(12);
        expect(scoreAllintitleKD({ allintitleCount: 900, searchVolume: null })).toBe(17);
        expect(scoreAllintitleKD({ allintitleCount: 3200, searchVolume: null })).toBe(23);
        expect(scoreAllintitleKD({ allintitleCount: 7000, searchVolume: null })).toBe(28);
        expect(scoreAllintitleKD({ allintitleCount: 60000, searchVolume: null })).toBe(37);
        expect(scoreAllintitleKD({ allintitleCount: 500000, searchVolume: null })).toBe(40);
        expect(scoreAllintitleKD({ allintitleCount: 2000000, searchVolume: null })).toBe(45);
    });

    it('computes weighted average opr decimal with ranking weights', () => {
        const avg = computeWeightedAverageOprDecimal([
            { oprPageRankDecimal: 7.8 },
            { oprPageRankDecimal: 6.0 },
            { oprPageRankDecimal: 5.0 },
        ]);
        expect(avg).toBe(6.37);
    });

    it('computes weighted average with partial result sets', () => {
        const avg = computeWeightedAverageOprDecimal([
            { oprPageRankDecimal: 4.0 },
            { oprPageRankDecimal: 3.0 },
        ]);
        expect(avg).toBe(3.53);
    });

    it('maps weighted average opr decimal into high-pressure authority bands', () => {
        expect(scoreSerpAuthorityKD({ avgOprDecimal: null })).toBe(5);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 1.9 })).toBe(5);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 2.0 })).toBe(14);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 2.5 })).toBe(19);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 3.0 })).toBe(24);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 3.5 })).toBe(30);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 4.0 })).toBe(35);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 4.5 })).toBe(40);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 5.0 })).toBe(44);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 5.5 })).toBe(50);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 6.0 })).toBe(55);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 6.5 })).toBe(55);
        expect(scoreSerpAuthorityKD({ avgOprDecimal: 7.0 })).toBe(55);

        expect(scoreUgcRelief({ ugcCount: 0 })).toBe(0);
        expect(scoreUgcRelief({ ugcCount: 1 })).toBe(-8);
        expect(scoreUgcRelief({ ugcCount: 2 })).toBe(-14);
        expect(scoreUgcRelief({ ugcCount: 3 })).toBe(-20);

        expect(toKdLevel(10)).toBe('very_easy');
        expect(toKdLevel(35)).toBe('easy');
        expect(toKdLevel(55)).toBe('medium');
        expect(toKdLevel(75)).toBe('hard');
        expect(toKdLevel(90)).toBe('very_hard');
    });

    it('classifies ugc-style result types', () => {
        expect(classifySerpResult({ host: 'reddit.com', title: 'Best SEO tools : r/SEO', snippet: '', url: 'https://reddit.com/r/SEO' })).toBe('ugc');
        expect(classifySerpResult({ host: 'example.com', title: 'Forum thread about SEO', snippet: 'community answers', url: 'https://example.com/forum/thread-1' })).toBe('forum');
    });

    it('fetches OpenPageRank scores for domains', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                response: [
                    {
                        domain: 'example.com',
                        rank: '4321',
                        page_rank_integer: 6,
                        page_rank_decimal: 5.4,
                        status_code: 200,
                        error: '',
                    },
                ],
            }),
        });

        const scores = await fetchOpenPageRankScores(['www.example.com'], 'test-key', fetchMock);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain('domains%5B%5D=example.com');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            headers: {
                'API-OPR': 'test-key',
                Accept: 'application/json',
            },
        });
        expect(scores.get('example.com')).toMatchObject({
            rank: 4321,
            pageRankInteger: 6,
            pageRankDecimal: 5.4,
        });
    });

    it('builds a KD report from weighted average authority and ugc relief', () => {
        const report = analyzeKdReport({
            query: 'surfer seo',
            country: 'US',
            lang: 'en',
            allintitleCount: 120,
            searchVolume: 2400,
            openPageRankUsed: true,
            sourceUrl: 'https://www.google.com/search?q=surfer+seo',
            allintitleUrl: 'https://www.google.com/search?q=allintitle%3A%22surfer+seo%22',
            serpResults: [
                { position: 1, title: 'Wikipedia', url: 'https://wikipedia.org/wiki/Surfer_SEO', host: 'wikipedia.org', snippet: '', authoritySource: 'openpagerank', oprPageRankDecimal: 7.8, oprPageRankInteger: 8, resultType: 'unknown' },
                { position: 2, title: 'Forbes review', url: 'https://forbes.com/surfer-seo', host: 'forbes.com', snippet: '', authoritySource: 'openpagerank', oprPageRankDecimal: 6.4, oprPageRankInteger: 7, resultType: 'unknown' },
                { position: 3, title: 'Reddit thread', url: 'https://reddit.com/r/SEO/comments/1', host: 'reddit.com', snippet: '', authoritySource: 'openpagerank', oprPageRankDecimal: 5.2, oprPageRankInteger: 6, resultType: 'ugc' },
            ],
        });

        expect(report.kd).toBe(50);
        expect(report.kd_level).toBe('easy');
        expect(report.avg_opr_decimal).toBe(6.54);
        expect(report.ugc_count).toBe(1);
        expect(report.search_volume_source).toBe('keyword_surfer');
        expect(report.openpagerank_used).toBe(true);
        expect(report.why).toContain('page one is dominated by high-authority domains');
    });

    it('uses low weighted authority when opr data is missing', () => {
        const report = analyzeKdReport({
            query: 'best seo checker',
            country: 'US',
            lang: 'en',
            allintitleCount: 6200,
            searchVolume: null,
            openPageRankUsed: false,
            sourceUrl: 'https://www.google.com/search?q=best+seo+checker',
            allintitleUrl: 'https://www.google.com/search?q=allintitle%3A%22best+seo+checker%22',
            serpResults: [
                { position: 1, title: 'Amazon listing', url: 'https://amazon.com/item', host: 'amazon.com', snippet: '', authoritySource: 'heuristic', oprPageRankDecimal: null, resultType: 'unknown' },
                { position: 2, title: 'Wikipedia article', url: 'https://wikipedia.org/wiki/Test', host: 'wikipedia.org', snippet: '', authoritySource: 'heuristic', oprPageRankDecimal: null, resultType: 'unknown' },
                { position: 3, title: 'Reddit discussion', url: 'https://reddit.com/r/SEO/1', host: 'reddit.com', snippet: '', authoritySource: 'heuristic', oprPageRankDecimal: null, resultType: 'ugc' },
            ],
        });

        expect(report.kd).toBe(31);
        expect(report.kd_level).toBe('easy');
        expect(report.avg_opr_decimal).toBeNull();
        expect(report.ugc_count).toBe(1);
        expect(report.why).toContain('authority source: free domain heuristics');
    });

    it('uses OpenPageRank when an API key is provided', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                response: [
                    {
                        domain: 'example.com',
                        rank: '42',
                        page_rank_integer: 8,
                        page_rank_decimal: 7.8,
                        status_code: 200,
                        error: '',
                    },
                ],
            }),
        });

        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({
                    sourceUrl: 'https://www.google.com/search?q=surfer+seo&gl=US&hl=en&num=10',
                    searchVolume: null,
                    rows: [
                        { position: 1, title: 'Example', url: 'https://example.com/post', host: 'example.com', snippet: 'Snippet' },
                    ],
                })
                .mockResolvedValueOnce({
                    count: 120,
                    sourceUrl: 'https://www.google.com/search?q=allintitle%3A%22surfer+seo%22&gl=US&hl=en',
                }),
        };

        const rows = await command.func(page, { query: 'surfer seo', openpagerank_key: 'test-key' });

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(rows[0]).toMatchObject({
            openpagerank_used: true,
            avg_opr_decimal: 7.8,
            kd: 73,
            kd_level: 'medium',
        });
        expect(rows[0].why).toContain('authority source: OpenPageRank');
        expect(rows[0].serp_results[0]).toMatchObject({
            authority_source: 'openpagerank',
            opr_rank: 42,
            opr_page_rank_integer: 8,
            opr_page_rank_decimal: 7.8,
        });
    });

    it('executes the command end-to-end from browser payloads', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({
                    sourceUrl: 'https://www.google.com/search?q=surfer+seo&gl=US&hl=en&num=10',
                    searchVolume: 2400,
                    rows: [
                        { position: 1, title: 'Wikipedia', url: 'https://wikipedia.org/wiki/Surfer_SEO', host: 'wikipedia.org', snippet: 'Reference' },
                        { position: 2, title: 'Reddit thread', url: 'https://reddit.com/r/SEO/comments/1', host: 'reddit.com', snippet: 'Discussion' },
                    ],
                })
                .mockResolvedValueOnce({
                    count: 120,
                    sourceUrl: 'https://www.google.com/search?q=allintitle%3A%22surfer+seo%22&gl=US&hl=en',
                }),
        };

        const rows = await command.func(page, { query: 'surfer seo' });

        expect(page.goto).toHaveBeenNthCalledWith(
            1,
            'https://www.google.com/search?q=surfer+seo&gl=US&hl=en&num=10',
            { waitUntil: 'load', settleMs: 2500 },
        );
        expect(page.goto).toHaveBeenNthCalledWith(
            2,
            'https://www.google.com/search?q=allintitle%3A%22surfer+seo%22&gl=US&hl=en',
            { waitUntil: 'load', settleMs: 2500 },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            query: 'surfer seo',
            kd: 0,
            kd_level: 'very_easy',
            allintitle_count: 120,
            search_volume: 2400,
            avg_opr_decimal: null,
            ugc_count: 1,
            openpagerank_used: false,
        });
    });

    it('fails clearly when allintitle parsing returns no count', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({
                    sourceUrl: 'https://www.google.com/search?q=surfer+seo&gl=US&hl=en&num=10',
                    searchVolume: null,
                    rows: [
                        { position: 1, title: 'Example', url: 'https://example.com/post', host: 'example.com', snippet: 'Snippet' },
                    ],
                })
                .mockResolvedValueOnce({
                    count: null,
                    sourceUrl: 'https://www.google.com/search?q=allintitle%3A%22surfer+seo%22&gl=US&hl=en',
                }),
        };

        await expect(command.func(page, { query: 'surfer seo' })).rejects.toMatchObject({
            name: 'CliError',
            code: 'ALLINTITLE_PARSE',
        });
    });
});
