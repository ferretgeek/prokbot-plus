# ProkBot Plus Host Patch

自建 Grok Bot 服务端。需要 Python 3.10+、Docker Compose，运行架构为 Linux amd64；已在 Ubuntu 24.04 + Docker 29（发行版自带的 `docker.io`、`docker-compose-v2`）实测。Apple Silicon 也可以构建 amd64 镜像。

完整的部署步骤见 [AI 部署手册](../docs/AI-INSTALL.md)，实现原理见[技术文档](../docs/ARCHITECTURE.md)。

[English](README.en.md)

## 使用

```sh
python3 release/build-docker.py
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

打开 `http://127.0.0.1:18080`，用初始化码设置管理员账号，配置模型（OpenAI Chat、OpenAI Responses 或 Anthropic Messages 接口）并生成六位配对码。

- 局域网访问：先设置 `export GROKBOT_LISTEN_ADDRESS=0.0.0.0`，再运行 Compose；端口由 `GROKBOT_PUBLIC_PORT` 设置。
- 公网访问：用 HTTPS 反向代理，或在管理页启用 Tailcat。

## 离线构建

构建工具默认从固定来源下载原版文件，并严格校验，版本见 `recipes/host/manifest.json` 和 `release/build-docker.py`。已有原版文件时：

```sh
python3 release/build-docker.py --host-archive /path/to/sand-host-bundle-d0a4baa.tgz --box-archive /path/to/box.tar.gz
```

Box 归档校验通过后会被标记为 `grokbot-box-input:9d2ac1b`，Compose 直接使用这个本地镜像。Docker 29 新安装默认用 containerd 镜像存储，此时镜像 ID 是固定的清单摘要，构建工具同样接受；离线归档按其中的配置摘要校验，与存储方式无关。

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可以单独生成 Host 文件并记录补丁耗时。生成过程只做固定的字节复制和新增规则，不调用 AI，也不反编译。

## 数据与备份

数据保存在 `host-data`、`box-home`、`box-workspace` 三个卷里。备份时会暂停正在运行的容器，保存所有卷和校验值后恢复运行。恢复到一个新的 Compose 项目，不覆盖现有的卷：

```sh
python3 release/backup.py backup --project grokbot --directory backups/2026-10-21 --image grokbot-host:local
python3 release/backup.py restore --project grokbot-restored --directory backups/2026-10-21 --image grokbot-host:local
docker compose -p grokbot-restored -f release/compose.yaml up -d
```

恢复时用和备份对应的镜像版本。恢复出来的实例和原实例是同一个身份，启动前先停掉原实例。

## 分开部署执行电脑

只部署 Host 时用 `release/compose.host.yaml`。在另一台电脑上部署执行节点：

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
