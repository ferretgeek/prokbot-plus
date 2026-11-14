# ProkBot Plus Windows Patch

为 Grok Bot 0.71.2 Windows x64 客户端连接自己的 Host。需要 Windows 10/11 x64、Node.js 22.12+，以及完整的仓库（共用 `mac/` 中的客户端代码和补丁工具）。

完整的部署步骤见 [AI 部署手册](../docs/AI-INSTALL.md#91-windows-1011-x64)，实现原理见[技术文档](../docs/ARCHITECTURE.md#windows-客户端本版本新增)。

[English](README.en.md)

## 使用

在仓库根目录执行：

```powershell
node windows/patchers/desktop/patch.mjs
```

工具自动下载并校验官方 `Grok_Bot_0.71.2_Setup.exe`，在 `windows/output/` 生成：

| 输出 | 用途 |
| --- | --- |
| `Grok Bot Local/` | 便携目录，直接运行其中的 `Grok Bot.exe` |
| `GrokBotLocal-0.71.2-x64-portable.zip` | 便携压缩包，解压后运行 |
| `GrokBotLocal-0.71.2-x64-Setup.exe` | 按用户安装到 `%LOCALAPPDATA%\Programs\Grok Bot Local`，无需管理员权限 |

打开客户端，填写 Host 地址和六位配对码。已有原版安装包、`app-64.7z` 或已安装的原版目录时，用 `--source` 指定；`--no-installer` 只生成便携版本。

安装包支持 `/S`（静默）和 `/D=目录`（放在最后）。常规安装可在「设置 → 应用」中卸载，也可运行安装目录中的 `Uninstall Grok Bot Local.exe`。新卸载器会保留配对、设置及个人文件。

自定义目录请使用绝对路径，选择新目录、空目录或带文件归属记录的 ProkBot Plus 安装目录。卸载器不会卸载官方客户端、便携版或没有归属记录的旧安装。

### 从旧安装升级

先从托盘菜单退出旧客户端。新安装包识别到没有归属记录的旧版时，可以在提示中选择并行安装，也可以在**新安装包**所在目录用 PowerShell 执行以下命令。若旧版装在自定义目录，把 `$old` 换成旧目录的绝对路径：

```powershell
$old = Join-Path $env:LOCALAPPDATA 'Programs\Grok Bot Local'
.\GrokBotLocal-0.71.2-x64-Setup.exe --migrate-legacy "/D=$old"
```

新版装在同级的 `<旧目录名> (side-by-side)` 目录。安装包不复制或删除旧文件，也不替换旧版卸载项。请直接打开新目录中的 `Grok Bot.exe`。两版共用 `%APPDATA%\Grok Bot Local` 中的配对和设置，不要同时运行。要切回旧版，退出新版再打开旧目录中的程序。要**只卸载新版**，请运行**并行安装目录**里的卸载器，不要使用旧卸载器或「设置 → 应用」中的旧版卸载项。后续升级可重复执行同一命令；静默安装时在 `/D=` 前加 `/S`。

## 说明

- 解压原版程序包使用 Windows 11 自带的 `tar.exe`；Windows 10 请安装 7-Zip（或设置 `GROKBOT_7Z` 指向 `7z.exe`）。
- 补丁更新了 `Grok Bot.exe` 内嵌的 ASAR 完整性值，并移除了因此失效的官方签名。首次运行若出现 SmartScreen 提示，选择「仍要运行」；开启了「智能应用控制」的电脑会阻止未签名程序。
- 支持对话、通知（托盘常驻、开始菜单快捷方式）、附件、Tailcat、本机命令执行与 Codex 委派。原版的图形界面电脑操作组件仅有 macOS 版本，Windows 客户端暂不提供本机鼠标键盘控制。
- 本机命令沿用原版执行程序，正常启动时使用 Windows PowerShell，并打开原版的 UTF-8 输出选项，中文输出不会乱码。请从开始菜单或桌面快捷方式启动客户端。在 Git Bash 里启动时，原版会改用 Git Bash，`cmd /c` 这类参数会被改写。
- Codex 委派使用本机 `codex.exe`（含 npm 安装的 Codex），使用本机的 Codex 登录和模型。

## 维护

- `patchers/desktop/original.mjs`：从官方安装包中切出 `app-64.7z` 并解压，Android 补丁也用它。
- `tools/port-desktop-recipes.mjs`：由 Mac recipe 和两个平台的原版生成 Windows recipe，并校验每段复制内容的结构一致。
- `installer/`：安装器源码（仅 Go 标准库），`go build -trimpath -ldflags="-H=windowsgui -s -w" -o ../dist/installer/grokbot-setup-stub.exe .`
- `dist/network/grokbot-tailcat.exe`：`python host/network/build-tailcat.py --target windows-amd64 --output windows/dist/network`
- 测试：`node --test "windows/tests/*.test.mjs"`

## 许可与支持

仅限非商业使用，见 [LICENSE](../LICENSE)。本项目多数代码由 AI 辅助生成。
