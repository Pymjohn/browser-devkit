// 最小 CDP 客户端：连接、开页、求值、输入事件、下载接管。
// 依赖 Node 18+ 内置 fetch 与 WebSocket。

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

// 用 JS 表达式定位元素后发真实鼠标事件。finder 必须返回 Element。
export async function clickFinder(send, finder, { label = "元素", settle = 80 } = {}) {
  const boxJs = `(() => {
    const el = ${finder};
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`;

  let box = await evaluate(send, boxJs);
  if (!box) throw new Error(`找不到可点击元素: ${label}`);
  // 滚动会改变布局，等一帧后重新测量，否则用的是滚动前的旧坐标。
  await new Promise((r) => setTimeout(r, settle));
  box = (await evaluate(send, boxJs)) || box;

  const pos = { x: box.x, y: box.y, button: "left", clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...pos, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pos, buttons: 0 });

  const hit = await evaluate(send, `(() => {
    const el = ${finder};
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (top === el || el.contains(top) || top.contains(el)) ? "ok" : "miss";
  })()`);
  return hit;
}

export async function click(send, selector) {
  const hit = await clickFinder(send, `document.querySelector(${JSON.stringify(selector)})`, { label: selector });
  if (hit === "ok") return "ok";
  if (hit === "missing") throw new Error(`找不到可点击元素: ${selector}`);
  // 不再静默回退 DOM 点击：SPA 的合成 click 常常不触发路由，会"看起来成功、实际没动"，
  // 排查成本远高于直接报错。命中失败几乎都是布局视口不一致，先 fitViewport。
  throw new Error(`点击未命中: ${selector}（元素被遮挡或布局视口不一致，可先执行 cdpctl fitviewport）`);
}

// 按可见文本点击，应对没有稳定 id/class 的按钮、菜单项、单选项。
export async function clickText(send, text, { within = null, exact = true, tag = null } = {}) {
  const root = within ? `document.querySelector(${JSON.stringify(within)})` : "document";
  const finder = `(() => {
    const scope = ${root};
    if (!scope) return null;
    const nodes = Array.from(scope.querySelectorAll(${JSON.stringify(tag || "button, a, [role=button], [role=menuitem], [role=option], label, li, span, div")}));
    const want = ${JSON.stringify(text)};
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    return nodes.find((n) => {
      if (!n.offsetParent) return false;
      const t = norm(n.innerText || n.textContent);
      return ${exact ? "t === want" : "t.includes(want)"};
    }) || null;
  })()`;
  const hit = await clickFinder(send, finder, { label: `文本「${text}」` });
  if (hit !== "ok") throw new Error(`点击文本失败: ${text}（${hit}）`);
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

// ---- 下载接管 / 视口对齐 / iframe ----

// 浏览器级连接。Browser.* 命令（含下载接管）必须走这一层，页面连接上会被拒绝。
export async function browserConnect({ timeout = 20000 } = {}) {
  const v = await version();
  return connect(v.webSocketDebuggerUrl, { timeout });
}

// 把下载交给 CDP 写盘。
// 关键：behavior=allow 会绕过 Chrome 的"是否保留文件 / 多文件自动下载"确认弹窗，
// 否则每次导出都要人工点一下，无人值守流程直接卡死。
export async function setDownloadBehavior(dir, { browser = null } = {}) {
  const own = !browser;
  const b = browser || (await browserConnect());
  try {
    await b.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: dir,
      eventsEnabled: true,
    });
  } finally {
    if (own) b.close();
  }
  return dir;
}

// 等下载真正落盘。
// Chrome 先写 .org.chromium.Chromium.XXXX / *.crdownload 临时文件，完成才改名；
// 早期读取临时文件会误判成"文件被截断"（实测停在 7KB），所以这里忽略临时文件，
// 并要求体积在 stableMs 内保持不变。
export async function waitForDownload(
  dir,
  { pattern = null, timeout = 180000, stableMs = 3000, interval = 500 } = {}
) {
  const re = pattern ? new RegExp(pattern) : null;
  const isTemp = (f) => f.startsWith(".") || f.endsWith(".crdownload") || f.endsWith(".tmp");
  const deadline = Date.now() + timeout;
  let candidate = null;
  let lastSize = -1;
  let lastAt = 0;

  while (Date.now() < deadline) {
    const files = readdirSync(dir)
      .filter((f) => !isTemp(f) && (!re || re.test(f)))
      .flatMap((f) => {
        const path = join(dir, f);
        try {
          const s = statSync(path);
          return [{ path, size: s.size, mtime: s.mtimeMs }];
        } catch {
          // 改名瞬间可能读不到，跳过这一轮即可
          return [];
        }
      })
      .filter((f) => f.size > 0)
      .sort((a, b) => b.mtime - a.mtime);

    const top = files[0];
    if (top) {
      if (candidate && top.path === candidate && top.size === lastSize) {
        if (Date.now() - lastAt >= stableMs) return top;
      } else {
        candidate = top.path;
        lastSize = top.size;
        lastAt = Date.now();
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`下载超时: ${dir}${pattern ? ` (${pattern})` : ""}`);
}

// 让布局视口等于可见区域。
// WSLg / 远程桌面下二者会差一圈（实测 innerWidth=2796 而窗口只有 1872），
// 此时鼠标事件用的布局坐标与肉眼位置不对应，点击整体偏移、看起来"点不中"。
export async function fitViewport(send, { force = false, scale = 1 } = {}) {
  const m = await evaluate(
    send,
    `({ iw: innerWidth, ih: innerHeight,
        vw: visualViewport ? visualViewport.width : innerWidth,
        vh: visualViewport ? visualViewport.height : innerHeight })`
  );
  const drift =
    m.iw > 0 &&
    (Math.abs(m.iw - m.vw) / m.iw > 0.02 || Math.abs(m.ih - m.vh) / m.ih > 0.02);
  if (!drift && !force) return { adjusted: false, ...m };

  const width = Math.round(drift ? m.vw : m.iw);
  const height = Math.round(drift ? m.vh : m.ih);
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  return { adjusted: true, width, height, was: { iw: m.iw, ih: m.ih } };
}

// 在同源 iframe 内求值。
// 结构式编辑器（MarvinJS）这类控件把整套 UI 放在 iframe 里，模拟拖拽画键极不稳定，
// 直接调它的 JS API（如 marvin.sketcherInstance.importStructure）才是可靠路径。
export async function evalInFrame(send, srcPattern, expression) {
  const js = `(() => {
    const f = Array.from(document.querySelectorAll("iframe")).find((x) =>
      ${JSON.stringify(srcPattern)} === "" ? true : (x.src || "").includes(${JSON.stringify(srcPattern)})
    );
    if (!f) return { __err: "未找到匹配的 iframe" };
    let w;
    try { w = f.contentWindow; void w.document.body; } catch { return { __err: "iframe 跨域，无法直接访问" }; }
    const fn = new Function("window", "document", "return (" + ${JSON.stringify(expression)} + ")");
    return Promise.resolve(fn(w, w.document)).then((v) => ({ v }));
  })()`;
  const r = await evaluate(send, js);
  if (r && r.__err) throw new Error(`iframe 求值失败: ${r.__err}`);
  return r ? r.v : undefined;
}

