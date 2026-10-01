# Daynora 架构说明

## 总体结构

Daynora 采用本地优先结构：

```text
Vite 前端（TypeScript / HTML / CSS）
        │
        ├── 领域逻辑：任务、目标、日期、重复、进度
        ├── 仓库接口：浏览器临时实现 / 后续 SQLite 实现
        └── Tauri IPC
                │
                └── Rust 桌面壳：窗口、文件、数据库、托盘、通知、更新
```

前端不直接依赖某个数据库。第二次任务会把 `Repository` 从 `LocalStorageRepository` 切换到 SQLite 实现，界面代码不需要重写。

## 数据模型

- `Task`：标题、日期、时间、时长、分类、优先级、备注、子任务、图标、重复规则、完成状态、排序。
- `Goal`：目标名称、说明、目标日期、进度、状态、关联任务。
- `Category`：用户自定义分类与颜色。
- `Settings`：主题、语言、时间制、自动保存、启动行为、天气城市等。

## 数据目录

Windows 正式版计划将数据放在：

```text
%APPDATA%\com.knowlira.daynora\
  daynora.db
  backups\
  logs\
  config.json
```

第一次任务仍使用浏览器 `localStorage` 做开发占位，避免在没有 SQLite 依赖时阻塞界面开发。

## 加密策略

正式版优先使用以下方案：

- 数据库文件位于用户目录，使用 Windows 用户权限保护。
- 敏感文本字段使用 AES-GCM 加密。
- 主密钥由 Windows DPAPI 保护，不写入源码和数据库。
- 删除、迁移和导入前自动生成备份。

SQLCipher 能加密整个数据库文件，但在 Windows 上需要额外本机库和构建链。第二次任务会先验证 DPAPI + 字段级加密方案；如果你坚持全库 SQLCipher，再单独安排依赖下载和构建验证。
