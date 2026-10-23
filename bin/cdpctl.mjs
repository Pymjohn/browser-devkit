#!/usr/bin/env node
// 命令行驱动 openbrowser：开页、读取、点击、输入、按键、滚动、等待、截图。
// 用法见 README 或 cdpctl --help。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASE,
  closeTarget,
  connect,
  ensureViewport,
  evaluate,
  listTargets,
  openPage,
  press,
  scroll,
  click as clickEl,
  type as typeInto,
  waitFor,
} from "../lib/cdp.mjs";

const STATE = join(homedir(), ".cache", "browser-devkit", "state.json");
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }, null, 2));
}

async function ensureCurrent() {
  const pages = (await listTargets()).filter((t) => t.type === "page");
  if (!pages.length) throw new Error("没有可用标签页，先执行: cdpctl open <url>");
  const { targetId } = loadState();
  const target = pages.find((p) => p.id === targetId) || pages[0];
  const conn = await connect(target.webSocketDebuggerUrl);
  await conn.send("Page.enable");
  await ensureViewport(conn.send);
  saveState({ targetId: target.id });
  return { target, ...conn };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector") flags.selector = argv[++i];
    else if (a === "--timeout") flags.timeout = Number(argv[++i]);
    else if (a === "--enter") flags.enter = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `用法: cdpctl <命令> [参数]

  --version                  打印版本号（当前 ${VERSION}）

  open <url>                 新建标签页并设为当前
  tabs                       列出所有标签页
  close [id]                 关闭当前（或指定）标签页
  goto <url>                 当前标签页导航到新地址
  title                      当前页面标题
  text [--selector s]        取正文（或指定元素的 innerText）
  html [--selector s]        取 outerHTML
  eval <js>                  在页面里求值，返回结果
  click <selector>           鼠标点击元素（真实鼠标事件）
  type <selector> <text>     聚焦输入框并输入文本
  press <Key>                按键（Enter/Tab/Escape/ArrowDown/Backspace）
  scroll <px|top|bottom>     滚动（正数向下）
  wait <selector>            等待元素出现
  viewport [w] [h]           设置虚拟视口（默认 1280×900）
  shot <文件路径>            截图（复杂页面需窗口模式）

环境变量: CDP_PORT（默认 9222）`;

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
}

try {
  switch (cmd) {
    case "open": {
      const url = positional[0];
      if (!url) throw new Error("缺少 URL");
      const page = await openPage(url);
      saveState({ targetId: page.id });
      console.log(`已打开 ${page.id}`);
      page.close();
      break;
    }
    case "tabs": {
      const pages = (await listTargets()).filter((t) => t.type === "page");
      const { targetId } = loadState();
      for (const p of pages) {
        console.log(`${p.id === targetId ? "*" : " "} ${p.id}  ${p.title.slice(0, 50)}  ${p.url.slice(0, 60)}`);
      }
      break;
    }
    case "close": {
      const id = positional[0] || loadState().targetId;
      if (!id) throw new Error("没有可关闭的标签页");
      await closeTarget(id);
      saveState({ targetId: null });
      console.log(`已关闭 ${id}`);
      break;
    }
    case "goto": {
      const url = positional[0];
      if (!url) throw new Error("缺少 URL");
      const { send, close } = await ensureCurrent();
      await send("Page.navigate", { url });
      close();
      console.log("已导航");
      break;
    }
    case "title": {
      const { send, close } = await ensureCurrent();
      console.log(await evaluate(send, "document.title"));
      close();
      break;
    }
    case "text": {
      const { send, close } = await ensureCurrent();
      const sel = flags.selector;
      const js = sel
        ? `(document.querySelector(${JSON.stringify(sel)})||{}).innerText || ""`
        : "document.body.innerText";
      console.log(await evaluate(send, js));
      close();
      break;
    }
    case "html": {
      const { send, close } = await ensureCurrent();
      const sel = flags.selector;
      const js = sel
        ? `(document.querySelector(${JSON.stringify(sel)})||{}).outerHTML || ""`
        : "document.documentElement.outerHTML";
      console.log(await evaluate(send, js));
      close();
      break;
    }
    case "eval": {
      const js = positional.join(" ");
      if (!js) throw new Error("缺少表达式");
      const { send, close } = await ensureCurrent();
      const v = await evaluate(send, js);
      console.log(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));
      close();
      break;
    }
    case "click": {
      const sel = positional[0];
      if (!sel) throw new Error("缺少选择器");
      const { send, close } = await ensureCurrent();
      const how = await clickEl(send, sel);
      console.log(`已点击 ${sel}${how === "fallback" ? "（坐标未命中，回退为 DOM 点击）" : ""}`);
      close();
      break;
    }
    case "type": {
      const [sel, ...textParts] = positional;
      const text = textParts.join(" ");
      if (!sel || !text) throw new Error("用法: cdpctl type <selector> <text>");
      const { send, close } = await ensureCurrent();
      const value = await typeInto(send, sel, text);
      if (flags.enter) await press(send, "Enter");
      console.log(`已输入，当前值: ${value}`);
      close();
      break;
    }
    case "press": {
      const key = positional[0];
      if (!key) throw new Error("缺少按键名");
      const { send, close } = await ensureCurrent();
      await press(send, key);
      console.log(`已按键 ${key}`);
      close();
      break;
    }
    case "scroll": {
      const arg = positional[0] || "bottom";
      const { send, close } = await ensureCurrent();
      if (arg === "bottom") {
        await evaluate(send, "window.scrollTo(0, document.body.scrollHeight)");
      } else if (arg === "top") {
        await evaluate(send, "window.scrollTo(0, 0)");
      } else {
        await scroll(send, Number(arg) || 600);
      }
      console.log(`已滚动 ${arg}`);
      close();
      break;
    }
    case "wait": {
      const sel = positional[0];
      if (!sel) throw new Error("缺少选择器");
      const { send, close } = await ensureCurrent();
      await waitFor(send, `!!document.querySelector(${JSON.stringify(sel)})`, {
        timeout: flags.timeout || 15000,
      });
      console.log(`元素已出现: ${sel}`);
      close();
      break;
    }
    case "viewport": {
      const w = Number(positional[0]) || 1280;
      const h = Number(positional[1]) || 900;
      const { send, close } = await ensureCurrent();
      await send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      close();
      console.log(`视口已设为 ${w}×${h}`);
      break;
    }
    case "shot": {
      const out = positional[0] || "screenshot.png";
      const { send, close } = await ensureCurrent();
      const r = await send("Page.captureScreenshot", { format: "png" }, 10000);
      const { writeFileSync: wf } = await import("node:fs");
      wf(out, Buffer.from(r.data, "base64"));
      close();
      console.log(`已保存 ${out}`);
      break;
    }
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
} catch (e) {
  console.error(`错误: ${e.message}`);
  if (String(e.message).includes("超时") && cmd === "shot") {
    console.error("提示: 复杂页面在无窗口模式下无法截图，先以 SCHOLAR_HEADLESS=0 启动浏览器。");
  }
  process.exit(1);
}

void BASE;
void existsSync;
