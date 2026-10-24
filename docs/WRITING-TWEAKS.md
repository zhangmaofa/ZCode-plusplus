# 编写 ZCode++ Tweak

一个 tweak 是 `~/.zcode/zcode-plusplus/tweaks/` 下的一个文件夹：

```
my-tweak/
  manifest.json
  index.js
```

## manifest.json

```json
{
  "id": "com.you.my-tweak",
  "name": "My Tweak",
  "version": "0.1.0",
  "description": "做点什么",
  "scope": "renderer",
  "main": "index.js"
}
```

| 字段     | 说明                                                        |
| -------- | ----------------------------------------------------------- |
| `id`     | 反向域名或 `tweak.xxx` 风格，字母/数字/`.`/`-`              |
| `scope`  | `renderer`（UI）/ `main`（主进程）/ `both`                   |
| `main`   | 入口文件，CommonJS，导出 `start(api)` 与可选 `stop(api, ctx)` |

## 入口签名

```js
module.exports = {
  start(api) {
    // 返回值会作为 ctx 传给 stop()
    return { cleanup() {} };
  },
  stop(api, ctx) {
    ctx && ctx.cleanup();
  },
};
```

`start` 抛错只会被记录（`log/main.log`），不会影响 ZCode。

## renderer scope（每个窗口的 preload 世界里运行）

有完整 DOM 访问；页面自身的 JS 上下文隔离不变（contextIsolation 保持）。沙箱模式下
只能 `require('./相对文件')`；非沙箱（视 ZCode 的 webPreferences 而定）还能用 node 内置模块。

```js
module.exports = {
  start(api) {
    api.settings.registerPage({
      id: 'main',
      title: 'My Tweak',
      render(root) {
        const btn = document.createElement('button');
        btn.textContent = 'click me';
        btn.onclick = async () => {
          const n = (await api.storage.get('clicks', 0)) + 1;
          await api.storage.set('clicks', n);
          btn.textContent = 'clicked ' + n;
        };
        root.appendChild(btn);
      },
    });
  },
};
```

API 一览：

- `api.settings.registerPage({ id, title, render(root) })` — 在 Z++ 面板注册一页
- `api.storage.get(key, def?)` / `set(key, value)` — 持久化到 `tweak-data/<id>/storage.json`
- `api.log/warn/error(...)` — 写入 `log/main.log`（带 `[renderer:<id>]` 前缀）
- `api.manifest` / `api.version`

## main scope（ZCode 主进程里运行）

拿到整个 `electron` 模块句柄：BrowserWindow、globalShortcut、Tray、dialog、shell、
ipcMain……也可以 `require` 自己目录里的 `.node` 原生模块（Windows 原生能力即插即用）。

```js
module.exports = {
  start(api) {
    const { globalShortcut } = api.electron;
    const ok = globalShortcut.register('CommandOrControl+Alt+Shift+D', () => {
      const win = api.electron.BrowserWindow.getFocusedWindow();
      if (win) win.webContents.toggleDevTools();
    });
    api.log.info('shortcut registered:', ok);
    const off = api.windows.onCreated((win) => api.log.info('new window'));
    return { off, ok };
  },
  stop(api, ctx) {
    ctx.off && ctx.off();
    api.electron.globalShortcut.unregister('CommandOrControl+Alt+Shift+D');
  },
};
```

API 一览：

- `api.electron` — electron 模块本体
- `api.dataDir` — 专属数据目录（已创建）
- `api.storage.get/set/all` — 同步版持久化
- `api.log.info/warn/error` — 写 `log/main.log`
- `api.windows.onCreated(cb)` / `getAll()` — 窗口生命周期
- `api.reloadRendererTweak(id)` — 通知所有窗口重载某 renderer tweak

## 开发流程

```bash
node bin/zcodepp.js new-tweak my-tweak --scope renderer   # 脚手架（当前目录）
node bin/zcodepp.js validate-tweak my-tweak               # 校验 manifest + 语法
node bin/zcodepp.js dev my-tweak                          # 部署 + 监听改动 + 日志跟踪
```

`dev` 模式：保存文件后自动重新部署；main scope tweak 自动重启，renderer tweak 在
已打开的窗口里热重载（调用 `stop()` 再 `start()`）。Ctrl+C 退出 dev（tweak 保留安装）。

调试渲染层：`node bin/zcodepp.js debug` 会带 `--remote-debugging-port=9223` 启动 ZCode，
用 Chrome/Edge 访问 `http://127.0.0.1:9223/json/list` 拿到页面调试地址。

## 设置界面注入（可选进阶）

Z++ 悬浮面板是稳定入口；如果想把页面注入 ZCode 原生 UI（如设置页），注入器按
`~/.zcode/zcode-plusplus/runtime/config.json` 里的选择器工作：

```json
{
  "settingsInjection": {
    "selectors": {
      "dialogSelector": "[role=\"dialog\"]",
      "tabListSelector": "[role=\"tablist\"]",
      "tabSelector": "[role=\"tab\"]",
      "panelContainerSelector": null
    }
  }
}
```

改完无需重打补丁（runtime 不在 asar 里），重启 ZCode 生效。注意 ZCode 的设置页目前是
主窗口 tab 系统的一页而非独立对话框，用 `debug` 实测 DOM 后再调整选择器；注入失败只是
不显示，不会出错。

## 类型提示

TS 项目可引用 `sdk/index.d.ts`：

```ts
import type { RendererTweak } from 'zcode-plusplus/sdk';
const tweak: RendererTweak = { start(api) { /* ... */ } };
export default tweak;
```
