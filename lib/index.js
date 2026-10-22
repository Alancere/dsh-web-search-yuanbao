/**
 * 元宝搜索（腾讯云 SearchPro）→ DeepSeek Harness 的搜索能力。
 *
 * 两条对外通道，共用同一个请求核心：
 *  1. `ctx.web` 搜索 provider —— 承接内置 `web_search` 工具，无感替换搜索后端；
 *  2. `yuanbao_search` 工具 —— 把元宝专有参数（count/freshness/industry/site/mode）
 *     暴露给模型，让它按需决定；极速版不支持的参数会被自动剔除并在结果里说明。
 *
 * 配置走 `Config`（schemastery + volatile），因此 Harness 设置页能自动生成表单，
 * 改完即时生效（与内置 provider 同一套机制）。
 *
 * 依赖注记：`schemastery` 用顶层动态 import 探测——插件以 link 方式挂在 workspace 里
 * 时解析不到 profile 提升上来的副本，此时降级为「无 schema 的普通配置」，插件仍可用；
 * 以 tarball/npm 方式装进 profile 时能解析到，设置页表单随之出现。
 *
 * @module dsh-web-search-yuanbao
 */
const z = await (async () => {
  try {
    return (await import('@deepseek-ai/schemastery')).default;
  } catch {
    return null;
  }
})();

/** 本 provider 在 ctx.web 搜索注册表中的稳定 id。 */
export const PROVIDER_ID = 'yuanbao';

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'web-search-yuanbao';

/** 依赖的服务：web seam 与工具注册表。 */
export const inject = ['web', 'tools'];

const DEFAULT_ENDPOINT = 'https://api.wsa.cloud.tencent.com/SearchPro';
const DEFAULT_API_KEY_ENV = 'TENCENTCLOUD_WSA_APIKEY';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SNIPPET_CHARS = 500;

/** `Cnt` 的合法枚举：服务端只接受这五档。 */
const CNT_LEVELS = [10, 20, 30, 40, 50];

/** `Industry` 的合法取值。 */
const INDUSTRIES = ['gov', 'news', 'acad', 'finance'];

/** `Mode` 的合法取值：0 公开网页 / 1 权威垂直信源 / 2 混合。 */
const MODES = [0, 1, 2];

/** `Freshness` 的五种互斥形态。 */
const FRESHNESS_PATTERN =
  /^(?:d(?:[1-9]|[12]\d|30)?|m(?:[1-9]|1[0-2])?|y(?:[1-5])?|\d{4}-\d{2}-\d{2}(?:,\d{4}-\d{2}-\d{2})?)$/u;

/**
 * 版本能力矩阵。极速版只接受 `Query`；标准版放开 Mode/Cnt/Industry/Freshness；
 * 旗舰版在此之上多返回 authority_level 与 deeplinks。
 */
const VERSION_CAPS = {
  lite: { cnt: false, mode: false, industry: false, freshness: false },
  standard: { cnt: true, mode: true, industry: true, freshness: true },
  flagship: { cnt: true, mode: true, industry: true, freshness: true },
  // 版本未知时先按「乐观」发全参数，命中 InvalidParameter 再自动降级。
  unknown: { cnt: true, mode: true, industry: true, freshness: true },
};

/** 参数名 → 中文标签，用于告诉模型哪些参数被丢弃。 */
const FIELD_LABELS = {
  cnt: 'count（条数）',
  mode: 'mode（结果类型）',
  industry: 'industry（垂直领域）',
  freshness: 'freshness（时效）',
  site: 'site（站点过滤）',
  deeplinks: 'deeplinks（子链）',
};

/** 带可机器路由 `code` 的 provider 错误（形状对齐 HarnessError）。 */
export class YuanbaoWebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'YuanbaoWebError';
    this.code = code;
  }
}

/** 读一个配置字段：兼容 schemastery 的 volatile 访问器与普通值。 */
function readField(config, key, fallback) {
  const holder = config?.[key];
  const value = typeof holder?.get === 'function' ? holder.get() : holder;
  return value === void 0 || value === null ? fallback : value;
}

/**
 * 把插件 config 规整成带默认值的快照。
 * @param {any} config - cordis 传入的插件配置。
 * @returns {any} provider 与工具共用的选项。
 */
