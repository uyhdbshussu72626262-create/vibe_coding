# 第一次任务依赖说明

本机已经具备：

- Rust 1.96.0 与 Cargo 1.96.0
- Node.js 24.15.0 与 npm 11.12.1
- Visual Studio 18 Community（含 C++ 桌面工具）
- Microsoft Edge WebView2 Runtime 153.0.4234.48

因此第一次任务只需要安装 Node 依赖；Rust 依赖会在首次运行 Tauri 时由 Cargo 下载到用户缓存。

## 1. Node 依赖

打开 PowerShell，进入项目目录：

```powershell
Set-Location 'C:\Users\zhanshen\Desktop\target\daynora'
npm install
```

下载位置：

```text
C:\Users\zhanshen\Desktop\target\daynora\node_modules
```

如果你希望使用国内镜像：

```powershell
npm config set registry https://registry.npmmirror.com
npm install
```

## 2. Rust / Tauri 依赖

第一次运行以下命令时，Cargo 会自动下载依赖：

```powershell
Set-Location 'C:\Users\zhanshen\Desktop\target\daynora'
npm run tauri:dev
```

Cargo 下载位置：

```text
C:\Users\zhanshen\.cargo\registry\cache
C:\Users\zhanshen\.cargo\registry\src
C:\Users\zhanshen\Desktop\target\daynora\src-tauri\target
```

当前任务只使用 Tauri 核心依赖，不安装 SQLite、天气、托盘、通知和更新插件；这些会在第二、三次任务前给出单独的依赖清单。

## 3. 验证

```powershell
npm run test:unit
npm run dev
```

浏览器地址：

```text
http://127.0.0.1:1420
```

`npm run dev` 能打开三栏页面，`npm run tauri:dev` 能打开 Daynora 桌面窗口，第一次任务即视为可继续。
