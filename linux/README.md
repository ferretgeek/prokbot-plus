# ProkBot Plus Linux 客户端补丁

[English](README.en.md)

为 Grok Bot 1.3.0 Linux 桌面客户端（支持 `x64` 和 `arm64`）连接自己的 Host，生成便携目录、`.tar.gz` 压缩包和用户级安装脚本（无需 root 权限，跨发行版可用）。需要 Node.js 22.12+ 与支持 xz 的 `tar`（`xz-utils`）。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#linux-client)。

## 生成客户端

在仓库（或 Linux 发布包解压）根目录执行：

```sh
node linux/patchers/desktop/patch.mjs
```

- 省略 `--source` 时自动下载并校验官方 1.3.0 `.deb` 原包；省略 `--arch` 时按原包大小或本机 CPU 架构自动选择 `x64` / `arm64`（也可手动加 `--arch x64` 或 `--arch arm64`）。
- 已有原版 `.deb` 或解包后的应用目录时，加 `--source /path/to/grok-bot_1.3.0_amd64.deb`。
- 默认输出到 `linux/output/`：
  - `grokbot-local/`：便携目录，直接运行 `./grokbot-local` 启动；
  - `GrokBotLocal-1.3.0-<arch>-linux.tar.gz`：便于拷到目标 Linux 电脑的便携压缩包（不需要时加 `--no-archive`）；
  - `GrokBotLocal-1.3.0-<arch>.patch.json`：构建校验清单。
- `--verify-only` 只在临时目录校验原包并回放补丁，不写出客户端，在 Windows 上也能运行。可接受的原包和官方最新版本见[首页版本表](../README.md#client-versions)。

## 安装与运行

可以直接在便携目录运行 `./grokbot-local`，也可以为当前用户安装桌面入口、图标、`grokbot-local://` 协议关联和命令行命令（无需 root）：

```sh
sh grokbot-local/install.sh
```

默认安装到 `~/.local/share/grokbot-local`，并在 `~/.local/bin/grokbot-local` 创建启动软链（可用 `--dir`、`--bin-dir` 自定义路径）。卸载运行 `sh ~/.local/share/grokbot-local/uninstall.sh`（不会删除 `~/.config/Grok Bot Local` 中的配置与凭据）。安装脚本只会覆盖空目录或之前装的 Grok Bot Local，卸载脚本也只删除 Grok Bot Local 的安装目录，`--dir` 指向其他目录时会拒绝执行。

首次启动填写 Host 地址和 6 位配对码。连接页的 Tailcat 开关只在粘贴 Host 管理页「远程访问」里的连接链接时打开，填局域网或 HTTPS 地址时保持关闭。

## 系统依赖与说明

- **运行库**：与官方 Electron 客户端一致，需要常见的桌面库（如 `libgtk-3-0`、`libnss3`、`libnotify4`、`libsecret-1-0`、`libasound2` 等；使用系统托盘建议安装 `libappindicator3-1` / GNOME AppIndicator 扩展）。
- **Ubuntu 24.04+ AppArmor 沙箱**：内核开启 `kernel.apparmor_restrict_unprivileged_userns=1` 时，用户级便携目录默认无法启用无特权 user namespace。推荐运行一次随包提供的脚本加载 AppArmor 配置以保留完整沙箱：
  ```sh
  sudo ~/.local/share/grokbot-local/setup-apparmor.sh
  ```
  如需临时跳过沙箱启动，可运行 `GROKBOT_NO_SANDBOX=1 grokbot-local`。
- **凭据存储**：优先使用系统密钥环（GNOME Keyring / KWallet）；无密钥环守护进程时沿用官方 Linux 客户端行为回退到 Electron `basic_text`（凭据文件仍以 `0600` 权限保存在 `0700` 目录）。
- **本机能力与限制**：支持 Tailcat 内置组网、Bot 在本机执行命令与文件操作（需审批）、委派本机 Codex CLI 与桌面通知；和 Windows 一样不支持本机鼠标键盘图形界面控制。与官方客户端配置目录和协议完全隔离，可共存。本机命令和 Codex 需要 1.10.0 及以后的 Host。
- **实测情况**：1.3.0 x64 在 Ubuntu 24.04 的容器里（虚拟显示）实测了生成、配对、对话、附件、Host 和客户端重启后恢复、设置页、资料库、连接应用和需审批的本机命令；上一版 1.2.3 在 WSL2 的 Ubuntu 22.04 x64（WSLg）上实测过安装卸载脚本。原生 GNOME / KDE 桌面、Wayland、Tailcat、托盘、语音、ARM64 和 Ubuntu 24.04 的 AppArmor 脚本还没有实测，遇到问题请提 Issue。首次启动时会从 Google 下载英文拼写字典（约 450 KB），这是唯一不经 Host 的连接。仍需 1.2.3 时，用 Releases 中 **v1.15.0** 的 Linux 发布包生成。

## 维护与测试

- `patchers/desktop/recipes/` 与 `patchers/desktop/arm64/recipes/` 由 `windows/tools/desktop-recipes/build.mjs`（`--target linux-x64` / `--target linux-arm64`）按同一套锚点规则生成，测试命令为 `node --test "linux/tests/*.test.mjs"`。
- Linux Tailcat 二进制与服务端共用 `host/bin/grokbot-tailcat`（x64）和 `host/bin/linux-arm64/grokbot-tailcat`（ARM64）。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