export function resolveOptions(config) {
  const positive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const optionalText = (key) => {
    const value = readField(config, key, void 0);
    return typeof value === 'string' && value.length > 0 ? value : void 0;
  };
  const mode = readField(config, 'mode', void 0);
  const industry = optionalText('industry');
  const freshness = optionalText('freshness');

  return {
    apiKey: optionalText('apiKey') ?? '',
    apiKeyEnv: optionalText('apiKeyEnv') ?? DEFAULT_API_KEY_ENV,
    endpoint: optionalText('endpoint') ?? DEFAULT_ENDPOINT,
    version: optionalText('version') ?? 'auto',
    timeoutMs: positive(readField(config, 'timeoutMs', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
    snippetChars: positive(
      readField(config, 'snippetChars', DEFAULT_SNIPPET_CHARS),
      DEFAULT_SNIPPET_CHARS,
    ),
    mode: MODES.includes(mode) ? mode : void 0,
    site: optionalText('site'),
    industry: INDUSTRIES.includes(industry) ? industry : void 0,
    freshness: typeof freshness === 'string' && FRESHNESS_PATTERN.test(freshness) ? freshness : void 0,
    exposeTool: readField(config, 'exposeTool', true) !== false,
  };
}

/**
 * 把请求条数吸附到服务端允许的枚举档位。
 * @param {number|undefined} maxResults - 上游给的上界。
 * @returns {number} 10/20/30/40/50 之一。
 */
export function snapCnt(maxResults) {
  const wanted = Number.isFinite(maxResults) && maxResults > 0 ? Math.ceil(maxResults) : 10;
  return CNT_LEVELS.find((level) => level >= wanted) ?? CNT_LEVELS[CNT_LEVELS.length - 1];
}

/**
 * 去掉摘要里的 HTML 标签、解码常见实体并压缩空白。
 * @param {unknown} value - 原始文本。
 * @returns {string} 清洗后的单行文本。
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 把元宝的时间串转成 ISO-8601。
 * 服务端出现过的两种形态：`2024-06-07 19:00:51` 与 `2025/02/26 09:37:00`。
 * @param {unknown} value - 原始时间串。
 * @returns {string|undefined} ISO-8601，无法解析时返回 undefined。
 */
export function toIsoDate(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/u.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/**
 * 把 `Response` 归一化成 seam 的 WebSearchResult。
 * `Pages` 的每一项都是**被转义的 JSON 字符串**，必须二次解析；解析失败的项直接跳过。
 * @param {any} body - 响应体。
 * @param {{snippetChars?: number}} [options] - 摘要截断长度。
 * @returns {{sources: Array<object>, truncated: boolean, content?: string}}
 */
export function mapResponse(body, options = {}) {
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const pages = body?.Response?.Pages;
  if (!Array.isArray(pages)) return { sources: [], truncated: false };

  const seen = new Set();
  const sources = [];
  for (const page of pages) {
    let doc = page;
    if (typeof page === 'string') {
      try {
        doc = JSON.parse(page);
      } catch {
        continue;
      }
    }
    if (doc === null || typeof doc !== 'object') continue;
    const url = typeof doc.url === 'string' ? doc.url.trim() : '';
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);

    const title = cleanText(doc.title);
    const snippet = cleanText(doc.content ?? doc.passage);
    const publishedAt = toIsoDate(doc.date);
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet: snippet.slice(0, snippetChars) } : {}),
      ...(publishedAt !== void 0 ? { publishedAt } : {}),
    });
  }

  const msg = cleanText(body?.Response?.Msg);
  return {
    sources,
    truncated: false,
    ...(sources.length === 0 && msg.length > 0 ? { content: `元宝搜索无结果：${msg}` } : {}),
  };
}

