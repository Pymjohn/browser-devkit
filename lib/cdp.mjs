// 最小 CDP 客户端：连接、开页、求值、输入事件。
// 依赖 Node 18+ 内置 fetch 与 WebSocket。

const DEFAULT_PORT = process.env.CDP_PORT || 9222;
export const BASE = `http://127.0.0.1:${DEFAULT_PORT}`;

export async function version() {
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`CDP 不可用: HTTP ${r.status}`);
  return r.json();
}

export async function listTargets() {
  const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

export async function newTarget(url = "about:blank") {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`创建标签页失败: HTTP ${r.status}`);
  return r.json();
}

export async function closeTarget(id) {
  await fetch(`${BASE}/json/close/${id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// 连接某个页面（或浏览器）的 WebSocket，返回带超时的 send。
export function connect(wsUrl, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.onopen = () => resolve({ ws, send, on, close });
    ws.onerror = () => reject(new Error(`无法连接 ${wsUrl}`));
    ws.onclose = () => {
      for (const { reject: rej } of pending.values()) rej(new Error("连接已关闭"));
      pending.clear();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
        return;
      }
      const hs = listeners.get(msg.method);
      if (hs) for (const h of hs) h(msg.params);
    };

    function send(method, params = {}, ms = timeout) {
      const id = ++seq;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} 超时 ${ms}ms`));
        }, ms);
        pending.set(id, { resolve: res, reject: rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    function on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    }

    function close() {
      try { ws.close(); } catch { /* 已关闭 */ }
    }
  });
}

// 开一个新标签页并连上它。
export async function openPage(url) {
  const target = await newTarget(url);
  const conn = await connect(target.webSocketDebuggerUrl);
  await conn.send("Page.enable");
  await ensureViewport(conn.send);
  return { id: target.id, ...conn };
}

export async function evaluate(send, expression, { awaitPromise = true } = {}) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails) {
    throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`.trim());
  }
  return r.result?.value;
}

// 无窗口模式下没有合成表面，布局视口为 0×0，坐标点击会失效。
// 这里用设备模拟建立一个虚拟视口，使 getBoundingClientRect 与鼠标事件有意义。
export async function ensureViewport(send, { width = 1280, height = 900, scale = 1 } = {}) {
  const w = await evaluate(send, "window.innerWidth").catch(() => 0);
  if (w > 0) return { width: w, created: false };
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  return { width, created: true };
}

// 轮询直到表达式的值满足条件（truthy / 自定义判据）。
export async function waitFor(send, expression, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await evaluate(send, expression).catch(() => false);
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待超时: ${expression}`);
}

// 先把元素滚入视野再测量，否则元素可能在视口外，坐标为负。
export async function boundingBox(send, selector) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`;
  const box = await evaluate(send, js);
  if (box) await new Promise((r) => setTimeout(r, 60));
  return box;
}

export async function click(send, selector) {
  const box = await boundingBox(send, selector);
  if (!box) throw new Error(`找不到可点击元素: ${selector}`);
  const base = { x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 1 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });

  // 校验命中：若坐标处不是该元素（被遮挡或布局偏移），回退到 DOM 点击。
  const hit = await evaluate(send, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (top === el || el.contains(top) || top.contains(el)) ? "ok" : "miss";
  })()`);
  if (hit === "miss") {
    await evaluate(send, `document.querySelector(${JSON.stringify(selector)}).click()`);
    return "fallback";
  }
  return "ok";
}

export async function type(send, selector, text) {
  const ok = await evaluate(send, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (el.select) el.select();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到输入框: ${selector}`);
  await send("Input.insertText", { text });
  return evaluate(send, `document.querySelector(${JSON.stringify(selector)}).value`);
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};

export async function press(send, key, { modifiers = 0 } = {}) {
  const k = KEYS[key];
  if (!k) throw new Error(`未支持的按键: ${key}`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...k });
  if (k.text) await send("Input.dispatchKeyEvent", { type: "char", modifiers, text: k.text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k });
}

export async function scroll(send, deltaY, { x = 400, y = 400 } = {}) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY,
  });
}
