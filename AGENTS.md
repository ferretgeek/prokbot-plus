# AGENTS.md：给接手本仓库的 AI

ProkBot Plus 是 ProkBot（https://gitee.com/ahaduoduoduo/ProkBot ，基于提交 `3e9fe8c`）的修改版，公开在 https://github.com/ferretgeek/prokbot-plus 。

它做的事：
- 把 Grok Bot 的服务端用 Docker 跑在用户自己的 x86_64 或 ARM64 Linux 上；Host 按架构构建，官方执行桌面固定为 amd64；
- 给官方 Windows / macOS / Linux / iOS 客户端打补丁，让它们连这个服务端；
- Android 客户端不改官方 Android 版（带防篡改保护），而是把官方桌面版界面（取自用户下载的 Windows 安装包）装进本项目的 Android 外壳；
- 网页版用同一套界面和桥接：用户生成界面包、上传到自己的 Host，Host 只把它提供给用配对码登录的浏览器。

相对上游新增了 Windows x64 客户端、Linux 桌面客户端（x64 / ARM64）、Android 客户端、网页版、Anthropic Messages 和 OpenAI Responses 两种模型接口，以及一批修复。

用户面向的文档：
- `README.md`；
- `docs/AI-INSTALL.md`（部署手册）；
- `docs/ARCHITECTURE.md`（技术文档，含测试、依赖官方原包的测试开关和支持新官方版本的步骤）；
- `host/`、`mac/`、`windows/`、`linux/`、`ios/`、`android/`、`web/` 各自的 `README.md`，随对应的发布包分发。Host 的离线构建、备份、分开部署和应用开发都写在 `host/README.md`，iOS 签名写在 `ios/README.md`。

改代码前先读技术文档。`host/server/application-guide.md` 是运行时文件，Bot 编写应用时会读取它，不要当成普通文档删改。

## 目录

| 路径 | 内容 |
| --- | --- |
| `host/` | 服务端：`release/` 构建与部署，`server/` 管理服务和管理网页，`runtime/` 注入原版 Host 的运行时（模型适配、联网与图片、自动审查、可靠性层），`tools/host-admin.mjs` 命令行管理，`network/` Tailcat 源码，`tests/` |
| `mac/` | `clients/desktop/` 是桌面客户端主进程，**Mac、Windows 和 Linux 共用**，Android 也复制其中三个文件；其中的 `*-settings-extension.js` 没有被代码引用，但它们是 0.71.2 recipe 加进原版设置页的代码的源码，不要当成无用文件删除。`patchers/desktop/` 是 Mac 1.3.0 补丁和原版下载器（含 vendored `node_modules`），`x64/` 是 Intel 版的固定输入和 recipe |
| `windows/` | Windows 补丁（推荐官方 1.3.0，可回退 1.2.3、1.1.0、0.71.2）、安装器源码（Go）、预编译的 Tailcat 和安装器 stub、`tests/`。`tools/desktop-recipes/` 按 `spec.mjs` 的锚点修改生成 1.3.0 五平台 recipe（`--target windows\|mac-arm64\|mac-x64\|linux-x64\|linux-arm64`），`extensions/` 是 recipe 追加进原版模块的代码的源码；`patchers/desktop/1.2.3/`（由提交 `41c836b` 的 `spec.mjs` 生成）、`1.1.0/`（由提交 `8c1fcd1` 的 `spec.mjs` 生成）与 `0.71.2/` 是回退版本的输入和 recipe，其中 1.1.0 和 0.71.2 同时供 Android 和网页版使用 |
| `linux/` | Linux 桌面客户端补丁（官方 1.3.0 `x64` / `arm64` `.deb` 原包）：`patchers/desktop/`（含 `arm64/` 输入和 recipe、`deb.mjs`、`launcher.mjs`、`tar.mjs`、`patch.mjs`）、`tests/`，复用 `host/bin/` 的 Linux Tailcat 和 `mac/clients/desktop/` 共用主进程 |
| `ios/` | iOS 注入库源码、字节码补丁数据、IPA 补丁工具 |
| `android/` | `shell/` 是 Android 外壳（Kotlin），`dist/` 是它的预编译 APK；`client/` 是 WebView 里代替 Electron 的桥接；`patchers/` 是生成和签名 APK 的工具；`tests/`。解压官方安装包的代码与 Windows 共用（`windows/patchers/desktop/original.mjs`） |
| `web/` | 网页版：`client/` 是浏览器层（代替 Android 外壳的原生接口，其余桥接与 `android/client/` 共用），`patchers/` 生成界面包并上传到 Host，`tests/`（含 Playwright 浏览器测试和演示用 Host）。Host 端在 `host/server/web-client.mjs`，登录页在 `host/server/public/web-login.*` |
| `docs/` | 部署手册、技术文档、README 截图 |
| `NOTICE`、`CHANGELOG.md` | 上游来源与修改清单、版本记录 |

