/**
 * llm/stream waterfall 契约回归测试
 *
 * 背景：DSH 的 `llm/stream` 是 waterfall（Koa 式）事件：
 *   ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))
 * 监听器签名为 `(options, next)`，必须调用 `next()` 取到真实流，
 * 返回值会被宿主用 `yield*` 消费。
 *
 * 历史缺陷：把 `next`（函数）当成流返回，宿主 `yield*` 消费时报
 * `yield* (intermediate value) is not async iterable`，导致整轮对话失败。
 * 本测试锁住三条不变量：
 *   1. 监听器返回值必须是 async iterable；
 *   2. chunk 必须完整透传（不吞、不改）；
 *   3. acquire 必须真的记账（限速生效）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

/** 复刻 @deepseek-ai/cordis 的 EventsService.waterfall 语义。 */
function makeEvents() {
  const hooks = new Map();
  return {
    on(name, callback) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(callback);
      return () => {};
    },
    waterfall(thisArg, name, ...rest) {
      const inner = rest.pop();
      const callbacks = [...(hooks.get(name) || [])].reverse();
      const dispatch = () => {
        const callback = callbacks.shift();
        if (!callback) return inner();
        let called = false;
        const next = () => {
          if (called) throw new Error('next() called multiple times');
          called = true;
          return dispatch();
        };
        return Reflect.apply(callback, thisArg, [...rest, next]);
      };
      return dispatch();
    },
  };
}

/** 复刻 dsh-llm 的 adapterStream：async generator 逐块产出协议 chunk。 */
async function* adapterStream() {
  yield { type: 'delta', text: '你' };
  yield { type: 'delta', text: '好' };
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** 用最小 Cordis 宿主桩件加载插件，返回 { plugin, events }。 */
async function bootPlugin() {
  const events = makeEvents();
  const provided = new Map();
  const ctx = {
    on: events.on,
    provide: (name, value) => {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    inject: (deps, callback) => callback({
      effect: (fn) => {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      webServer: { register: () => () => {} },
    }),
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  const mod = await import('../src/index.js');
  mod.default(ctx);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const plugin = provided.get('smartRateLimit');
  assert.ok(plugin, '插件未注册 smartRateLimit 服务');
  return { plugin, events, provided };
}

const OPTIONS = {
  provider: 'nvidia',
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: '你好' }],
  maxTokens: 64,
};

describe('llm/stream waterfall 契约', () => {
  it('监听器返回值必须是 async iterable（否则宿主 yield* 报错）', async () => {
    const { events } = await bootPlugin();

    const stream = events.waterfall({}, 'llm/stream', OPTIONS, () => adapterStream());

    assert.ok(stream, '监听器返回值不能为空');
    assert.strictEqual(
      typeof stream[Symbol.asyncIterator],
      'function',
      '监听器返回值不是 async iterable，宿主会抛 "yield* (intermediate value) is not async iterable"',
    );
  });

  it('宿主 yield* 消费时 chunk 完整透传', async () => {
    const { events } = await bootPlugin();

    const stream = events.waterfall({}, 'llm/stream', OPTIONS, () => adapterStream());

    async function* hostConsume() {
      yield* stream;
    }

    const chunks = [];
    for await (const chunk of hostConsume()) chunks.push(chunk);

    assert.deepStrictEqual(
      chunks.map((c) => c.type),
      ['delta', 'delta', 'usage', 'finish'],
      'chunk 必须原样透传，不能吞掉或重排',
    );
    assert.strictEqual(chunks[0].text, '你');
  });

  it('拦截后 acquire 真的记账（限速生效）', async () => {
    const { plugin, events } = await bootPlugin();

    const stream = events.waterfall({}, 'llm/stream', OPTIONS, () => adapterStream());
    for await (const _ of stream) { /* 消费完 */ }

    // postProcess 是 fire-and-forget，留时间让它跑完
    await new Promise((resolve) => setTimeout(resolve, 200));

    const monitor = plugin.interceptor.getMonitorData('nvidia');
    assert.ok(monitor, 'nvidia 限速器未创建');
    assert.ok(monitor.rpm >= 1, `acquire 未记账，rpm=${monitor.rpm}`);
  });

  it('跳过标记的请求原样透传且不记账', async () => {
    const { plugin, events } = await bootPlugin();

    // metricsTracker 是进程级单例，前面的用例已有累积计数，
    // 因此这里断言「增量」而不是绝对值。
    const before = plugin.interceptor.getMonitorData('nvidia')?.rpm ?? 0;

    const skipOptions = { ...OPTIONS, _isPolling: true };
    const stream = events.waterfall({}, 'llm/stream', skipOptions, () => adapterStream());

    const types = [];
    for await (const chunk of stream) types.push(chunk.type);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(types.length, 4, '跳过限速的请求仍必须完整透传');
    const after = plugin.interceptor.getMonitorData('nvidia')?.rpm ?? 0;
    assert.strictEqual(after, before, `跳过的请求不应记账（${before} -> ${after}）`);
  });

  it('无监听器时宿主直接消费原流（对照组）', async () => {
    const events = makeEvents();

    const stream = events.waterfall({}, 'llm/stream', OPTIONS, () => adapterStream());
    const types = [];
    for await (const chunk of stream) types.push(chunk.type);

    assert.strictEqual(types.length, 4);
  });
});

describe('限速器配置健壮性', () => {
  it('rpm 缺失时 acquire 放行而不是挂死', async () => {
    const { DualRateLimiter } = await import('../src/limiter/dualRateLimiter.js');

    // 模拟配置合并失败：rpm 为 undefined
    const limiter = new DualRateLimiter('broken-provider', { enabled: true });

    const result = await Promise.race([
      limiter.acquire({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('acquire 挂死超过 2s')), 2000)),
    ]);

    assert.strictEqual(result.allowed, true, 'rpm 非法时必须放行');
  });
});
