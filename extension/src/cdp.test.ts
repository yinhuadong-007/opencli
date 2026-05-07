import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createChromeMock() {
  const debuggerEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabs = {
    get: vi.fn(async (_tabId: number) => ({
      id: 1,
      windowId: 1,
      url: 'https://x.com/home',
    })),
    onRemoved: { addListener: vi.fn((fn: (tabId: number) => void) => { tabRemovedListeners.push(fn); }) },
    onUpdated: { addListener: vi.fn() },
  };

  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn((fn: (source: { tabId?: number }, method: string, params: any) => void) => { debuggerEventListeners.push(fn); }) },
  };

  const scripting = {
    executeScript: vi.fn(async () => [{ result: { removed: 1 } }]),
  };

  return {
    chrome: {
      tabs,
      debugger: debuggerApi,
      scripting,
      runtime: { id: 'opencli-test' },
    },
    debuggerApi,
    scripting,
    debuggerEventListeners,
    tabRemovedListeners,
  };
}

describe('cdp attach recovery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not mutate the DOM before a successful attach', async () => {
    const { chrome, debuggerApi, scripting } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.evaluate(1, '1');

    expect(result).toBe('ok');
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it('uses the default execution context for a frame when isolated worlds also exist', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerFrameTracking();

    expect(debuggerEventListeners).toHaveLength(1);
    debuggerEventListeners[0](
      { tabId: 1 },
      'Runtime.executionContextCreated',
      { context: { id: 11, auxData: { frameId: 'frame-1', isDefault: false } } },
    );
    debuggerEventListeners[0](
      { tabId: 1 },
      'Runtime.executionContextCreated',
      { context: { id: 22, auxData: { frameId: 'frame-1', isDefault: true } } },
    );

    await mod.evaluateInFrame(1, 'document.title', 'frame-1');

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 22 }),
    );
  });

  it('keeps pending capture entries across read until loadingFinished arrives', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1, 'api');

    expect(debuggerEventListeners).toHaveLength(1);
    const onEvent = debuggerEventListeners[0];
    onEvent(
      { tabId: 1 },
      'Network.requestWillBeSent',
      { requestId: 'r1', request: { url: 'https://example.com/api', method: 'GET', headers: {} } },
    );
    onEvent(
      { tabId: 1 },
      'Network.responseReceived',
      { requestId: 'r1', response: { url: 'https://example.com/api', status: 200, mimeType: 'application/json', headers: {} } },
    );

    await expect(mod.readNetworkCapture(1)).resolves.toEqual([]);

    onEvent(
      { tabId: 1 },
      'Network.loadingFinished',
      { requestId: 'r1' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = await mod.readNetworkCapture(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({
      url: 'https://example.com/api',
      responseStatus: 200,
    }));
  });

  it('returns done-no-body entry when getResponseBody fails after loadingFinished', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    debuggerApi.sendCommand = vi.fn(async (_target: unknown, method: string, params?: any) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      if (method === 'Network.getResponseBody' && params?.requestId === 'r2') throw new Error('no body');
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1, 'api');
    const onEvent = debuggerEventListeners[0];

    onEvent(
      { tabId: 1 },
      'Network.requestWillBeSent',
      { requestId: 'r2', request: { url: 'https://example.com/api2', method: 'POST', headers: {} } },
    );
    onEvent(
      { tabId: 1 },
      'Network.responseReceived',
      { requestId: 'r2', response: { url: 'https://example.com/api2', status: 204, mimeType: 'text/plain', headers: {} } },
    );
    onEvent(
      { tabId: 1 },
      'Network.loadingFinished',
      { requestId: 'r2' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = await mod.readNetworkCapture(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({
      url: 'https://example.com/api2',
      responseStatus: 204,
    }));
    await expect(mod.readNetworkCapture(1)).resolves.toEqual([]);
  });

  it('returns done-no-body entry on loadingFailed', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1, 'api');
    const onEvent = debuggerEventListeners[0];

    onEvent(
      { tabId: 1 },
      'Network.requestWillBeSent',
      { requestId: 'r3', request: { url: 'https://example.com/api3', method: 'GET', headers: {} } },
    );
    onEvent(
      { tabId: 1 },
      'Network.responseReceived',
      { requestId: 'r3', response: { url: 'https://example.com/api3', status: 502, mimeType: 'text/plain', headers: {} } },
    );
    onEvent(
      { tabId: 1 },
      'Network.loadingFailed',
      { requestId: 'r3' },
    );

    const entries = await mod.readNetworkCapture(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({
      url: 'https://example.com/api3',
      responseStatus: 502,
    }));
  });

});