## 常用命令

```sh
node ci/check-inputs.mjs                   # 离线检查固定版本、补丁清单和预编译外壳摘要
python3 host/deploy.py --help              # 对外部署、备份与升级入口；不是容器内的 host/deploy/
node --test "host/tests/*.test.mjs"        # 服务端
node --test "windows/tests/*.test.mjs"     # Windows 客户端
node --test "mac/tests/*.test.mjs"         # Mac / 共用客户端
node --test "linux/tests/*.test.mjs"       # Linux 客户端
node --test "android/tests/*.test.mjs"     # Android 客户端
node --test "web/tests/*.test.mjs"         # 网页版（Host 的网页版路由测试需要先 npm ci --prefix host/server）
node windows/patchers/desktop/patch.mjs    # 在 Windows 上生成客户端，输出 windows/output/（已忽略）
node linux/patchers/desktop/patch.mjs      # 生成 Linux 便携客户端（x64/arm64），输出 linux/output/（已忽略）
node windows/tools/desktop-recipes/build.mjs --check   # 改了 spec.mjs 或 extensions/ 后去掉 --check 重新生成 recipe
node android/patchers/patch.mjs            # 生成 Android APK，输出 android/output/（已忽略）
node web/patchers/patch.mjs                # 生成网页版界面包，输出 web/output/（已忽略）；--upload <Host 地址> 直接装到 Host
python web/tests/browser-flows.py <界面包>  # 网页版浏览器测试：8 种设备尺寸，需要 Playwright
node android/shell/release-shell.mjs       # 改了 android/shell/ 后重建预编译外壳并更新摘要（需要 JDK 17+ 和 Android SDK）
python3 host/release/build-docker.py       # 在 Linux 上构建服务端镜像 grokbot-host:local
python3 -B -m unittest discover -s ios/tools/hbc98/tests  # iOS HBC 98 解析与补丁生成单测（在仓库根目录运行）
python3 ios/tests/ios-release.test.py && python3 ios/tests/ios-signing.test.py && python3 ios/tests/ios-pairing-credentials.test.py && python3 ios/tests/ios-app-intents-source.test.py && python3 ios/tests/ios-pages-rpc.test.py  # iOS 离线单测
python3 ios/tests/ios-network.test.py && python3 ios/tests/ios-auto-review-preferences.test.py  # iOS 网络与自动审查原生单测（需装有 Xcode 命令行工具的 Mac）
```

**提交前六套测试（host、windows、mac、linux、android、web）必须全部通过。**改了 `android/client/` 或 `web/`，再用 1.1.0 和 0.71.2 两种界面包各跑一次 `web/tests/browser-flows.py`。改了 Host 运行时代码，要重建镜像后才会生效。改了 `android/shell/` 要重建预编译外壳，否则补丁工具会因摘要不符拒绝运行。

## 必须遵守

- **许可证**：沿用上游 ProkBot 非商业许可证 1.0，**不能改成允许商用的许可证**。新增代码同样适用。修改要记入 `NOTICE` 和 `CHANGELOG.md`。
- **不提交、不分发官方程序**：不要把 Grok Bot 官方程序、解包出来的代码、任何 IPA、生成的 Android APK（`android/dist/` 里的外壳除外，它只含本项目代码）或网页版界面包提交进仓库或放进 Releases，也不要部署到公开可访问的地方。补丁只能「从用户自己下载的原版文件里复制字节，再加上本项目的修改」。
- **隐私**：
  - 不提交密码、API Key、配对码、私有 IP 或域名、本机路径、个人邮箱；
  - 截图只能来自干净的演示环境；
  - 发布前用 `git grep` 扫一遍暂存内容。
