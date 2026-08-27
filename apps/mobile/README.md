# @ai2sapien/mobile

AI2Sapien 的 Expo / React Native 移动伴随端框架。

当前只保留可运行的跨平台壳、品牌首页和共享契约接入，不实现移动端业务。Windows MVP 完成后，优先接入：

1. 桌面配对与加密同步；
2. 复习队列与离线作答；
3. 错题、补救卡和学习进度；
4. Android 构建；
5. iOS 与 macOS 一起规划。

移动端不直接启动或暴露 Codex App Server。Plus 支持由用户自己的桌面端运行时提供；完全独立的移动 AI 模式需要另行设计服务端与 API 计费。

```powershell
npm run start -w @ai2sapien/mobile
```
