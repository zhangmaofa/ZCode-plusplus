# ZCode++ (ZCode PlusPlus)

给 ZCode 桌面应用做 tweak 的框架 —— 思路与 [Codex++](https://github.com/kpkhxlgy0/codex-plusplus)
相同：给 `app.asar` 打一个最小补丁让自定义 loader 最先启动，然后从**用户目录**加载
runtime 和你写的 tweak（改 UI、注入设置页、在主进程跑代码）。**fail-open**：
任何一层出问题，ZCode 都照常启动。

> 仅修改本机已安装的应用。只安装你信任的 tweak（tweak 会在 ZCode 内执行代码）。
> 与 Z.ai 官方无关，风险自担。

## 特性

- **应用级扩展**：官方插件系统覆盖技能/命令/MCP；ZCode++ 补上 UI 定制与主进程代码这层
- 零依赖 Node CLI：`install / uninstall / status / repair / doctor / safe-mode / debug / new-tweak / validate-tweak / dev / tweaks`
- 341MB asar **定向重建**（字节级校验 + 备份 + 原子替换），不改应用其余部分
- runtime/tweaks 全在 `~/.zcode/zcode-plusplus/`，改 tweak 无需重打补丁
- renderer / main / both 三种 scope；每 tweak 独立数据沙箱与持久化存储
- Z++ 悬浮面板 + 可配置的原生设置注入（MutationObserver 自愈）
- ZCode 自更新后自动 repair（计划任务 watcher，可 `--no-watcher`）
- dev 模式：改动热重载 + 日志跟踪

## 快速开始

前置：Windows + Node.js ≥ 18 + 已安装 ZCode 桌面版。**安装时需完全退出 ZCode**（包括
承载本对话的窗口——所以建议在独立终端里操作）。

```bash
git clone https://github.com/zhangmaofa/ZCode-plusplus
cd ZCode-plusplus

# 1. 体检（可选）：确认能找到 ZCode、fuse 允许打补丁
node bin/zcodepp.js doctor

# 2. 安装（备份 app.asar → 打补丁 → 部署 runtime + 内置 tweak → 注册 watcher）
node bin/zcodepp.js install          # 默认探测 D:\ZCode，可用 --app <ZCode.exe> 指定

# 3. 启动 ZCode，正常使用
#    - 右下角出现 "Z++" 悬浮按钮 = runtime 已生效
#    - 左下角 "ZCode++ ✓" 徽标 = 内置 renderer tweak 生效
#    - Ctrl+Alt+Shift+D = 内置 main tweak 注册的 DevTools 快捷键

# 4. 状态与日志
node bin/zcodepp.js status
type "%USERPROFILE%\.zcode\zcode-plusplus\log\main.log"
```

## 写一个自己的 tweak

```bash
node bin/zcodepp.js new-tweak my-first --scope renderer
node bin/zcodepp.js validate-tweak my-first
node bin/zcodepp.js dev my-first     # 热重载开发
```

最小组成为 `manifest.json` + `index.js`（导出 `start(api)` / 可选 `stop(api, ctx)`）：

```js
// my-first/index.js  (scope: renderer)
module.exports = {
  start(api) {
    api.settings.registerPage({
      id: 'main',
      title: 'My First',
      render(root) { root.textContent = 'Hello from my tweak!'; },
    });
  },
};
```

详见 [docs/WRITING-TWEAKS.md](docs/WRITING-TWEAKS.md)（API 一览、main scope、原生模块、
设置注入选择器），架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常用命令

| 命令                          | 作用                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `install [--app p] [--no-watcher]` | 打补丁 + 部署 runtime（需退出 ZCode）               |
| `uninstall [--purge]`         | 恢复原始 app.asar；`--purge` 连 tweak/配置一起删          |
| `status` / `doctor`           | 安装状态 / 健康检查                                       |
| `repair`                      | ZCode 更新后重打补丁（幂等，运行中自动跳过）              |
| `safe-mode on/off`            | 不动补丁地停用/启用所有 tweak                             |
| `debug [--port 9223]`         | 带 CDP 远程调试端口启动 ZCode，便于 tweak 开发            |
| `tweaks enable/disable <id>`  | 启停某个 tweak                                            |

## 卸载

```bash
node bin/zcodepp.js uninstall --purge   # 恢复 asar + 删除全部 ZCode++ 数据
```

## 已实测环境

- ZCode 桌面版 `@zcode/desktop` 3.16.3（Electron，ESM 主入口，React 19 + Radix UI）
- `EnableEmbeddedAsarIntegrityValidation=Disabled`、`OnlyLoadAppFromAsar=Disabled`
  （doctor 会在安装前复核；若未来版本开启，install 会拒绝并说明）
- Windows 10/11，Node 18–24

## License

MIT
