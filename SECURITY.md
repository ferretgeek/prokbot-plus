# 安全 / Security

## 报告漏洞

请不要在公开的 issue 里报告安全问题。用 GitHub 仓库的 **Security → Report a vulnerability**（私密漏洞报告）提交，写清楚影响范围和复现方法。我们会尽快回复。

Please do not report security issues in public issues. Use **Security → Report a vulnerability** on the GitHub repository (private vulnerability reporting) and include the impact and steps to reproduce.

## 部署时的安全建议

- **管理页不要直接暴露到公网。** 只在局域网用的话，把 `GROKBOT_LISTEN_ADDRESS` 设为服务器的局域网 IP 或 `127.0.0.1`。需要外网访问时，用内置的 Tailcat，或者放在 HTTPS 反向代理后面。
- **Docker 发布的端口会绕过 ufw 等主机防火墙。** 不要依赖 ufw 挡住 18080 端口。
- **管理员密码用随机生成的长密码**（12–128 位）。不要和其他服务共用。
- **API Key 只保存在 Host 的数据卷里**（`/data/model.env`）。不要写进 `.env` 以外的公开文件，也不要提交到任何仓库。
- **不再使用的设备**在管理页「设备与通知」里撤销。
- **Android 签名密钥**（默认 `~/.grokbot-local/android-signing.json`）只给自己用，不要分享。拿到它的人能做出可以覆盖安装你的 App 的 APK。
- **本机命令权限**默认是「询问」。只有在你完全信任当前模型和 Bot 时，才改成「始终允许」。
- **定期备份**（见 [AI 部署手册附录 A](docs/AI-INSTALL.md#附录-a日常运维)）。备份文件包含对话记录和 Key，要妥善保管。

## Deployment advice

- Do not expose the admin page directly to the internet. Use LAN-only binding, the built-in Tailcat network, or an HTTPS reverse proxy.
- Ports published by Docker bypass host firewalls such as ufw.
- Use a long random admin password, and revoke devices you no longer use.
- Keep the Android signing key (`~/.grokbot-local/android-signing.json` by default) to yourself. Anyone who has it can build an APK that installs over your app.
- Keep the local command permission on "Ask" unless you fully trust the model and the Bot.
- Back up regularly. Backups contain conversations and API keys, so store them safely.
