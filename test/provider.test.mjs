import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_ID,
  YuanbaoSearchProvider,
  apply,
  formatToolResult,
  mapResponse,
  resolveOptions,
  snapCnt,
  toIsoDate,
  cleanText,
} from '../lib/index.js';

const PAGE_A = JSON.stringify({
  title: '三星堆名字的由来<strong>你真的了解吗</strong>',
  url: 'https://www.163.com/dy/article/J43Q2STU0553FV3Z.html',
  date: '2024-06-07 19:00:51',
  passage: '三星堆遗址位于四川省广汉市西北部&nbsp;鸭子河南岸',
  content: '三星堆名字的由来 三星堆遗址位于四川省广汉市西北部',
  site: '网易',
  score: 0.897802,
});
const PAGE_B = JSON.stringify({
  title: '三星堆 - 维基百科',
  url: 'https://zh.wikipedia.org/wiki/%E4%B8%89%E6%98%9F%E5%A0%86',
  date: '2025/02/26 09:37:00',
  passage: '三星堆遗址是一处青铜时代文化遗址',
  score: 0.8887853,
});
const PAGE_A_DUP = JSON.stringify({
  title: '重复项',
  url: 'https://www.163.com/dy/article/J43Q2STU0553FV3Z.html',
  passage: 'dup',
});
const PAGE_BROKEN = '{"title": "坏数据"';

const OK_BODY = {
  Response: {
    Pages: [PAGE_A, PAGE_B, PAGE_A_DUP, PAGE_BROKEN],
    Query: '三星堆的由来',
    Version: 'standard',
    RequestId: '6f8df221-9a68-4ea2-90d6-a9590cae244c',
  },
};

/** 一个够用的 ctx 桩：记录 provider 与工具注册。 */
function fakeCtx() {
  const providers = [];
  const toolDefs = [];
  return {
    providers,
    toolDefs,
    get: () => void 0,
    web: { registerSearchProvider: (provider) => providers.push(provider) },
    tools: { register: (definition) => toolDefs.push(definition) },
  };
}

function makeProvider(config, ctx = fakeCtx()) {
  apply(ctx, config);
  return { provider: ctx.providers[0], ctx };
}

