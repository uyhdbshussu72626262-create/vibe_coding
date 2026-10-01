# 第三次任务依赖说明

第三次任务没有新增 npm 包。前端仍然使用已经安装的 `@tauri-apps/api`。

新增 Rust 依赖：

```powershell
Set-Location 'D:\Rust_Desktop_app\source_code\daynora'
cargo fetch --manifest-path src-tauri\Cargo.toml
```

新增 crate：

- `tauri-plugin-notification`：https://crates.io/crates/tauri-plugin-notification
- `tauri-plugin-autostart`：https://crates.io/crates/tauri-plugin-autostart

下载位置：

```text
C:\Users\zhanshen\.cargo\registry\cache\index.crates.io-1949cf8c6b5b557f
C:\Users\zhanshen\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f
D:\Rust_Desktop_app\source_code\daynora\src-tauri\target
```

字体仍需放在：

```text
D:\Rust_Desktop_app\source_code\daynora\public\fonts\
  NotoSansSC-Regular.woff2
  NotoSansSC-Medium.woff2
```

最终构建与打包：

```powershell
Set-Location 'D:\Rust_Desktop_app\source_code\daynora'
npm run test:unit
npm run tauri:build
powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1
```

打包脚本输出：

```text
D:\Rust_Desktop_app\run_app\installer\      NSIS 安装包
D:\Rust_Desktop_app\run_app\portable\      便携版目录
D:\Rust_Desktop_app\run_app\Daynora-portable.zip
D:\Rust_Desktop_app\source_code\daynora-source.zip
```
