# @ai2sapien/desktop

AI2Sapien 的 Electron + React 桌面工作区。当前切片提供：

- 安全的 Main / Preload / Renderer 分层；
- 本机 Codex App Server 连接检测；
- ChatGPT 登录状态、套餐和 Codex 用量展示；
- 浏览器登录、登出和手动刷新入口。

Renderer 只能通过类型化 preload bridge 访问功能，不直接接触 Node.js、文件系统、Codex JSON-RPC 或认证凭证。

## 启动开发版

在仓库根目录运行：

```powershell
npm install
npm run dev:desktop
```

## 生成 Windows 安装包

```powershell
npm run package:win
```

产物位于 `apps/desktop/release/AI2Sapien-Setup-<version>-x64.exe`。安装器使用 NSIS，支持选择安装目录，并创建桌面和开始菜单快捷方式。

当前版本的 AI 能力由本机 `codex app-server` 提供，因此安装后的电脑仍需安装 Codex CLI，并使用自己的 ChatGPT 账号登录；应用本身不会保存账号原始凭证。

当前开发包尚未配置 Windows 代码签名，首次运行可能显示“未知发布者”。正式公开发布前需要配置签名证书和应用图标。

GitHub 的 `Windows installer` workflow 也可手动运行；构建完成后，从该次 Actions 运行页下载 `AI2Sapien-Windows-x64` artifact。
