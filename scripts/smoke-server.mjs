/**
 * 离线模拟 Cordis 宿主，验证服务端 src/index.js 的 apply → ready → start 全流程不抛错。
 * 覆盖：provider 发现、拦截器初始化、provide 注册、inject 路由注册。
 */
import assert from 'node:assert';

const mod = await import('/Users/user/wsp/dsh-plugin-smart-ratelimit/src/index.js');

const provided = new Map();
const injected = [];
const routes = [];
const listeners = new Map();

/** 最小 Cordis 上下文桩件。 */
const ctx = {
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  },
  provide: (name, value) => {
    provided.set(name, value);
    return () => provided.delete(name);
  },
  inject: (deps, cb) => {
    injected.push(deps);
    const webCtx = {
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      webServer: {
        register: (route) => { routes.push(route); return () => {}; },
      },
    };
    cb(webCtx);
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
};

// apply 不应抛错
mod.default(ctx);
console.log('✅ apply 执行成功');

// 触发 ready
const readyHandlers = listeners.get('ready') || [];
assert.ok(readyHandlers.length > 0, 'ready 监听未注册');
for (const fn of readyHandlers) await fn();
console.log('✅ ready → start 执行成功');

// 校验 provide
assert.ok(provided.has('smart-ratelimit.settings'), '未 provide smart-ratelimit.settings');
assert.ok(provided.has('smart-ratelimit'), '未 provide smart-ratelimit');
console.log('✅ provide 服务已注册:', [...provided.keys()].join(', '));

// 校验 HTTP 路由
assert.ok(injected.length > 0, '未调用 ctx.inject');
assert.ok(routes.length > 0, '未注册 HTTP 路由');
const route = routes[0];
assert.strictEqual(route.path, '/api/dsh-plugin-smart-ratelimit/rpc');
assert.strictEqual(typeof route.handler, 'function');
console.log('✅ HTTP 路由已注册:', route.path);

// 实际调用一次路由 handler，验证 RPC 分发
async function callRoute(body) {
  let status = 0;
  let payload = null;
  const req = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    writeHead: (s) => { status = s; },
    end: (text) => { payload = JSON.parse(text); },
  };
  await route.handler(req, res);
  return { status, payload };
}

const listResult = await callRoute({ method: 'getProviders', args: [] });
assert.strictEqual(listResult.status, 200);
assert.ok(listResult.payload.ok, 'getProviders 返回失败: ' + JSON.stringify(listResult.payload));
assert.ok(Array.isArray(listResult.payload.value), 'getProviders 应返回数组');
console.log('✅ getProviders 返回', listResult.payload.value.length, '个 provider:',
  listResult.payload.value.map((p) => p.id).join(', '));

if (listResult.payload.value.length > 0) {
  const id = listResult.payload.value[0].id;
  const settingsResult = await callRoute({ method: 'getSettings', args: [id] });
  assert.strictEqual(settingsResult.status, 200);
  assert.ok(settingsResult.payload.ok, 'getSettings 失败');
  console.log('✅ getSettings(' + id + ') 返回键:', Object.keys(settingsResult.payload.value).slice(0, 8).join(', '));

  const monitorResult = await callRoute({ method: 'getMonitorData', args: [id] });
  assert.strictEqual(monitorResult.status, 200);
  assert.ok(monitorResult.payload.ok, 'getMonitorData 失败');
  console.log('✅ getMonitorData(' + id + ') 返回:', JSON.stringify(monitorResult.payload.value).slice(0, 120));
}

// 未知方法应 404
const unknown = await callRoute({ method: 'nope', args: [] });
assert.strictEqual(unknown.status, 404);
console.log('✅ 未知方法正确返回 404');

// 非 POST 应 405
let status405 = 0;
await route.handler({ method: 'GET' }, { writeHead: (s) => { status405 = s; }, end: () => {} });
assert.strictEqual(status405, 405);
console.log('✅ 非 POST 正确返回 405');

console.log('\n🎉 服务端全部通过：apply、start、provide、HTTP 路由、RPC 分发均正常');
