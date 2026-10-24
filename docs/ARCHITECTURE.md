# ZCode++ 架构

ZCode++ 是 ZCode 桌面应用的 tweak（插件）框架，思路与 Codex++ 相同：给 `app.asar`
打一个最小补丁，让自定义 loader 最先启动，再从**用户目录**加载 runtime 与 tweaks。
应用本体永远可以正常启动（fail-open），tweak 代码不进 asar，迭代无需重新打补丁。

```
┌─ D:\ZCode (应用安装目录) ──────────────────────────────────────┐
│ resources/app.asar  ← 只改两处:                                 │
│   package.json.main → zcodepp-loader.mjs                        │
│   + 追加 zcodepp-loader.mjs (~1KB, 首次启动链)                  │
└─────────────────────────────────────────────────────────────────┘
            │ 启动时
            ▼
     zcodepp-loader.mjs (asar 内)
       1. 设 ZCODEPP_USER_ROOT
       2. import('electron') → globalThis.__zcodepp
       3. import(<userRoot>/runtime/main.mjs)   ← 失败仅告警
       4. import('./out/main/index.js')          ← ZCode 原入口, 必达
            │
            ▼
┌─ ~/.zcode/zcode-plusplus (用户目录) ───────────────────────────┐
│ runtime/main.mjs     主进程 runtime                              │
│   · session.registerPreloadScript() 附加式注册 preload          │
│     (带回退 setPreloads；不覆盖 ZCode 自己的 preload)           │
│   · IPC: get-state / read-bundle / storage-get/set / 日志       │
│   · 加载 scope=main|both 的 tweak (CJS require, 可热重启)       │
│   · app.on('browser-window-created') → 补注册 + 通知 tweaks     │
│ runtime/preload.cjs  渲染侧 preload (自包含单文件, 兼容沙箱)     │
│   · contextBridge 暴露 window.__zcodepp (调试用)                │
│   · 加载 scope=renderer|both 的 tweak:                          │
│     - 非沙箱: 直接 require (可用 node 内置模块)                  │
│     - 沙箱:   IPC 预取整个 tweak 目录 → 内存内同步 CJS 求值      │
│   · Z++ 悬浮面板 (always) + 原生设置注入 (选择器可配, 自愈)      │
│ runtime/lib/*.cjs    logger / storage / discovery / hot-reload  │
│ runtime/config.json  注入选择器等运行时配置                      │
│ tweaks/<id>/         用户 tweak: manifest.json + index.js       │
│ tweak-data/<id>/     每 tweak 数据沙箱 (storage.json)           │
│ backup/app.asar.orig 原始 asar 备份 (uninstall 恢复)            │
│ cli/                 CLI 自包含副本 (watcher 调它跑 repair)     │
│ config.json          开关 (safeMode / tweaks 启停 / dev)        │
│ state.json           安装记录 (哈希、路径、版本)                 │
│ log/                 main.log / main.log.old                    │
└─────────────────────────────────────────────────────────────────┘
```

## asar 补丁原理

ZCode 的 `app.asar` 约 341MB，头部 JSON 约 7.3MB。**不做全量解包**，采用定向重建：

1. 解析头部（布局已实测对齐 @electron/asar：`[u32=4][u32 pickleSize][u32 payloadSize][u32 jsonLen][json+4字节对齐]`，条目偏移相对头部结尾）。
2. 新文件 = 新头部 + **原样流式拷贝原数据区** + 末尾追加（改写的 package.json + loader）。
   原有条目偏移量是相对值且数据区整体连续，未动条目天然有效。
3. 打补丁前先备份到用户目录；写临时文件校验（字节级对比 + 抽样哈希）后再原子替换。
4. 校验通过后与 `@electron/asar list` 交叉验证（测试内完成）。

安全性前提（安装时 doctor 会检查）：ZCode 的 Electron fuse
`EnableEmbeddedAsarIntegrityValidation = Disabled`、`OnlyLoadAppFromAsar = Disabled`（已实测）。
Windows 无需重签名。若未来版本开启完整性校验 fuse，install/doctor 会拒绝并提示。

## 更新防护

ZCode 用 electron-updater 自更新，每次更新都会覆盖掉补丁：

- `zcodepp repair` 幂等修复：比对 asar 哈希，等于补丁哈希→退出；等于原始哈希→重打；
  未知（新版本）→ 采纳新原始备份后重打。ZCode 运行中则安全跳过。
- 安装时默认注册两个计划任务（每小时 + 登录时）调用 `cli/bin/zcodepp.js repair --quiet`，
  `--no-watcher` 可不装。`uninstall` 会一并删除任务。

## 设置界面集成策略（实测结论）

对 ZCode 3.16 渲染产物做静态分析：UI 基于 **Radix primitives + 自研 tab 系统**，
设置页是**主窗口 tab 系统中的一个 tab**（非独立 Radix 对话框）。因此：

- **主入口是 Z++ 悬浮面板**（右下角圆形按钮），100% 可靠、与 ZCode DOM 解耦；
- 原生注入代码保留且**选择器全可配**（`runtime/config.json`），MutationObserver 自愈式
  注入 `[role="dialog"]` 类容器；用 `zcodepp debug` 打开 CDP 实测后，可把选择器调整到
  任意容器（包括设置 tab 的内容区）。ZCode 改版最多导致注入不显示，绝不影响应用。

## fail-open 原则

loader、runtime、preload 的每一层都用 try/catch 包裹：任何一层崩溃，ZCode 照常启动
（loader 无条件 import 原入口；preload 的失败只影响 tweaks，不影响页面）。`safe-mode on`
可在不动补丁的情况下停用所有 tweak 以便排查。
