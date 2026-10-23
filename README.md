# browser-devkit

当前版本 **1.0.2**（本地仓库，未配置远端）。

用命令行驱动 openbrowser 的最小工具集：打开页面、读取内容、点击、输入、按键、滚动、等待元素。底层是 Chrome DevTools Protocol，不依赖 Playwright 或 Puppeteer。

## 依赖

- `openbrowser`，可执行文件位于 `/opt/openbrowser/openbrowser`
- Node.js 18 以上（使用内置 `fetch` 与 `WebSocket`，实测 Node 24）
- 浏览器以 `--remote-debugging-port=9222` 运行；可用 `scholar-search` 项目里的 `scripts/ensure_browser.sh` 启动

## 快速开始

```bash
# 启动浏览器（无窗口模式）
bash ~/.claude/skills/scholar-search/scripts/ensure_browser.sh start

# 打开页面
node bin/cdpctl.mjs open "https://scholar.google.com/"

# 看一眼标题
node bin/cdpctl.mjs title
```

## 命令

| 命令 | 作用 |
|---|---|
| `open <url>` | 新建标签页并设为当前 |
| `tabs` | 列出标签页，`*` 标记当前 |
| `close [id]` | 关闭当前或指定标签页 |
| `goto <url>` | 当前标签页导航 |
| `title` | 页面标题 |
| `text [--selector s]` | 正文或指定元素的 innerText |
| `html [--selector s]` | outerHTML |
| `eval <js>` | 页面内求值 |
| `click <selector>` | 真实鼠标事件点击（未命中时回退 DOM 点击） |
| `type <selector> <text>` | 聚焦并输入，`--enter` 可直接提交 |
| `press <Key>` | Enter / Tab / Escape / ArrowDown / Backspace |
| `scroll <px\|top\|bottom>` | 滚轮或直接跳转 |
| `wait <selector> [--timeout ms]` | 等待元素出现 |
| `viewport [w] [h]` | 设置虚拟视口，默认 1280×900 |
| `shot <file>` | 截图（复杂页面需窗口模式） |

状态文件：`~/.cache/browser-devkit/state.json`，记录"当前标签页"。

## 实例：在 Google 学术里检索

```bash
node bin/cdpctl.mjs open "https://scholar.google.com/"
node bin/cdpctl.mjs type '#gs_hdr_tsi' "photocatalytic hydrogen evolution"
node bin/cdpctl.mjs press Enter
node bin/cdpctl.mjs wait '.gs_ri' --timeout 15000
node bin/cdpctl.mjs text --selector '.gs_ri h3'
```

输出：

```
[HTML] Investigating the charge transfer mechanism of 1D/2D ZnO/SnIn4S8 S-scheme
heterojunction for efficient photocatalytic hydrogen evolution
```

整个流程不依赖站点提供的 API，走的是真实输入事件。

## 一个必须知道的实现细节

`--ozone-platform=headless` 下没有合成表面，**布局视口是 0×0**：

```
innerWidth = 0, innerHeight = 0
```

此时 `getBoundingClientRect` 返回负坐标、`elementFromPoint` 返回 null，坐标点击会落空。所以工具在读页面时会先调用 `Emulation.setDeviceMetricsOverride` 建立 1280×900 的虚拟视口，之后坐标才有效。

这也解释了截图为什么不稳定：没有合成表面，复杂页面无法出图；简单页面可以。需要截图时改用窗口模式：

```bash
bash ~/.claude/skills/scholar-search/scripts/ensure_browser.sh stop
SCHOLAR_HEADLESS=0 bash ~/.claude/skills/scholar-search/scripts/ensure_browser.sh start
```

## 安全边界

调试端口没有鉴权，谁能连上谁就能完全控制这个浏览器，包括读取其中所有 cookie。需要准确理解"本机"的范围：

| 范围 | 能否连上 | 依据 |
|---|---|---|
| 本 WSL 实例内的任意进程 | 能 | 仅绑定 `127.0.0.1:9222`，但 loopback 不区分用户 |
| Windows 宿主上的任意进程 | 能 | WSL2 的 localhost 转发，实测 `Test-NetConnection localhost 9222` 返回 True |
| 局域网内其他机器 | 默认不能 | NAT 模式下 127.0.0.1 不外露；除非启用镜像网络并显式端口转发 |

因此实际操作建议：

- 不要把它改成 `--remote-debugging-port=0.0.0.0:9222`，也不要手工做端口转发；
- profile 目录 `Default/` 权限是 700，文件层面只有属主可读，但通过 CDP 的 `Network.getAllCookies` 可以绕过文件权限直接取出全部 cookie，所以目录权限不构成保护；
- 在浏览器里登录高价值账号（邮箱、知网、机构账号）期间，用完就 `stop`，不要长期挂着；
- 不要把 profile 目录提交进版本库，也不要复制给别人。

## 与 scholar-search 的关系

`scholar-search` 负责"检索并结构化输出"，本工具负责"通用交互"。两者共用同一个浏览器实例与端口，可以交替使用。
