# AI2Sapien · 人工智人

> From AI output to human mastery.
> 把 AI 的输出，转化为人真正掌握的知识。

AI2Sapien 是一个本地优先的自适应学习桌面应用。学习者上传自己的课程资料，系统建立可追溯的知识地图，通过多 Agent 完成诊断、独立验题、批改、错因分析、视觉补救、定向复测与间隔复习。

## 当前阶段

项目处于 **Spike 0 / 技术可行性验证**：

- [x] 产品架构与学习闭环
- [x] OpenAPI 3.1 业务接口契约
- [x] 多 Agent Artifact JSON Schema
- [x] Codex App Server JSON-RPC 基础适配层
- [x] ChatGPT 浏览器登录与账户状态 UI
- [x] Rate limit UI
- [ ] Thread/Turn 流式演示
- [x] Electron 安全桌面壳
- [x] Windows x64 NSIS 安装包与 GitHub 构建流程
- [x] Expo / React Native 手机伴随端框架
- [x] 材料上传与划词解释
- [x] 练习闭环切片：出题 → 独立验题 → 作答+推理评审 → 错因补救 → 复测 → 掌握度
- [x] 可插拔 AI 提供者：Codex（ChatGPT 登录）/ OpenAI 兼容接口（OpenAI、Ollama 等）/ Anthropic Claude，统一流式会话

## 为什么使用 Codex App Server

AI2Sapien 通过本机 `codex app-server` 连接 Codex，使用官方 ChatGPT 登录流程、会话历史、流式事件和审批协议。应用不把 ChatGPT Plus 当作 API Key，也不读取或保存用户的原始 ChatGPT Token。

官方协议文档：https://learn.chatgpt.com/docs/app-server

## 仓库结构

```text
apps/
  desktop/            Electron + React Windows 桌面端
  mobile/             Expo / React Native 手机伴随端框架
packages/
  agent-runtime/      Codex App Server 进程与 JSON-RPC 适配
  contracts/          UI/Core 共享领域类型
  learning-core/      学习用例与领域规则
contracts/            OpenAPI 与 Agent Artifact JSON Schema
docs/                 中文架构、接口和需求文档
```

## 本地开发

要求：

- Node.js 22+
- npm 10+
- 已安装并可从命令行运行的 Codex CLI

```powershell
npm install
npm run check
```

启动 Windows 桌面开发版：

```powershell
npm run dev:desktop
```

生成 Windows x64 安装包：

```powershell
npm run package:win
```

安装包输出到 `apps/desktop/release/`。当前开发构建未做代码签名，正式发布前需要配置 Windows 签名证书。

启动手机伴随端开发框架：

```powershell
npm run dev:mobile
```

用 Expo Go 扫描二维码即可查看。现阶段手机端只保留界面和共享契约入口，AI 运行时仍放在用户自己的桌面端；Android/iOS 业务与 macOS 客户端在后续迭代接入。

只读取并脱敏显示本机 Codex 连接与登录状态：

```powershell
npm run smoke:codex
```

重新生成与本机 Codex 版本一致的 App Server 协议类型：

```powershell
npm run generate:codex-schema
```

离线验证练习闭环（无需 Codex，使用模拟运行时）：

```powershell
npm run smoke:practice
```

## 设计文档

- [系统架构](./docs/自适应学习桌面端_系统架构_v0.1.md)
- [独立 SVG 架构图](./docs/自适应学习桌面端_系统架构_v0.1.svg)
- [接口说明](./docs/自适应学习桌面端_接口说明_v0.1.md)
- [需求补充表](./docs/自适应学习桌面端_需求补充表_v0.1.md)
- [OpenAPI](./contracts/learning-core.openapi.json)
- [Agent Artifact Schema](./contracts/agent-artifact.schema.json)

## 安全基线

- Renderer 不接触文件系统、ChatGPT 凭证或 App Server 原始通道。
- 首版使用本地 stdio，不开放 App Server 网络端口。
- 学习任务默认只读、禁网；任何命令、文件、联网或工具审批都由用户决定。
- 题目和解释必须带来源证据；带图内容发布前必须通过文件、解码、尺寸、替代文本和渲染检查。

## License

[MIT](./LICENSE)
