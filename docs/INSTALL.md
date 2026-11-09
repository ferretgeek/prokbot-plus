# 安装

[English](INSTALL.en.md)

这是给人看的精简版。想让 AI 代劳，或者想看每一步的检查方法和排错，请看 [AI 部署手册](AI-INSTALL.md)。

## 1. 部署服务端

需要一台 x86_64 Linux 服务器（8 GB 内存、30 GB 空闲磁盘起步），装好 Docker、Docker Compose、Python 3.10+。Ubuntu 可以直接装发行版自带的：`sudo apt-get install -y docker.io docker-compose-v2 python3 git`；Debian 和其他发行版用 Docker 官方安装脚本：`curl -fsSL https://get.docker.com | sudo sh`。装好后把自己加入 docker 用户组（`sudo usermod -aG docker "$USER"`），重新登录生效。

```sh
mkdir -p ~/grokbot && cd ~/grokbot
git clone --depth 1 https://github.com/ferretgeek/prokbot-plus.git src
python3 src/host/release/build-docker.py        # 首次约 10–40 分钟，要下载约 8 GB
```

在 `~/grokbot/.env` 里写好访问地址（局域网示例）：

```ini
GROKBOT_LISTEN_ADDRESS=0.0.0.0
GROKBOT_PUBLIC_PORT=18080
GROKBOT_PUBLIC_URL=http://<服务器局域网IP>:18080
TZ=Asia/Shanghai
```

启动，然后读出初始化码：

```sh
DC="docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml"
$DC up -d
$DC exec host cat /data/setup-key
```

用浏览器打开 `GROKBOT_PUBLIC_URL`：

1. 用初始化码设置管理员密码；
2. 在「对话模型」里选接口格式（Anthropic Messages、OpenAI Responses 或 OpenAI Chat），填写地址、Key 和模型，点「测试连接」后保存；
3. 可选：在「联网工具」「图片与视频」里配置搜索和生图；
4. 到「设备与通知」生成 6 位配对码。

不想开网页的话，也可以用命令行工具 `host/tools/host-admin.mjs` 完成，用法见 AI 部署手册第 5、6 步。

## 2. 生成客户端

| 客户端 | 在哪里生成 | 命令（在仓库根目录执行） | 产物 |
| --- | --- | --- | --- |
| Windows 10/11 x64 | Windows 电脑，Node.js 22.12+ | `node windows/patchers/desktop/patch.mjs` | `windows/output/` 下的安装包和便携版，见 [Windows 说明](../windows/README.md) |
| Mac（Apple Silicon） | Mac，Node.js 22.12+ | `node mac/patchers/desktop/patch.mjs` | `mac/output.noindex/Grok Bot.app`，见 [Mac 说明](../mac/README.md) |
| iOS | 任意电脑，Python 3.10+ | `python3 ios/release/patch-ios.py --input <砸壳.ipa> --output <目录>` | 未签名 IPA，自行签名，见 [iOS 说明](../ios/README.md) |

工具会自动下载并校验对应版本的官方客户端（iOS 需要你自己提供 Grok Bot 1.16.0（23152）的砸壳 IPA）。

打开客户端，填写 Host 地址（和 `GROKBOT_PUBLIC_URL` 完全一样）和配对码。每台设备用一个新的配对码。

## 3. 在外面使用

- **Tailcat**：在管理页「远程访问」里开启，客户端的连接设置里也打开 Tailcat。不需要公网 IP 和域名。
- **HTTPS 反向代理**：`GROKBOT_LISTEN_ADDRESS` 设为 `127.0.0.1`，`GROKBOT_PUBLIC_URL` 设为 `https://<域名>`，反向代理转发到 `127.0.0.1:18080`。
- 已经在用 Tailscale 的话，直接用 Tailscale 地址也可以。

更多用法：[分开部署与备份](../host/docs/DEPLOYMENT.md) · [应用开发](../host/PLUGINS.md)
