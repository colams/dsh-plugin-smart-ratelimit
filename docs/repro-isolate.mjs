// 用桌面版 cordis 4.1.0 精确复现：Service 式 filter + isolate 对 llm/stream 事件可见性的影响
import { Context, symbols } from './cordis-index.js';

const FILTER = symbols.filter;
const results = [];

class FakeLlmRuntime {
  constructor(ctx, name = 'llm') {
    this.ctx = ctx;
    this.name = name;
    ctx.reflect.provide(name, this);
  }
  [FILTER](hookCtx) {
    return hookCtx[symbols.isolate]?.[this.name] === this.ctx[symbols.isolate]?.[this.name];
  }
  stream(options) {
    return this.ctx.waterfall(this, 'llm/stream', options, () =>
      (async function* () { yield { type: 'text-delta' }; })());
  }
}

async function scenario(label, { consumerJoinsLlmScope, listenerGlobal }) {
  const root = new Context();
  let received = 0;
  let runtimeRef = null;

  root.plugin({
    name: 'llm-provider',
    async apply(ctx) {
      const scoped = ctx.isolate('llm', 'llm');
      runtimeRef = new FakeLlmRuntime(scoped, 'llm');
    }
  });

  root.plugin({
    name: 'smart-ratelimit',
    apply(ctx) {
      const scoped = consumerJoinsLlmScope ? ctx.isolate('llm', 'llm') : ctx;
      scoped.on('llm/stream', (options, next) => {
        received++;
        const stream = typeof next === 'function' ? next() : next;
        return (async function* () { for await (const c of stream) yield c; })();
      }, listenerGlobal ? { global: true } : undefined);
    }
  });

  await new Promise(r => setTimeout(r, 30));
  if (!runtimeRef) { results.push({ label, received: -1, note: 'runtime 未创建' }); return; }
  const chunks = [];
  try { for await (const c of runtimeRef.stream({})) chunks.push(c); }
  catch (e) { results.push({ label, received, note: 'err:' + e.message }); return; }
  results.push({ label, received, chunks: chunks.length });
}

await scenario('A: 消费方在桶外（现状 smart-ratelimit）', {});
await scenario('B: 消费方 join llm 桶（isolate 对齐）', { consumerJoinsLlmScope: true });
await scenario('C: 桶外 + 监听器 global:true', { listenerGlobal: true });
await scenario('D: join 桶 + global:true', { consumerJoinsLlmScope: true, listenerGlobal: true });

console.log('\n===== 实验结果 =====');
for (const r of results) {
  console.log(`${r.label}: 事件到达 ${r.received} 次 ${r.note || ('chunk=' + r.chunks)}`);
}