/** 判断字符串是否是合法的环境变量名。 */
function isEnvName(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function abortError(signal, fallback) {
  return new YuanbaoWebError('元宝搜索请求已取消', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal);
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isTimeoutError(error) {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/** 版本标识 → 界面/结果里的中文名。 */
function versionLabel(version) {
  return { lite: '极速版', standard: '标准版', flagship: '旗舰版' }[version] ?? '未知版本';
}

/**
 * 元宝搜索 provider，同时被 `ctx.web` 与 `yuanbao_search` 工具复用。
 */
export class YuanbaoSearchProvider {
  /** @type {string} */
  id = PROVIDER_ID;

  /** 服务端自报的版本（配置为 auto 时以此为准）。 */
  detectedVersion = void 0;

  /**
   * @param {() => any} resolveOptions - 每次操作入口取一次配置快照。
   * @param {any} [ctx] - 插件上下文，用于取 credentials 服务。
   */
  constructor(resolveOptions, ctx) {
    this.resolveOptions = resolveOptions;
    this.ctx = ctx;
  }

  /**
   * 本地可用性判断，不得发起网络调用。
   * 与官方 provider 同语义：判断「密钥解析器是否接线」，真实缺失留给 search() 报错。
   * @returns {boolean}
   */
  available() {
    const options = this.resolveOptions();
    const hasKeySource = options.apiKey.length > 0 || isEnvName(options.apiKeyEnv);
    return hasKeySource && URL.canParse(options.endpoint);
  }

  /**
   * 当前生效版本与能力。
   * @param {any} options - 配置快照。
   * @returns {{version: string, caps: object}} 版本与能力位。
   */
  capabilities(options) {
    const version = options.version !== 'auto' ? options.version : this.detectedVersion;
    const key = version ?? 'unknown';
    return { version: key, caps: VERSION_CAPS[key] ?? VERSION_CAPS.unknown };
  }

  /**
   * 解析本次请求用的密钥：字面量 → credentials 服务 → 进程环境变量。
   * @param {any} options - 配置快照。
   * @param {AbortSignal|undefined} signal - 取消信号。
   * @returns {Promise<string>} 非空密钥。
   */
  async apiKey(options, signal) {
    if (options.apiKey.length > 0) return options.apiKey;

    const envName = options.apiKeyEnv;
    if (isEnvName(envName)) {
      const credentials = this.ctx?.get?.('credentials');
      if (credentials?.resolve !== void 0) {
        try {
          throwIfAborted(signal);
          const resolved = await credentials.resolve(envName);
          if (resolved?.value) return resolved.value;
        } catch (error) {
          if (signal?.aborted === true || isAbortError(error)) throw abortError(signal, error);
        }
      }
      const ambient = process.env[envName];
      if (typeof ambient === 'string' && ambient.length > 0) return ambient;
    }

    throw new YuanbaoWebError(
      `元宝搜索没有可用的 API KEY：请在设置页「元宝搜索」里填 API Key，` +
        `或把密钥写进 credentials（键名 ${envName}），或在启动环境里导出 ${envName}。`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    );
  }

  /**
   * 按能力位组装请求体，并回报被丢弃的字段。
   * @param {string} query - 搜索词。
   * @param {number} cnt - 已吸附的条数档位。
   * @param {any} options - 配置快照。
   * @param {object} caps - 能力位。
   * @returns {{body: Record<string, unknown>, dropped: string[]}} 请求体与丢弃字段。
   */
  buildBody(query, cnt, options, caps) {
    /** @type {Record<string, unknown>} */
    const body = { Query: query };
    const dropped = [];
    if (caps.cnt) body.Cnt = cnt;
    else dropped.push('cnt');

    if (options.mode !== void 0) {
      if (caps.mode) body.Mode = options.mode;
      else dropped.push('mode');
    }
    if (options.site !== void 0) body.Site = options.site;
    if (options.industry !== void 0) {
      if (caps.industry) body.Industry = options.industry;
      else dropped.push('industry');
    }
    if (options.freshness !== void 0) {
      if (caps.freshness) body.Freshness = options.freshness;
      else dropped.push('freshness');
    }
    return { body, dropped };
  }

  /**
   * seam 入口：一次搜索。
   * @param {{query: string, maxResults?: number}} request - 搜索请求。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 归一化结果。
   */
  async search(request, signal) {
    const outcome = await this.run(request.query, {}, request.maxResults, signal);
    return outcome.result;
  }

  /**
   * 工具入口：可按调用覆盖参数，并回报版本与被丢弃的字段。
   * @param {{query: string, count?: number, freshness?: string, industry?: string, site?: string, mode?: number}} request - 逐次请求。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<{result: object, dropped: string[], version: string}>} 结果与降级信息。
   */
  async searchAdvanced(request, signal) {
    return this.run(
      request.query,
      {
        count: request.count,
        freshness: request.freshness,
        industry: request.industry,
        site: request.site,
        mode: request.mode,
      },
      request.count,
      signal,
    );
  }

  /**
   * 统一的执行核心：取配置 → 解析密钥 → 组装请求 → 必要时降级重试。
   * @param {string} query - 搜索词。
   * @param {object} overrides - 逐次参数覆盖。
   * @param {number|undefined} maxResults - 条数上界。
   * @param {AbortSignal|undefined} signal - 取消信号。
   * @returns {Promise<{result: object, dropped: string[], version: string}>} 结果。
   */
  async run(query, overrides, maxResults, signal) {
    const base = this.resolveOptions();
    /** 未显式覆盖的字段沿用配置，显式覆盖的字段优先。 */
    const options = {
      ...base,
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== void 0)),
    };
    const cnt = snapCnt(overrides.count ?? maxResults);
    const key = await this.apiKey(options, signal);

    let { version, caps } = this.capabilities(options);
    let { body, dropped } = this.buildBody(query, cnt, options, caps);

    const first = await this.dispatch(body, options, key, signal, version);
    if (first.kind === 'ok') {
      this.remember(first.serverVersion);
      const effective = this.effectiveVersion(options);
      // 服务端可能不报错、直接忽略它不支持的参数（极速版实测如此），因此按最终生效版本
      // 重新结算「哪些请求参数实际没被采纳」，避免结果看起来像是生效了。
      if (VERSION_CAPS[effective] !== void 0) {
        dropped = this.buildBody(query, cnt, options, VERSION_CAPS[effective]).dropped;
      }
      return { result: first.result, dropped, version: effective };
    }

    // 极速版对高级参数一律 InvalidParameter：剥掉后重试一次并记住降级。
    if (first.retryableWithoutOptions && version !== 'lite' && Object.keys(body).length > 1) {
      this.detectedVersion = 'lite';
      caps = VERSION_CAPS.lite;
      ({ body, dropped } = this.buildBody(query, cnt, options, caps));
      const retried = await this.dispatch(body, options, key, signal, 'lite');
      if (retried.kind === 'ok') {
        return { result: retried.result, dropped, version: 'lite' };
      }
      throw retried.error;
    }
    throw first.error;
  }

  /**
   * 服务端自报版本优先，其次配置，最后是已探测值。
   * @param {any} options - 配置快照。
   * @returns {string} 版本标识。
   */
  effectiveVersion(options) {
    return options.version !== 'auto' ? options.version : (this.detectedVersion ?? 'unknown');
  }

  /** 记住服务端自报的版本。 */
  remember(serverVersion) {
    if (typeof serverVersion === 'string' && serverVersion.length > 0 && VERSION_CAPS[serverVersion]) {
      this.detectedVersion = serverVersion;
    }
  }

  /**
   * 发一次请求并分类结果。
   * @returns {Promise<{kind: 'ok', result: object, serverVersion?: string} | {kind: 'error', error: YuanbaoWebError, retryableWithoutOptions?: boolean}>}
   */
  async dispatch(body, options, key, signal, version) {
    const { endpoint, timeoutMs, snippetChars } = options;
    const timeout = AbortSignal.timeout(timeoutMs);
    const composite = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json',
          'user-agent': 'dsh-web-search-yuanbao/0.2.0',
        },
        body: JSON.stringify(body),
        signal: composite,
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortError(signal, error);
      if (isTimeoutError(error)) {
        return {
          kind: 'error',
          error: new YuanbaoWebError(
            `元宝搜索超时（${timeoutMs}ms，端点 ${endpoint}）。`,
            'WEB_PROVIDER_TIMEOUT',
            { cause: error },
          ),
        };
      }
      return {
        kind: 'error',
        error: new YuanbaoWebError(
          `元宝搜索请求失败：${String(error)}。使用的端点是 ${JSON.stringify(endpoint)}。`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        ),
      };
    }

    /** @type {any} */
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortError(signal, error);
      payload = void 0;
    }

    if (!response.ok) {
      const detail = cleanText(payload?.Response?.Error?.Message ?? payload?.Error?.Message);
      const suffix = detail.length > 0 ? `：${detail}` : '';
      return {
        kind: 'error',
        error: new YuanbaoWebError(
          `元宝搜索 HTTP ${response.status}${suffix}`,
          response.status === 401 || response.status === 403
            ? 'WEB_PROVIDER_UNAUTHORIZED'
            : 'WEB_PROVIDER_ERROR',
        ),
      };
    }

    const code = payload?.Response?.Error?.Code ?? payload?.Error?.Code;
    if (typeof code === 'string' && code.length > 0) {
      return {
        kind: 'error',
        error: this.mapServiceError(code, payload),
        retryableWithoutOptions: code === 'InvalidParameter' && version !== 'lite',
      };
    }

    return {
      kind: 'ok',
      result: mapResponse(payload, { snippetChars }),
      serverVersion: payload?.Response?.Version,
    };
  }

  /**
   * 把元宝的 `Error.Code` 映射成 seam 的开放 code。
   * @param {string} code - 服务端错误码。
   * @param {any} payload - 响应体。
   * @returns {YuanbaoWebError} 映射后的错误。
   */
  mapServiceError(code, payload) {
    const detail = cleanText(payload?.Response?.Error?.Message ?? payload?.Error?.Message);
    const suffix = detail.length > 0 ? `：${detail}` : '';
    switch (code) {
      case 'UnauthorizedOperation':
        return new YuanbaoWebError(
          `元宝搜索未授权${suffix}。检查 API Key 是否有效；子账号还需主账号授予 WSA 全读写权限。`,
          'WEB_PROVIDER_UNAUTHORIZED',
        );
      case 'ResourceNotFound':
        return new YuanbaoWebError(
          `元宝搜索服务未开通${suffix}。请到 https://console.cloud.tencent.com/wsapi/index 开通。`,
          'WEB_PROVIDER_NOT_SUBSCRIBED',
        );
      case 'ResourceUnavailable':
        return new YuanbaoWebError(
          `元宝搜索资源不可用${suffix}。检查账号是否欠费或套餐到期。`,
          'WEB_PROVIDER_UNAVAILABLE',
        );
      case 'RequestLimitExceeded':
        return new YuanbaoWebError(
          `元宝搜索触发频率限制${suffix}。稍后重试或降低调用频率。`,
          'WEB_PROVIDER_RATE_LIMITED',
        );
      case 'InvalidParameter':
        return new YuanbaoWebError(
          `元宝搜索参数错误${suffix}。极速版不支持 Mode/Cnt/Industry/Freshness。`,
          'WEB_PROVIDER_ERROR',
          { cause: new Error('invalid-parameter') },
        );
      default:
        return new YuanbaoWebError(`元宝搜索返回错误 ${code}${suffix}`, 'WEB_PROVIDER_ERROR');
    }
  }
}

