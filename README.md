# Desk Mask

<p align="center">
  <img src="src/wizard-hat-icon.png" width="128" alt="Desk Mask 图标">
</p>

<p align="center">一个为 Windows 11 与 macOS 设计的桌面视觉遮罩工具。</p>

Desk Mask 会在桌面最上层叠加一层可调颜色与透明度的全屏遮罩，帮助降低屏幕带来的视觉刺激。它不会拦截鼠标点击，也不改变正在使用的应用。

## 功能

- 实时调整遮罩颜色与透明度，并在应用前预览效果。
- 遮罩淡入、淡出动画；启用后可选 10 秒确认，未确认自动回退。
- 保存、应用和删除多套本地预设。
- 系统托盘快速开启、关闭遮罩，关闭主窗口时仍可继续运行。
- 开机启动、启动后自动显示遮罩、定时启用。
- 可录入全局快捷键；仅接受三个按键组成的组合键，例如 `Cmd/Ctrl + Shift + M`。
- 支持 Windows 11 与 macOS。

## 使用方式

1. 在“遮罩”页面选择颜色与透明度。
2. 打开“应用遮罩”开关。
3. 若启用了“应用前确认”，请在 10 秒内选择“保存”或“取消”。
4. 常用方案可保存为预设，也可在设置页配置开机启动、定时启用和快捷键。

## 下载与安装

Windows 安装包会在 GitHub Releases 或对应 GitHub Actions 构建产物中提供。安装后直接运行 `Desk Mask` 即可。

## 本地开发

### 环境

- Node.js 22+
- Rust stable（Cargo 1.85+）
- Windows：WebView2 Runtime 与 Microsoft C++ Build Tools
- macOS：Xcode Command Line Tools

### 启动

```bash
npm ci
npm run tauri dev
```

### 构建

```bash
npm run tauri build
```

Windows 构建后的安装包通常位于：

```text
src-tauri/target/release/bundle/
```

## 已知边界

- 这是视觉遮罩，不会直接调低显示器背光或物理亮度。
- HDR 模式下遮罩通常仍可生效，但颜色与主观亮度可能因显示器、Windows SDR 内容亮度设置而不同。
- 独占全屏游戏、部分 DRM 视频或受驱动保护的内容，可能无法被普通桌面窗口覆盖。
- 当前版本将遮罩应用到全部显示器；独立多屏配置仍在开发中。

## 技术栈

- [Tauri 2](https://v2.tauri.app/)
- Rust
- TypeScript + Vite + CSS

## License

暂未指定许可证。
