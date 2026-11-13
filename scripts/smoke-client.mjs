/**
 * 离线模拟 DSH Web UI 的模块加载与面板渲染，验证 client.js 不会在宿主里抛错。
 * 不依赖真实浏览器：用最小化的 window/document/React 桩件跑通 factory + apply + 组件渲染。
 */
import fs from 'node:fs';

const code = fs.readFileSync('/Users/user/wsp/dsh-plugin-smart-ratelimit/src/ui/client.js', 'utf8');

// ---- 最小 React 桩件 ----
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { /* 不在渲染期执行副作用 */ },
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

// ---- 最小 DOM / window 桩件 ----
const appended = [];
const fakeDocument = {
  head: { append: (el) => appended.push(el) },
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove: () => { appended.splice(appended.indexOf({}), 1); } }),
  getElementById: () => null,
};

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, factory };
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    confirm: () => false,
  },
  document: fakeDocument,
  navigator: { language: 'zh-CN' },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: [] }) }),
  console,
  React,
};

// 执行 client.js（它引用全局 window/document/navigator/fetch/React）
const fn = new Function(
  'window',
  'document',
  'navigator',
  'fetch',
  'React',
  'console',
  code,
);
fn(sandbox.window, sandbox.document, sandbox.navigator, sandbox.fetch, React, console);

if (!loaded) {
  console.error('❌ 未调用 window.__ModuleLoader__.load');
  process.exit(1);
}
console.log('✅ 模块已注册, id =', loaded.id);

// 执行 factory，拿到 exports
const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};
let exported;
try {
  exported = loaded.factory(requireStub);
} catch (error) {
  console.error('❌ factory 执行失败:', error.message);
  console.error(error.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
console.log('✅ factory 执行成功, exports =', Object.keys(exported).join(', '));

if (typeof exported.apply !== 'function') {
  console.error('❌ exports.apply 不是函数');
  process.exit(1);
}

// 模拟 Cordis 上下文，调用 apply
const injections = [];
const registered = [];
const fakeCtx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: {
    inject: (name, cb) => { injections.push(name); return cb(); },
    register: (meta, render) => { registered.push({ meta, render }); return () => {}; },
  },
};

try {
  exported.apply(fakeCtx);
} catch (error) {
  console.error('❌ apply 执行失败:', error.message);
  console.error(error.stack?.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
console.log('✅ apply 执行成功');
console.log('   slots.inject 调用:', injections.join(', ') || '(无)');
console.log('   注册条目:', registered.map((r) => r.meta.id || r.meta.key).join(', ') || '(无)');
console.log('   样式节点已注入:', appended.length);

// 检查注册元数据
const entry = registered[0];
if (!entry) {
  console.error('❌ 没有注册任何插槽条目');
  process.exit(1);
}
if (entry.meta.name !== 'settings.section') {
  console.error('❌ 插槽名错误:', entry.meta.name);
  process.exit(1);
}
if (entry.meta.order !== 100) {
  console.error('❌ order 不是 100:', entry.meta.order);
  process.exit(1);
}
console.log('✅ 插槽元数据正确: name=settings.section, order=' + entry.meta.order + ', label=' + (typeof entry.meta.label === 'function' ? entry.meta.label() : entry.meta.label));

// 渲染一次，确认组件本身不抛错
try {
  const tree = entry.render({});
  const typeName = tree && tree.type ? (tree.type.name || String(tree.type)) : typeof tree;
  console.log('✅ 面板渲染成功, 根节点 =', typeName);

  // 真正执行组件函数体（React 元素只是描述，不调用组件），验证内部逻辑无异常。
  if (tree && typeof tree.type === 'function') {
    const inner = tree.type(tree.props);
    const childCount = Array.isArray(inner.children) ? inner.children.length : 0;
    console.log('✅ 组件函数体执行成功, 根节点 =', inner.type, ', 子节点数 =', childCount);
    if (inner.type !== 'div') {
      console.error('❌ 组件根节点应为 div，实际为', inner.type);
      process.exit(1);
    }
  }
} catch (error) {
  console.error('❌ 面板渲染失败:', error.message);
  console.error(error.stack?.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}

console.log('\n🎉 全部通过：模块注册、工厂执行、apply、面板渲染均无异常');
