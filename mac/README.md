# ProkBot Plus Mac Patch

为 Grok Bot 0.71.2 Apple Silicon 客户端连接自己的 Host。需要 Node.js 22.12+。

完整的部署步骤见 [AI 部署手册](../docs/AI-INSTALL.md#92-macapple-silicon)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-客户端)。`clients/desktop/` 是客户端主进程，Windows 客户端和 Android 客户端也用到这里的代码。

[English](README.en.md)

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具自动下载并校验 0.71.2 Apple Silicon 原版，生成 `output.noindex/Grok Bot.app`。移入「应用程序」，填写 Host 地址和六位配对码。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。维护者没有 Mac 测试设备，本轮未在 macOS 上验证安装、启动、配对或聊天。可接受的原包和官方最新版本分别见[首页版本表](../README.md#client-versions)。

需要控制本机图形界面时，在命令中增加 `--identity auto`，使用已有签名证书。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助生成。
