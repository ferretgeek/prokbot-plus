# AGENTS.md：给接手本仓库的 AI

ProkBot Plus 是 ProkBot（https://gitee.com/ahaduoduoduo/ProkBot ，基于提交 `3e9fe8c`）的修改版，公开在 https://github.com/ferretgeek/prokbot-plus 。

它做的事：
- 把 Grok Bot 的服务端（Host + Linux 执行桌面）用 Docker 跑在用户自己的 x86_64 Linux 上；
- 给官方 Windows / macOS / iOS 客户端打补丁，让它们连这个服务端。

相对上游新增了 Windows x64 客户端、Anthropic Messages 和 OpenAI Responses 两种模型接口，以及一批修复。

用户面向的文档：
- `README.md`；
- `docs/AI-INSTALL.md`（部署手册）；
- `docs/ARCHITECTURE.md`（技术文档）；
- `host/`、`mac/`、`windows/`、`ios/` 各自的 `README.md`，随对应的发布包分发。Host 的离线构建、备份、分开部署和应用开发都写在 `host/README.md`，iOS 签名写在 `ios/README.md`。

改代码前先读技术文档。`host/server/application-guide.md` 是运行时文件，Bot 编写应用时会读取它，不要当成普通文档删改。

## 目录

| 路径 | 内容 |
| --- | --- |
| `host/` | 服务端：`release/` 构建与部署，`server/` 管理服务和管理网页，`runtime/` 注入原版 Host 的运行时（模型适配、联网与图片、自动审查、可靠性层），`tools/host-admin.mjs` 命令行管理，`network/` Tailcat 源码，`tests/` |
| `mac/` | `clients/desktop/` 是桌面客户端主进程，**Mac 和 Windows 共用**；`patchers/desktop/` 是 Mac 补丁和原版下载器（含 vendored `node_modules`） |
| `windows/` | Windows 补丁、由 Mac recipe 移植的 recipe、安装器源码（Go）、预编译的 Tailcat 和安装器 stub、`tests/` |
| `ios/` | iOS 注入库源码、字节码补丁数据、IPA 补丁工具 |
| `docs/` | 部署手册、技术文档、README 截图 |
| `NOTICE`、`CHANGELOG.md` | 上游来源与修改清单、版本记录 |

## 常用命令

```sh
node --test "host/tests/*.test.mjs"        # 服务端 35 项
node --test "windows/tests/*.test.mjs"     # Windows 客户端 8 项
node --test mac/tests/*.test.mjs           # Mac / 共用客户端 15 项
node windows/patchers/desktop/patch.mjs    # 在 Windows 上生成客户端，输出 windows/output/（已忽略）
python3 host/release/build-docker.py       # 在 Linux 上构建服务端镜像 grokbot-host:local
```

**提交前三套测试必须全部通过。**改了 Host 运行时代码，要重建镜像后才会生效。

## 必须遵守

- **许可证**：沿用上游 ProkBot 非商业许可证 1.0，**不能改成允许商用的许可证**。新增代码同样适用。修改要记入 `NOTICE` 和 `CHANGELOG.md`。
- **不提交、不分发官方程序**：不要把 Grok Bot 官方程序、解包出来的代码或任何 IPA 提交进仓库或放进 Releases。补丁只能「从用户自己下载的原版文件里复制字节，再加上本项目的修改」。
- **隐私**：
  - 不提交密码、API Key、配对码、私有 IP 或域名、本机路径、个人邮箱；
  - 截图只能来自干净的演示环境；
  - 发布前用 `git grep` 扫一遍暂存内容。
- **双语文档**：README 和 `docs/` 下的文档都有中英两份，改一份就要同步另一份，并保证锚点链接有效。
- **部署手册的命令要实测**：`docs/AI-INSTALL.md` 里的服务器命令通过 `ssh … 'bash -s' <<'EOF'` 发送。会读取标准输入的命令（`docker compose exec`、`apt-get`、备份脚本）必须加 `< /dev/null`，否则会吞掉脚本后面的内容。改了手册里的命令，要在真实服务器上跑一遍。
- **固定版本**：补丁只对 `supported.json` 和各 `manifest.json` 里的版本生效。支持新版本要重新制作 recipe，不要放宽哈希校验。

## 在 Windows 上提交

- Windows 上 `core.fileMode` 为 false，Git 不会记录可执行权限。新增或改动下面 5 个文件后，要执行 `git update-index --chmod=+x <文件>`：
  - `host/bin/grokbot-tailcat`
  - `mac/dist/network/grokbot-tailcat`
  - `ios/bin/GrokBotLocal.dylib`
  - `mac/patchers/desktop/node_modules/.bin/asar`
  - `mac/patchers/desktop/node_modules/@electron/asar/bin/asar.mjs`

  用 `git ls-files -s | grep ^100755` 检查。
- 换行一律 LF（`.gitattributes` 已设置）。
- 推送前先执行一次 `gh auth setup-git`，否则 `git push` 可能卡在 Git 凭据管理器的登录窗口。

## 发布新版本

1. 更新 `CHANGELOG.md`（中英文），必要时更新 `NOTICE`，三套测试全部通过，提交并推送。
2. 用 `git archive` 从已推送的提交打 4 个包。每个包都带 `LICENSE NOTICE README.md README.en.md CHANGELOG.md CONTRIBUTING.md SECURITY.md docs`：
   - `host`；
   - `windows mac`（Windows 补丁依赖 `mac/`）；
   - `mac`；
   - `ios`。

   `git archive` 会保留可执行权限。
3. 生成 `SHA256SUMS.txt`。把每个包解压到独立目录跑测试；Windows 包用官方安装包执行一次 `patch.mjs --source <安装包> --verify-only`。
4. `gh release create v<版本> --target main --title "ProkBot Plus <版本>" --notes-file <中英双语说明> <4 个 zip> SHA256SUMS.txt`。

   **不要附带打好补丁的客户端。**