/**
 * 把一次搜索结果渲染成模型可读文本。
 * @param {string} query - 原始查询词。
 * @param {string} version - 生效版本。
 * @param {object} result - 归一化结果。
 * @param {string[]} dropped - 被降级丢弃的字段。
 * @returns {string} 文本。
 */
export function formatToolResult(query, version, result, dropped) {
  const lines = [];
  const ignored = dropped.length > 0 ? `；已忽略${versionLabel(version)}不支持的 ${dropped.map((f) => FIELD_LABELS[f] ?? f).join('、')}` : '';
  lines.push(`元宝搜索「${query}」（${versionLabel(version)}，${result.sources.length} 条${ignored}）`);
  if (result.content !== void 0) lines.push(result.content);
  result.sources.forEach((source, index) => {
    const date = source.publishedAt !== void 0 ? ` · ${source.publishedAt}` : '';
    lines.push(`${index + 1}. ${source.title ?? source.url}${date}`);
    lines.push(`   ${source.url}`);
    if (source.snippet !== void 0) lines.push(`   ${source.snippet}`);
  });
  if (result.sources.length === 0 && result.content === void 0) lines.push('（无结果）');
  return lines.join('\n');
}

/**
 * 注册 `yuanbao_search` 工具：让模型自己决定用哪些元宝专有参数。
 * @param {any} ctx - 插件上下文。
 * @param {YuanbaoSearchProvider} provider - 复用的 provider。
 */
