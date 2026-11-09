# 进度 / Status

## ProkBot Plus 1.0.0（2026-11-10）

- [x] Windows x64 客户端（0.71.2）：便携版与安装包；对话、托盘、通知、附件、本机命令、Codex。实测配对、对话、本机命令、安装与卸载。 / Windows x64 client with portable and installer builds; pairing, chat, local commands, install and uninstall tested.
- [x] Anthropic Messages、OpenAI Responses 与 OpenAI Chat 三种模型接口；连接测试与自动审查三种格式通用。 / Three model API formats, with connection test and auto review for each.
- [x] 联网工具与图片生成：新版 Claude 回退、并行搜索容错、比例换算、参考图修图；实测 Opus 5.5 联网与 GPT Image 2.6 生图、修图。 / Web and image fixes, tested with Claude Opus 5.5 web tools and GPT Image 2.6.
- [x] 消息顺序、自动审查重试与日志、中文 Windows 命令输出编码、Windows 上显示 Host 图片。 / Message order, auto review retry and logging, Windows command output encoding, Host images on Windows.
- [x] 测试：服务端 35 项、Windows 8 项、Mac 15 项全部通过。 / Tests: 35 server, 8 Windows, 15 Mac, all passing.
- [ ] Windows 本机鼠标键盘控制（原版组件只有 macOS 版本）。 / Windows local mouse and keyboard control (the original helper is macOS only).
- [ ] Windows 客户端代码签名。 / Code signing for the Windows client.
- [ ] Windows 客户端的 Tailcat 与实时语音尚未与真实 Host 联调。 / Windows Tailcat and realtime voice not yet tested against a live Host.
- [ ] ARM64 服务端（原版桌面镜像只有 amd64）。 / ARM64 servers (the original desktop image is amd64 only).

## 上游 ProkBot 进度 / Upstream ProkBot status

2026-11-05

- [x] Mac、iOS、Host 独立补丁工具；校验用户原版输入，保留原文件。
- [x] 用户本地生成 Docker 镜像；DSM 实机部署、模型与工具、备份恢复验证。
- [x] 可选 Tailcat、主/成员 Host、独立执行节点、自定义 DERP。
- [x] 原 Bot/Skill 发布界面与 Host 导入导出。
- [x] Bark 图标、分组、前台抑制及会话跳转。
- [x] Mac 使用原播放组件和系统回声处理，实际插话验证。
- [x] iOS 原生回声处理、AEC3 与持续讲话缓冲；实验性通话默认关闭，已安装实测。
- [ ] 真人近距离插话、耳机及蓝牙路由的进一步验证。
- [x] 统一应用、Mac Codex 委派、群聊成员与名称持久化。
- [x] 中英文 Host 管理界面、K/M 上下文配置和共享通知频率。
- [ ] 耳机/蓝牙切换与 Wi-Fi/蜂窝切换的真实设备验证。现有 iPhone 11 测试设备没有 SIM 卡。

The three patch tools and Docker deployment are implemented and validated with user-supplied originals. iOS voice includes native echo processing, AEC3 and buffered interruption; the experimental voice feature is disabled by default. Headphone/Bluetooth and cellular transitions still need matching hardware for validation.

- [x] 2026-10-27：Mac 原附件预览与下载；Host 补丁运行依赖补齐并检查。 / Mac attachment previews and downloads; Host patch runtime dependency fix and checks.

- [x] 2026-10-27：Mac 附件暂存/上传与手机图片读取；iOS 通话 TLS 兼容与音频清理；Host 附件复制到独立执行节点。
- [x] Mac 麦克风：用户重新切换系统麦克风权限后恢复；虚拟麦克风完整通话通过。
- [ ] 剪贴板图片完整 UI 验收待完成。
- [x] 2026-10-27：启动时先恢复 Host 凭据，已连接客户端不再预先显示连接窗口。

- [x] 2026-10-29：Mac 外部链接、原预览与右键菜单；iOS Tailcat 串行状态、请求前启动、同端口恢复及真实连接状态。
- [x] 34 项 Mac 测试、原生网络生命周期测试、Go race 与真实公共 DERP 传输通过；iOS arm64 构建通过。
- [ ] 本版 iPhone 11 冷启动、后台返回与网络切换复验；本轮没有连接的测试设备。

- [x] 2026-10-29：Mac 恢复原生 Command+W，关闭后保留后台进程，重新打开恢复原会话；13 项测试及实际键盘操作通过。

- [x] 2026-11-01：精简公开版 README、安装文档与发布说明，准备三个补丁包。
- [x] 公开发布 [v2026.11.01](https://github.com/ahaduoduoduo/ProkBot/releases/tag/v2026.11.01)，提供三个补丁包。

- [x] 2026-11-01：Mac 补丁自动下载指定原版，支持缓存与本地输入；实际下载、生成与签名检查通过。

- [x] 2026-11-01：README 提供可复制的 AI 安装指令，具体步骤放入独立指南，加入 iOS 下载入口。

- [x] 2026-11-05：Mac Bot 置顶、分组与折叠状态恢复；复用原 Host 设置，自动化和原界面冷启动验证通过。 / Restore Mac Bot pins, sidebar groups and collapse state using existing Host settings.

- [x] 2026-11-08：Windows x64 客户端（0.71.2）：recipe 由 Mac 版移植并逐段校验，原版窗口样式、托盘、通知、本机命令、Codex 与 Tailcat；便携目录、便携 zip 与按用户安装包。实测配对、对话、本机命令、通知、关闭到托盘、安装与卸载。 / Windows x64 client with ported, verified recipes; portable and installer outputs; pairing, chat, local commands, notifications, tray and install/uninstall tested.
- [x] 2026-11-08：Host 支持 Anthropic Messages 接口格式（图片、工具、自适应思考与带签名思考回放、拒答回退）；Linux 部署在 Ubuntu 24.04 + Docker 29 实测，修复 containerd 镜像存储下的 Box 镜像校验。 / Anthropic Messages format in the Host; Linux deployment tested on Ubuntu 24.04 with Docker 29, Box verification fixed for the containerd image store.
- [ ] Windows 本机图形界面控制（原版组件仅 macOS）；Windows 客户端的 Tailcat 与实时语音尚未与真实 Host 联调。 / Windows local graphical control (the original helper is macOS only); Windows Tailcat and realtime voice not yet tested against a live Host.
- [x] 2026-11-08：模型接口三种格式（OpenAI Chat、OpenAI Responses、Anthropic Messages）统一实现：思考强度映射（含 minimal）、推理来源标记与多轮回放、文件与截图、可选参数回退、自动审查与连接测试；单元测试 17 项，真实接口实测 14 个模型组合与 6 个审查组合。 / Three API formats with effort mapping, reasoning provenance and replay, media, optional-parameter fallback, review and test; 17 unit tests, 14 live model and 6 live review combinations.
