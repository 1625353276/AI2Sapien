# @ai2sapien/desktop

AI2Sapien 的 Electron + React 桌面工作区。当前切片提供：

- 安全的 Main / Preload / Renderer 分层；
- 本机 Codex App Server 连接检测；
- ChatGPT 登录状态、套餐和 Codex 用量展示；
- 浏览器登录、登出和手动刷新入口。

Renderer 只能通过类型化 preload bridge 访问功能，不直接接触 Node.js、文件系统、Codex JSON-RPC 或认证凭证。