function applyTool(ctx, provider) {
  /**
   * 手写 ToolDefinition 而不是用 `defineTool`：`@deepseek-ai/dsh-tools` 在 profile 里
   * 不可解析（它的 dsh-llm 等同伴只在 dsh 安装内部），而 ToolDefinition 本身就是
   * `{ name, description, parameters(JSON Schema), output, execute }` 的普通对象。
   */
  ctx.tools.register({
    name: 'yuanbao_search',
    description: [
      '腾讯元宝搜索（SearchPro）：中文/国内信源优先，支持权威垂直领域与时效过滤。',
      `count 只能取 ${CNT_LEVELS.join('/')}；industry 取 ${INDUSTRIES.join('/')}；`,
      'freshness 取 d7、m3、y1 或 2026-08-20 或 2026-08-20,2026-08-30；',
      'site 只能指定 1 个域名，或用 exclude:a.com|b.com 排除最多 5 个；mode 取 0 网页 / 1 权威垂直信源 / 2 混合。',
      '注意：元宝极速版不支持 count/freshness/industry/site/mode，此时会被自动忽略，并在结果首行注明。',
      '需要核实最新事实、政策法规或国内站点内容时优先用它；查项目内代码请用代码检索工具。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，1~128 字符' },
        count: { type: 'integer', enum: CNT_LEVELS, description: '返回条数，仅支持 10/20/30/40/50' },
        freshness: {
          type: 'string',
          description: '时效范围，如 d7 / m3 / y1 / 2026-08-20 / 2026-08-20,2026-08-30',
        },
        industry: { type: 'string', enum: INDUSTRIES, description: '垂直领域' },
        site: { type: 'string', description: '单域名，如 zhihu.com；或 exclude:qq.com|sohu.com' },
        mode: { type: 'integer', enum: MODES, description: '0 公开网页（默认）/ 1 权威垂直信源 / 2 混合' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const { result, dropped, version } = await provider.searchAdvanced(args, exec?.signal);
      return formatToolResult(args.query, version, result, dropped);
    },
  });
}

