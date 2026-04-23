import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './long-tail.js';

describe('keywords-surfer long-tail adapter', () => {
    const command = getRegistry().get('keywords-surfer/long-tail');

    it('registers as a public browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('keywords-surfer');
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

    it('maps Keyword Surfer long-tail rows from the sidebar payload', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue({
                state: 'ok',
                sourceUrl: 'https://www.google.com/search?q=surfer%20seo',
                rows: [
                    { rank: 1, keyword: 'surfer seo review', overlap: '35%', search_volume: '5400', url: 'https://www.google.com/search?q=surfer+seo+review' },
                    { rank: 2, keyword: 'surfer seo pricing', overlap: '30%', search_volume: '1900', url: 'https://www.google.com/search?q=surfer+seo+pricing' },
                ],
            }),
        };

        const result = await command.func(page, { query: 'surfer seo', limit: 2 });

        expect(page.goto).toHaveBeenCalledWith(
            'https://www.google.com/search?q=surfer+seo',
            { waitUntil: 'load', settleMs: 2500 },
        );
        expect(page.wait).toHaveBeenCalledWith({ selector: 'keyword-surfer-sidebar', timeout: 15 });
        expect(result).toEqual([
            {
                rank: 1,
                keyword: 'surfer seo review',
                search_volume: '5400',
                overlap: '35%',
                url: 'https://www.google.com/search?q=surfer+seo+review',
                query: 'surfer seo',
                source_url: 'https://www.google.com/search?q=surfer%20seo',
            },
            {
                rank: 2,
                keyword: 'surfer seo pricing',
                search_volume: '1900',
                overlap: '30%',
                url: 'https://www.google.com/search?q=surfer+seo+pricing',
                query: 'surfer seo',
                source_url: 'https://www.google.com/search?q=surfer%20seo',
            },
        ]);
    });

    it('surfaces a clear error when the extension sidebar is unavailable', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockRejectedValue(new Error('timeout')),
            evaluate: vi.fn(),
        };

        await expect(command.func(page, { query: 'surfer seo' })).rejects.toMatchObject({
            name: 'CliError',
            code: 'EXTENSION_MISSING',
        });
        expect(page.evaluate).not.toHaveBeenCalled();
    });
});
