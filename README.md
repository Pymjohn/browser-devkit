# browser-devkit

当前版本 **1.0.3**。

用命令行驱动 openbrowser 的最小工具集：打开页面、读取内容、点击、输入、按键、滚动、等待元素。底层是 Chrome DevTools Protocol，不依赖 Playwright 或 Puppeteer。

## 依赖

- `openbrowser`，可执行文件位于 `/opt/openbrowser/openbrowser`
- Node.js 18 以上（使用内置 `fetch` 与 `WebSocket`，实测 Node 24）
- 浏览器以 `--remote-debugging-port=9222` 运行；可用 `scholar-search` 项目里的 `scripts/ensure_browser.sh` 启动

## 快速开始

```bash
# 启动浏览器（无窗口模式）
bash ~/.codebuddy/skills/scholar-search/scripts/ensure_browser.sh start

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
| `click <selector>` | 真实鼠标事件点击；未命中直接报错，不再静默回退 |
| `click-text <文本> [--within s]` | 按可见文本点击，适合没有稳定选择器的按钮/菜单项 |
| `type <selector> <text>` | 聚焦并输入，`--enter` 可直接提交 |
| `press <Key>` | Enter / Tab / Escape / ArrowDown / Backspace |
| `scroll <px\|top\|bottom>` | 滚轮或直接跳转 |
| `wait <selector> [--timeout ms]` | 等待元素出现 |
| `viewport [w] [h]` | 设置虚拟视口，默认 1280×900 |
| `fitviewport [--force]` | 让布局视口等于可见区域，修正系统性点击偏移 |
| `dl-dir <dir>` | 接管下载目录，绕过浏览器确认弹窗 |
| `dl-wait [dir] [--pattern re] [--timeout ms]` | 等下载真正落盘，输出路径与大小 |
| `eval-frame <src片段> <js>` | 在同源 iframe 内求值 |
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
bash ~/.codebuddy/skills/scholar-search/scripts/ensure_browser.sh stop
SCHOLAR_HEADLESS=0 bash ~/.codebuddy/skills/scholar-search/scripts/ensure_browser.sh start
```

## 无人值守下载：把确认弹窗去掉

Chrome 对连续自动下载会拦一道"是否保留文件 / 允许多文件下载"的确认框。每次导出都要人点一下，自动化就断在这里。解决办法不是换下载器，而是把下载行为本身交给 CDP：

```bash
mkdir -p ~/Downloads/reaxys_auto
node bin/cdpctl.mjs dl-dir ~/Downloads/reaxys_auto   # 之后所有下载直接写盘，无弹窗
node bin/cdpctl.mjs dl-wait ~/Downloads/reaxys_auto --pattern '\.rdf$' --timeout 300000
```

底层就一句：

```js
Browser.setDownloadBehavior({ behavior: "allow", downloadPath: dir, eventsEnabled: true })
```

三个容易踩的点：

1. **必须发在浏览器级连接上**（`/json/version` 的 ws），发到页面连接会被拒。
2. **文件是两段式落盘**：先写 `.org.chromium.Chromium.XXXX` / `*.crdownload`，完成才改名。中途去读临时文件，会看到"只写了几 KB 就停住"的假象——实测 68 MB 的文件在临时文件阶段只有 7 KB，很容易误判成失败。`dl-wait` 所以忽略临时文件、并要求体积 3 秒内不变。
3. **大文件不再慢**：设置前 200 条要等十几分钟（都在等你点确认），设置后 1000 条 14 MB 约 5 秒。

## 窗口模式下的坐标偏移（WSLg）

无窗口模式布局视口是 0×0，工具会自动建 1280×900 虚拟视口，坐标可用。但换成窗口模式后会出现另一种偏差：**布局视口比真实可见区域大一圈**。

实测数据：窗口 1872×1080，而 `innerWidth/innerHeight` 报 2796×1681，比值约 1.49。此时 `getBoundingClientRect` 给出的坐标与肉眼位置不对应，鼠标事件就系统性偏移——表现是"按钮明明在那儿，就是点不中"。

```bash
node bin/cdpctl.mjs fitviewport
# 视口已对齐 1872×1080（原布局 2796×1681）
```

对齐之后同一批点击全部命中。若页面已经有正确的视口，命令只会打印"视口一致，无需调整"。

另外两个窗口模式相关的坑：

- **XWayland 会给窗口套 32px 装饰框**，导致点击位置整体错位、窗口被摆到副屏右下角。启动时用 `--ozone-platform=wayland --force-device-scale-factor=1` 走原生 Wayland 可一并解决。
- **后台进程会被回收**：用 `nohup` 拉起的浏览器，在命令返回后可能被清理掉。交给任务管理器托管（如工具环境的后台任务）才稳定存活。

## iframe 内的控件

结构式编辑器这类控件通常把 UI 塞在同源 iframe 里，靠模拟鼠标画键既慢又脆。直接调它的 API 更省事：

```bash
# 读当前画布内容
node bin/cdpctl.mjs eval-frame structure-editor 'window.marvin.sketcherInstance.exportStructure("smiles")'

# 直接导入一个 SMARTS，代替手工绘制
node bin/cdpctl.mjs eval-frame structure-editor \
  'window.marvin.sketcherInstance.importStructure("smarts", ">>[#26]")'
```

跨域 iframe 会明确报 `iframe 跨域，无法直接访问`，不会静默返回 undefined。

## 实战：Reaxys 导出 5000 条反应

完整链路（全程无人值守，含分块、去重、转 SMILES）：

```bash
node bin/cdpctl.mjs dl-dir ~/Downloads/reaxys_auto
node bin/cdpctl.mjs fitviewport

# 每批 1000 条，TSV 带条件字段；RD File 只带结构
for p in "1 1000" "1001 2000" "2001 3000"; do
  set -- $p
  # 站点侧的导出对话框仍要点：Export → 选格式 → 填 range → Export → Download
  # 这些点击用 click-text 完成，坐标不稳定时先 fitviewport
  node bin/cdpctl.mjs click-text Export
  node bin/cdpctl.mjs click-text "Tab-delimited text"
  node bin/cdpctl.mjs dl-wait ~/Downloads/reaxys_auto --pattern '\.tsv$'
done
```

经验值：TSV 每 1000 条约 120–140 秒生成、2–5 MB；同样的量走 Microsoft Excel 会卡在 29% 十几分钟不动（已弃用该格式）。RD File 每 5000 条约 68 MB，落盘 10 秒。

## 变更记录

### 1.0.3

- 新增 `dl-dir` / `dl-wait` / `setDownloadBehavior` / `waitForDownload`：接管下载、绕过确认弹窗，按体积稳定性判断落盘完成
- 新增 `fitviewport` / `fitViewport`：对齐布局视口与可见区域，修正 WSLg 下的系统性点击偏移
- 新增 `eval-frame` / `evalInFrame`：同源 iframe 内求值，替代 iframe 内的鼠标模拟
- 新增 `click-text` / `clickText`，并把 `click` 重构为 `clickFinder`：按文本或任意 JS 表达式定位，点击前滚动并二次测量
- **行为变更**：`click` 未命中不再回退 DOM 点击——合成 click 常让 SPA "看似成功实际没动"，改为直接报错并提示先跑 `fitviewport`
- 清理未使用的导入与 `void` 占位；README 修正 skills 路径为 `~/.codebuddy`

### 1.0.2

- 修复 `--help` 参数处理

### 1.0.1

- 首个可用版本：CDP 驱动开页、求值、点击、输入、按键、滚动、等待

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
