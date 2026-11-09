# 文件职责 / Module responsibilities

| 目录 | 职责 / Responsibility |
| --- | --- |
| `mac/patchers/desktop` | 原输入校验、字节补丁、ASAR 打包、应用签名 / Input validation, patching, packaging and app signing |
| `mac/clients/desktop` | 连接、原 UI 适配、通知、语音、本机操作；Mac 与 Windows 共用 / Connection, original UI adapters, notifications, voice and local execution; shared by Mac and Windows |
| `windows/patchers/desktop` | Windows 原版校验与解包、补丁、ASAR 完整性、便携版与安装包 / Windows input validation, extraction, patching, ASAR integrity, portable and installer outputs |
| `windows/installer` | 按用户安装与卸载程序源码（Go 标准库） / Per-user installer and uninstaller source (Go standard library) |
| `windows/tools` | 由 Mac recipe 移植并校验 Windows recipe / Port and verify Windows recipes from the Mac recipes |
| `ios/release` | 用户 IPA 校验与未签名输出 / User IPA validation and unsigned export |
| `ios/clients/ios` | 注入源码、原生界面与功能适配 / Injection source and native adapters |
| `ios/bin` | 本项目预编译 dylib / Precompiled project dylib |
| `host/server` | 管理网页、认证、设备、模型与供应商服务 / Administration, authentication, devices, models and providers |
| `host/runtime` | 原 Host/Harness 的本地适配 / Local Host/Harness adapters |
| `host/deploy` | Host 监督进程、独立执行节点 / Host supervisor and execution node |
| `host/release` | 原资源获取、Docker 构建、Compose 与备份恢复 / Original input acquisition, Docker, Compose and volume backups |
| `*/recipes` | 从用户原文件复制字节并添加本项目修改 / Copy original bytes from user input and add project modifications |
| `*/network`、`*/clients/shared` | Tailcat 构建与进程管理 / Tailcat build and process management |
| `*/THIRD_PARTY` | 第三方许可证 / Third-party notices |

- `mac/clients/desktop/attachment-uploads.mjs`：原版附件暂存、分块提交和进度。
- `ios/clients/ios/GBVoiceSocket.m`：已配对 Host 的系统 WebSocket 语音传输。
- `host/runtime/host-attachments.mjs`：Host 附件复制到独立执行节点。

- `mac/clients/desktop/external-links.mjs`、`external-url.mjs`：外部链接与原生菜单 / External links and native menus.
- `mac/clients/desktop/link-preview*.mjs`：按需预览、固定 DNS、站点图标与有界缓存 / On-demand previews, pinned DNS, site icons and bounded cache.
- `ios/clients/ios/GBNetwork.m`：串行隧道状态、延迟启动和同端口恢复 / Serialized tunnel lifecycle, lazy startup and same-port recovery.

- `CHANGELOG.md`：更新记录 / Changelog. `NOTICE`：上游来源与修改清单 / Upstream source and list of modifications.
- `docs/INSTALL*.md`：安装与连接 / Installation and connection.
- `docs/ARCHITECTURE*.md`：功能对照与实现原理 / Feature map and architecture.
- `ios/docs/SIGNING*.md`：iOS 扩展签名 / Extension signing.
- `host/docs/DEPLOYMENT*.md`：分开部署与备份 / Separate deployment and backups.

- `mac/patchers/desktop/download-original.mjs`：固定原版下载、缓存与校验 / Pinned original download, caching and verification.

- `docs/AI-INSTALL*.md`：供 AI 执行的部署、配置与验收指南 / AI deployment, configuration and verification guide.
- `docs/TECHNICAL*.md`：本版本的改动与二次开发入口 / Changes in this fork and extension points.

- `mac/clients/desktop/local-services.mjs`：置顶与分组的原 Host 设置适配、账户缓存恢复。 / Native Host settings for pins and groups, with account cache restoration.

- `mac/clients/desktop/platform.mjs`：Windows 窗口样式、标题栏按钮、托盘、开始菜单快捷方式与窗口方法 / Windows chrome, caption buttons, notification-area icon, Start menu shortcut and window RPCs.
- `host/runtime/model-session.mjs`：模型会话，按配置分派到三种接口格式 / Model session dispatching to the three API formats.
- `host/runtime/openai-chat.mjs`、`openai-responses.mjs`、`anthropic-messages.mjs`：各接口格式的消息转换、思考强度、推理接续与流式解析 / Per-format conversion, reasoning effort, reasoning replay and stream parsing.
- `host/runtime/model-common.mjs`：共用的错误、SSE、媒体、推理来源标记与可选参数回退 / Shared errors, SSE, media, reasoning provenance and optional-parameter fallback.
- `windows/patchers/desktop/pe.mjs`、`zip.mjs`：可执行文件图标、ASAR 完整性与签名表处理，便携 zip / Executable icon, ASAR integrity and certificate table, portable zip.
- `host/tools/host-admin.mjs`：命令行管理工具 / Admin command-line tool.
- `host/runtime/web-services.mjs`、`host/server/media-providers.mjs`：联网工具与图片生成的服务商适配 / Web tool and image provider adapters.
- `host/runtime/reliability/tool-order.mjs`：同一回复中多条消息的送达顺序 / Delivery order of messages from one reply.
- `host/runtime/host-auto-review.mjs`：自动审查，格式错误时重试一次并记录日志 / Auto review with one retry and failure logging.
- `mac/clients/desktop/local-exec.mjs`：本机命令；Windows 上启用原版 PowerShell 的 UTF-8 输出 / Local commands; enables the original PowerShell UTF-8 output on Windows.