- **双语文档**：README 和 `docs/` 下的文档都有中英两份，改一份就要同步另一份，并保证锚点链接有效。
- **部署手册的命令要实测**：`docs/AI-INSTALL.md` 里的服务器命令通过 `ssh … 'bash -s' <<'EOF'` 发送。会读取标准输入的命令（`docker compose exec`、`apt-get`、备份脚本）必须加 `< /dev/null`，否则会吞掉脚本后面的内容。改了手册里的命令，要在真实服务器上跑一遍。
- **固定版本**：补丁只对 `supported.json` 和各 `manifest.json` 里的版本生效。支持新版本要重新制作 recipe，不要放宽哈希校验。
- **遵循官方布局**：除官方客户端不存在的新功能外，桌面端与移动端的入口位置、区块上下顺序、`anchorId` 与交互层级必须对齐官方原版代码；官方已有原生槽位或 RPC 的能力直接原位对接，不在侧边栏、菜单或页面末尾自造重复入口，升级客户端版本时同步清理已被新版原生界面取代的旧覆盖层。

## 在 Windows 上提交

- Windows 上 `core.fileMode` 为 false，Git 不会记录可执行权限。新增或改动下面的文件后，要执行 `git update-index --chmod=+x <文件>`：
  - `host/bin/grokbot-tailcat`
  - `host/bin/linux-arm64/grokbot-tailcat`
  - `mac/dist/network/grokbot-tailcat`
  - `mac/dist/network/x64/grokbot-tailcat`
  - `ios/bin/GrokBotLocal.dylib`
  - `mac/patchers/desktop/node_modules/.bin/asar`
  - `mac/patchers/desktop/node_modules/@electron/asar/bin/asar.mjs`
  - `android/shell/gradlew`

  用 `git ls-files -s | grep ^100755` 检查。
- 换行一律 LF（`.gitattributes` 已设置），`*.bat` 例外，用 CRLF。
- 推送前先执行一次 `gh auth setup-git`，否则 `git push` 可能卡在 Git 凭据管理器的登录窗口。

## 发布新版本

1. 更新 `CHANGELOG.md`（中英文），必要时更新 `NOTICE`，六套测试全部通过，提交并推送。
2. 用 `python -B ci/release-packages.py`（内部用 `git archive`）从已推送的提交打 7 个包。每个包都带 `LICENSE NOTICE README.md README.en.md CHANGELOG.md CONTRIBUTING.md SECURITY.md docs`：
   - `host`；
   - `windows mac`（Windows 补丁依赖 `mac/`）；
   - `mac`；
   - `linux mac host/bin/grokbot-tailcat host/bin/linux-arm64/grokbot-tailcat`（Linux 补丁依赖 `mac/` 和 Linux Tailcat）；
   - `ios`；
   - `android windows mac`（Android 补丁依赖 `windows/` 和 `mac/`）；
   - `web android windows mac`（网页版生成工具依赖 `android/`、`windows/` 和 `mac/`）。

   `git archive` 会保留可执行权限。
3. 生成 `SHA256SUMS.txt`。把每个包解压到独立目录跑测试；Windows 包分别用官方 1.3.0、1.2.3、1.1.0 和 0.71.2 安装包各执行一次 `patch.mjs --source <安装包> --verify-only`，Linux 包分别用官方 1.3.0 x64 和 arm64 `.deb` 原包各执行一次 `patch.mjs --source <.deb> --verify-only`，Android 包和网页版包分别用 1.1.0 和 0.71.2 安装包各执行一次 `--verify-only`。
4. `gh release create v<版本> --target main --title "ProkBot Plus <版本>" --notes-file <中英双语说明> <7 个 zip> SHA256SUMS.txt`。

   **不要附带打好补丁的客户端或网页版界面包。**
