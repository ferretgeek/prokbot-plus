# ProkBot Plus Mac 补丁

[English](README.en.md)

为 Grok Bot 1.3.0 macOS 客户端连接自己的 Host，支持 Apple 芯片（Apple Silicon）和 Intel 芯片。需要 Node.js 22.12+。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-client)。`clients/desktop/` 是客户端主进程，Windows、Linux 和 Android 客户端也用到这里的代码。

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具按本机芯片自动下载并校验 1.3.0 原版（Apple 芯片用 ARM64 版，Intel 用 x64 版），生成 `output.noindex/Grok Bot.app`。移入「应用程序」，填写 Host 地址和 6 位配对码。连接页的 Tailcat 开关只在粘贴 Host 管理页「远程访问」里的连接链接时打开，填局域网或 HTTPS 地址时保持关闭。给另一种芯片的 Mac 生成时，加 `--arch arm64` 或 `--arch x64`。

**Apple 芯片与 Intel Mac**：官方为 Apple 芯片和 Intel 分别提供了 1.3.0 安装包。两者的预加载模块和业务逻辑一致，仅构建哈希和本机模块不同。`patchers/desktop/recipes/` 与 `patchers/desktop/x64/recipes/` 均由 `windows/tools/desktop-recipes/build.mjs`（`--target mac-arm64` / `--target mac-x64`）按同一套锚点规则生成，注入的本项目代码完全相同；Tailcat 分别提供 arm64（`dist/network/`）与 x86_64（`dist/network/x64/`）版本。1.3.0 尚未在 Mac 真机上测试。如果它在你的 Mac 上用不了，可以从 Releases 下载 **v1.15.0** 的 Mac 发布包生成上一版 `1.2.3`（Intel Mac 上实测可用），或下载 **v1.7.0** 的 Mac 发布包生成 `0.71.2` 回退版。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。DMG 按文件大小识别是哪种芯片的版本；`.app` 不是本机芯片的版本时，再加 `--arch`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。可接受的原包和官方最新版本见[首页版本表](../README.md#client-versions)。

主程序和各个辅助程序使用自己的构建 UUID，不再和官方客户端共用「本地网络」权限。替换旧版本生成的 App 后，第一次连接局域网里的 Host 时，macOS 可能会再次询问是否允许访问本地网络，选择允许即可。

## 签名与本机控制

默认命令用 ad-hoc 签名，没有 Team ID。对话、配对和远程访问都能用，但 Bot 不能操作这台 Mac 的图形界面（Computer Use），因为原版的本机控制组件 `CUGrokBotService` 只接受带 Team ID 的签名。

已有签名证书时，推荐这样生成：

```sh
node patchers/desktop/patch.mjs --identity auto
```

在终端运行 `security find-identity -v -p codesigning`，列表里有 Apple Development 或 Developer ID Application 证书就可以用。`--identity auto` 优先用 Developer ID Application，其次用 Apple Development，并自动更新 `CUGrokBotService` 的可信 Team ID；找不到可用证书时会报错停止，不会生成 App。要指定某个证书，把 `auto` 换成证书名称或 SHA-1。

还没有证书时，可以先创建一个，免费 Apple 账户就够：

1. 安装 Xcode，打开 Xcode → 设置（Settings）→ 账户（Accounts），点左下角「+」，登录你的 Apple 账户；
2. 选中账户下的团队，点「管理证书…」（Manage Certificates…），再点「+」，选「Apple Development」；
3. 用上面的命令确认证书已经列出，再加 `--identity auto` 重新生成。

也可以不建证书，直接用默认命令，只是不能使用本机控制，其他功能不受影响。第一次使用本机控制时，按 macOS 的提示授予「辅助功能」和「屏幕录制」权限。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