/** 记录每次 fetch 的桩。 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.at(-1), calls.length);
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('snapCnt 只返回服务端允许的五档', () => {
  assert.equal(snapCnt(void 0), 10);
  assert.equal(snapCnt(8), 10);
  assert.equal(snapCnt(11), 20);
  assert.equal(snapCnt(100), 50);
});

test('cleanText / toIsoDate 归一化', () => {
  assert.equal(cleanText('<strong>你好</strong>\n  世界&nbsp;!'), '你好 世界 !');
  assert.equal(toIsoDate('2024-06-07 19:00:51'), '2024-06-07T19:00:51');
  assert.equal(toIsoDate('2025/02/26 09:37:00'), '2025-02-26T09:37:00');
  assert.equal(toIsoDate('昨天'), void 0);
});

test('mapResponse 二次解析 Pages、去重、清洗摘要', () => {
  const result = mapResponse(OK_BODY);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources[0], {
    url: 'https://www.163.com/dy/article/J43Q2STU0553FV3Z.html',
    title: '三星堆名字的由来 你真的了解吗',
    snippet: '三星堆名字的由来 三星堆遗址位于四川省广汉市西北部',
    publishedAt: '2024-06-07T19:00:51',
  });
});

test('apply 注册 provider 与 yuanbao_search 工具', () => {
  const { provider, ctx } = makeProvider({ apiKey: 'sk-test' });
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(ctx.toolDefs.length, 1);
  assert.equal(ctx.toolDefs[0].name, 'yuanbao_search');

  const off = fakeCtx();
  apply(off, { apiKey: 'sk-test', exposeTool: false });
  assert.equal(off.toolDefs.length, 0);
  assert.equal(off.providers.length, 1);
});

test('resolveOptions 兼容 volatile 访问器与非法枚举', () => {
  const volatile = (value) => ({ get: () => value });
  const options = resolveOptions({
    apiKey: volatile('sk-x'),
    apiKeyEnv: volatile('MY_KEY'),
    version: volatile('lite'),
    industry: volatile('bogus'),
    freshness: volatile('not-a-range'),
    mode: volatile(9),
    timeoutMs: volatile(5000),
    exposeTool: volatile(false),
  });
  assert.equal(options.apiKey, 'sk-x');
  assert.equal(options.version, 'lite');
  assert.equal(options.industry, void 0);
  assert.equal(options.freshness, void 0);
  assert.equal(options.mode, void 0);
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.exposeTool, false);
});

test('seam search 发出 Cnt=10 并把结果归一化', async () => {
  const calls = stubFetch(() => jsonResponse(OK_BODY));
  const { provider } = makeProvider({ apiKey: 'sk-test', freshness: 'y2' });
  const result = await provider.search({ query: '三星堆的由来', maxResults: 8 });
  assert.deepEqual(calls[0].body, { Query: '三星堆的由来', Cnt: 10, Freshness: 'y2' });
  assert.equal(result.sources.length, 2);
  assert.equal(provider.detectedVersion, 'standard');
});

test('极速版配置：不下发高级参数，并回报 dropped', async () => {
  const calls = stubFetch(() => jsonResponse(OK_BODY));
  const { provider } = makeProvider({ apiKey: 'sk-test', version: 'lite' });
  const outcome = await provider.searchAdvanced(
    { query: 'q', count: 50, freshness: 'y1', industry: 'news', mode: 1, site: 'zhihu.com' },
  );
  assert.deepEqual(calls[0].body, { Query: 'q', Site: 'zhihu.com' });
  assert.deepEqual(outcome.dropped.sort(), ['cnt', 'freshness', 'industry', 'mode']);
  assert.equal(outcome.version, 'lite');
});

test('版本未知时收到 InvalidParameter 会自动降级并记住 lite', async () => {
  const calls = stubFetch((call) => {
    if ('Cnt' in call.body) return jsonResponse({ Response: { Error: { Code: 'InvalidParameter' } } });
    return jsonResponse({ Response: { ...OK_BODY.Response, Version: 'lite' } });
  });
  const { provider } = makeProvider({ apiKey: 'sk-test' });
  const outcome = await provider.searchAdvanced({ query: 'q', freshness: 'y1' });
  assert.equal(provider.detectedVersion, 'lite');
  assert.deepEqual(calls[1].body, { Query: 'q' });
  assert.deepEqual(outcome.dropped.sort(), ['cnt', 'freshness']);
  assert.equal(outcome.result.sources.length, 2);
});

test('服务端自报极速版时，即使不报错也列出未生效的参数', async () => {
  stubFetch(() => jsonResponse({ Response: { ...OK_BODY.Response, Version: 'lite' } }));
  const { provider } = makeProvider({ apiKey: 'sk-test' });
  const outcome = await provider.searchAdvanced({ query: 'q', count: 20, freshness: 'd3' });
  assert.equal(outcome.version, 'lite');
  assert.deepEqual(outcome.dropped.sort(), ['cnt', 'freshness']);
  assert.equal(outcome.result.sources.length, 2);
});

test('工具：模型按次覆盖参数，site 直通', async () => {
  const calls = stubFetch(() => jsonResponse(OK_BODY));
  const { ctx } = makeProvider({ apiKey: 'sk-test', industry: 'acad' });
  const tool = ctx.toolDefs[0];
  const text = await tool.execute(
    { query: '三星堆', count: 20, site: 'zhihu.com' },
    { signal: void 0 },
  );
  assert.deepEqual(calls[0].body, { Query: '三星堆', Cnt: 20, Site: 'zhihu.com', Industry: 'acad' });
  assert.match(text, /元宝搜索「三星堆」（标准版，2 条）/u);
  assert.match(text, /1\. 三星堆名字的由来/u);
});

test('formatToolResult 明示被忽略的参数', () => {
  const text = formatToolResult('q', 'lite', { sources: [], truncated: false }, ['cnt', 'freshness']);
  assert.match(text, /极速版，0 条/u);
  assert.match(text, /已忽略极速版不支持的 count（条数）、freshness（时效）/u);
});

test('服务端 Error.Code 映射成 seam 的开放 code', async () => {
  stubFetch(() => jsonResponse({ Response: { Error: { Code: 'UnauthorizedOperation', Message: 'auth failed' } } }));
  const { provider } = makeProvider({ apiKey: 'sk-test' });
  await assert.rejects(provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_UNAUTHORIZED');
    return true;
  });
});

test('RequestLimitExceeded → WEB_PROVIDER_RATE_LIMITED', async () => {
  stubFetch(() => jsonResponse({ Response: { Error: { Code: 'RequestLimitExceeded' } } }));
  const { provider } = makeProvider({ apiKey: 'sk-test' });
  await assert.rejects(provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_RATE_LIMITED');
    return true;
  });
});

test('缺密钥抛 WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  stubFetch(() => jsonResponse(OK_BODY));
  const { provider } = makeProvider({ apiKeyEnv: 'TENCENTCLOUD_WSA_APIKEY_UNSET_FOR_TEST' });
  await assert.rejects(provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
    return true;
  });
});

test('从进程环境变量读密钥', async () => {
  process.env.YUANBAO_TEST_KEY = 'sk-from-env';
  const calls = stubFetch(() => jsonResponse(OK_BODY));
  const { provider } = makeProvider({ apiKeyEnv: 'YUANBAO_TEST_KEY' });
  await provider.search({ query: 'q' });
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-from-env');
  delete process.env.YUANBAO_TEST_KEY;
});

test('取消信号映射为 WEB_ABORTED', async () => {
  const { provider } = makeProvider({ apiKey: 'sk-test' });
  globalThis.fetch = async (_url, init) => {
    init.signal.throwIfAborted();
    throw new DOMException('aborted', 'AbortError');
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.search({ query: 'q' }, controller.signal), (error) => {
    assert.equal(error.code, 'WEB_ABORTED');
    return true;
  });
});
