# ProkBot Plus Mac 补丁

[English](README.en.md)

为 Grok Bot 1.3.0 macOS 客户端连接自己的 Host，支持 Apple 芯片（Apple Silicon）和 Intel 芯片。需要 Node.js 22.12+。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-client)。`clients/desktop/` 是客户端主进程，Windows、Linux 和 Android 客户端也用到这里的代码。

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具按本机芯片自动下载并校验 1.3.0 原版（Apple 芯片用 ARM64 版，Intel 用 x64 版），生成 `output.noindex/Grok Bot.app`。移入「应用程序」，填写 Host 地址和 6 位配对码。连接页的 Tailcat 开关只在粘贴 Host 管理页「远程访问」里的连接链接时打开，填局域网或 HTTPS 地址时保持关闭。给另一种芯片的 Mac 生成时，加 `--arch arm64` 或 `--arch x64`。

**Apple 芯片与 Intel Mac**：官方为 Apple 芯片和 Intel 分别提供了 1.3.0 安装包。两者的预加载模块和业务逻辑一致，仅构建哈希和本机模块不同。`patchers/desktop/recipes/` 与 `patchers/desktop/x64/recipes/` 均由 `windows/tools/desktop-recipes/build.mjs`（`--target mac-arm64` / `--target mac-x64`）按同一套锚点规则生成，注入的本项目代码完全相同；Tailcat 分别提供 arm64（`dist/network/`）与 x86_64（`dist/network/x64/`）版本。1.3.0 尚未在 Mac 真机上测试。如果它在你的 Mac 上用不了，可以从 Releases 下载 **v1.14.0** 的 Mac 发布包生成上一版 `1.2.3`（Intel Mac 上实测可用），或下载 **v1.7.0** 的 Mac 发布包生成 `0.71.2` 回退版。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。DMG 按文件大小识别是哪种芯片的版本；`.app` 不是本机芯片的版本时，再加 `--arch`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。可接受的原包和官方最新版本见[首页版本表](../README.md#client-versions)。

需要控制本机图形界面（Computer Use）时，在命令中增加 `--identity auto`，使用已有 Apple Development / Developer ID 签名证书，并自动更新 `CUGrokBotService` 的可信 Team ID。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
