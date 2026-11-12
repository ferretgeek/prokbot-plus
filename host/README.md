# ProkBot Plus Host Patch

自建 Grok Bot 服务端。Host 支持 Linux amd64 / arm64 构建；官方执行桌面仅有 amd64。ARM 可用独立 amd64 节点或同机模拟（实验）。需要 Python 3.10+ 和 Docker Compose v2。

完整的部署步骤见 [AI 部署手册](../docs/AI-INSTALL.md)，实现原理见[技术文档](../docs/ARCHITECTURE.md)。

[English](README.en.md)

## 使用

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

以上在 `host/` 目录运行；新装默认回环地址。自定义访问地址在 `init` 时指定，参数见 `python3 deploy.py init --help`。已有实例用 `update`，不要重新 `init`。首次设置、模型和配对见部署手册。

## 离线构建

构建工具默认从固定来源下载原版文件，并严格校验，版本见 `recipes/host/manifest.json` 和 `release/build-docker.py`。已有原版文件时：

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

Box 归档校验通过后会被标记为 `grokbot-box-input:9d2ac1b`，Compose 直接使用这个本地镜像。Docker 29 新安装默认用 containerd 镜像存储，此时镜像 ID 是固定的清单摘要，构建工具同样接受；离线归档按其中的配置摘要校验，与存储方式无关。

先用 `init` 选定实例；已有实例把 `up` 换成 `update`。只想构建镜像不启动时，`release/build-docker.py` 接受相同的归档参数。这些参数只替代原版下载；全离线还要预缓存基础镜像、系统包、npm 依赖，ARM 同机还需要 amd64 的 `busybox:1.37`。ARM 独立 Host 不传 `--box-archive`；amd64 Host 仍用 Box 作基底。

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可以单独生成 Host 文件并记录补丁耗时。生成过程只做固定的字节复制和新增规则，不调用 AI，也不反编译。

## 数据与备份

同机部署有 `host-data`、`box-home`、`box-workspace` 三个卷；分开部署两台机器要各自备份。备份会暂停本项目正在运行的容器，保存卷和校验值后恢复运行。另存 `.env` 和对应代码版本。恢复到新的 Compose 项目，不覆盖现有卷：

```sh
python3 deploy.py backup < /dev/null
python3 release/backup.py restore --project grokbot-restored --directory /path/to/backup --image grokbot-host:local < /dev/null
```

`restore` 只恢复数据，不启动服务。使用与备份匹配的镜像、把 `/path/to/backup` 换成上一步输出的目录；确认原实例已停止，才能启动同一身份的恢复实例。使用原来的 `--env-file` 和 `-p grokbot-restored` 运行 Compose；同机用 `release/compose.yaml`，独立 Host 用 `release/compose.host.yaml`。以后用新项目名管理恢复出的卷，在独立实例目录复制 `.env` 并更新 `PROKBOT_PROJECT`，不要覆盖原配置。

## 分开部署执行电脑

Host 机器使用 `python3 deploy.py --host-only init` 再 `python3 deploy.py up`。在另一台 **amd64 Linux** 机器的 `host/` 目录部署执行节点：

```sh
python3 release/build-docker.py --box-only
# 设置至少 32 位的随机 GROKBOT_NODE_TOKEN；离线镜像可在上一条命令加 --box-archive
docker compose -f release/compose.execution.yaml up -d --build
```

然后在 Host 管理页填写执行节点的地址和密钥。

- 局域网访问：设置 `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`，端口默认 18443。
- 内嵌网络：设置 `GROKBOT_TAILCAT_ENABLED=1`；高级选项是 `GROKBOT_TAILCAT_RELAY` 和 `GROKBOT_TAILCAT_DERP_MAP_URL`。

## 应用开发

管理页的「应用」统一管理远程 MCP 服务、带代码的应用和附带的技能。一个应用就是一个 `grokbot-app` JSON 包；旧版插件 JSON 也能导入。

- 内置的「编写应用」提供开发指南、格式校验和提交工具。Bot 提交后，用户在客户端原有的「连接应用」里添加并授权。
- 导入、导出都是单个 JSON，包含代码、图标、说明和技能；已保存的配置和授权凭证不会导出。
- 代码应用通过现有执行电脑上的 MCP 进程运行，不额外部署容器，和这台电脑上的其他任务共享用户权限、文件和网络。
- OAuth 支持 PKCE、一次性 state 和过期刷新。开发者声明授权地址、Token 地址和 scopes；用户填写 Client ID/Secret，再从客户端打开服务商的授权页。
- 复杂的编码工作会调用已连接电脑上的 Codex，沿用那台电脑上的模型设置和登录。
- 应用版本不可覆盖，升级后可以恢复到上一个版本。

完整的包格式、可运行示例和 OAuth 示例见 [server/application-guide.md](server/application-guide.md)（英文，Bot 写应用时读的就是这份）。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助生成。