/**
 * 插件配置。字段全部 volatile：设置页改完即时生效，不需要重挂插件。
 * 解析不到 schemastery 时（link 开发态）为 undefined——此时插件按纯对象配置运行。
 */
export const Config =
  z === null
    ? void 0
    : z.object({
        apiKey: z.string().role('secret').default('').description('字面量 API Key（优先于环境变量）').volatile(),
        apiKeyEnv: z
          .string()
          .role('credential-ref')
          .default(DEFAULT_API_KEY_ENV)
          .description('密钥引用名，可指向 credentials 或环境变量')
          .volatile(),
        endpoint: z.string().default(DEFAULT_ENDPOINT).description('SearchPro 端点').volatile(),
        version: z
          .union([z.const('auto'), z.const('lite'), z.const('standard'), z.const('flagship')])
          .default('auto')
          .description('auto 由服务端 Response.Version 自动判定')
          .volatile(),
        mode: z
          .union([z.const(0), z.const(1), z.const(2)])
          .description('0 公开网页 / 1 权威垂直信源 / 2 混合')
          .volatile(),
        site: z.string().description('单域名，或 exclude:a.com|b.com').volatile(),
        industry: z
          .union([z.const('gov'), z.const('news'), z.const('acad'), z.const('finance')])
          .description('垂直领域')
          .volatile(),
        freshness: z.string().description('d7 / m3 / y1 / 2026-08-20 / 日期区间').volatile(),
        timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS).description('单次搜索超时').volatile(),
        snippetChars: z
          .number()
          .step(1)
          .min(80)
          .default(DEFAULT_SNIPPET_CHARS)
          .description('摘要截断长度')
          .volatile(),
        exposeTool: z.boolean().default(true).description('是否注册 yuanbao_search 工具').volatile(),
      });

/**
 * Cordis 入口：注册搜索 provider，并按配置注册可选工具。
 * @param {any} ctx - 插件上下文。
 * @param {any} config - 插件配置。
 */
export function apply(ctx, config) {
  const provider = new YuanbaoSearchProvider(() => resolveOptions(config), ctx);
  ctx.web.registerSearchProvider(provider);
  if (resolveOptions(config).exposeTool) applyTool(ctx, provider);
}
