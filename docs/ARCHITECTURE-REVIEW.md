# Daynora 架构检查（本轮）

## 结论

当前结构已经满足“低耦合”的主要要求，数据层、系统能力和 UI 编排是分开的：

```text
src/
  core.ts                 领域规则：日期、任务、排序、进度
  types.ts                共享数据契约
  data/                   示例数据、导入导出
  store/repository.ts     存储接口 + Tauri / 浏览器实现
  features/
    audio.ts              白噪音、环境音、提醒音
    focus.ts              番茄钟状态、暂停、保存与恢复
    notifications.ts      提醒判断
    search.ts             搜索匹配
    weather.ts            天气、城市解析、缓存
    zoom.ts               页面缩放
  app.ts                  页面编排与事件绑定

src-tauri/
  db.rs                   SQLite、迁移、DPAPI、备份
  system.rs               托盘、通知、开机自启、文件夹
  lib.rs                  Tauri 组装入口
```

## 内聚性

- `features/*` 每个模块只负责一个能力，内聚性较高。
- `store/repository.ts` 用接口隔离存储实现，SQLite 与浏览器的差别不会扩散到页面。
- `core.ts` 不依赖 DOM 和 Tauri，可以单独测试。
- `db.rs` 和 `system.rs` 把本机能力集中在 Rust 侧，前端只通过命令调用。

## 耦合点

当前最大耦合点是 `src/app.ts`。它同时承担：

- 页面结构生成
- 事件绑定
- 状态管理
- 弹窗与面板切换
- 与存储、音频、天气、通知的协调

这仍然可以工作，但继续增加功能后维护成本会上升。下一次重构建议把 `app.ts` 拆成：

```text
src/ui/
  header.ts
  workspace.ts
  modals.ts
  focus-overlay.ts
  render.ts
```

`app.ts` 只保留状态初始化、事件路由和持久化协调。

## 本轮已做

- 新增 `features/audio.ts`、`features/search.ts`、`features/zoom.ts`。
- 把番茄钟的暂停、恢复和本地保存放入 `features/focus.ts`。
- 把天气和反向地理编码放入 `features/weather.ts`。
- 页面层不再直接承担音频合成和搜索匹配逻辑。

## 数据流

```text
用户操作
  -> app.ts 事件路由
  -> features/*（计算、播放、搜索、天气、计时）
  -> store/repository.ts
  -> Tauri 命令
  -> db.rs / system.rs
```
