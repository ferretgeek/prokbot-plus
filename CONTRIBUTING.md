# 参与贡献 / Contributing

欢迎提问题、报 bug 和提交代码。

## 提问题之前

- 先看 [AI 部署手册的故障排查](docs/AI-INSTALL.md#附录-b故障排查)，很多常见问题都写在那里。
- 报 bug 时请写清楚：
  - 服务端系统和 Docker 版本；
  - 客户端平台和版本；
  - 模型接口格式（不用写 Key 和地址）；
  - 复现步骤；
  - Host 日志里相关的几行（`docker compose ... logs --tail 200 host`）。
- **不要贴出 API Key、管理员密码、配对码、服务器公网地址。** 贴日志前检查一遍。
- 安全问题不要公开提 issue，看 [SECURITY.md](SECURITY.md)。

## 提交代码

1. 改动尽量小而集中，一个 PR 解决一件事。
2. 提交前跑测试，全部通过：

   ```sh
   node --test "host/tests/*.test.mjs"
   node --test "windows/tests/*.test.mjs"
   node --test mac/tests/*.test.mjs
   ```

3. 改了 Host 代码的话，最好在真实环境里验证一次（见 [技术说明 · 测试](docs/TECHNICAL.md#测试)），并在 PR 里写明验证了什么。
4. 补丁只能从用户自己下载的官方文件里复制字节，再加上本项目的修改。**不要把任何 Grok Bot 官方程序文件、解包出来的代码或 IPA 提交进仓库。**
5. 文档有中英文两份的，两份都要改。

## 许可

本项目使用 [ProkBot 非商业许可证 1.0](LICENSE)。提交代码即表示你同意你的贡献按同一许可证发布，并且只能用于非商业用途。

---

Issues, bug reports and pull requests are welcome.

- Check the [troubleshooting section](docs/AI-INSTALL.en.md) of the AI install guide first.
- In bug reports, include:
  - server OS and Docker version;
  - client platform and version;
  - model API format;
  - steps to reproduce;
  - the relevant Host log lines.

  **Never post API keys, admin passwords, pairing codes or public server addresses.**
- Report security issues privately, see [SECURITY.md](SECURITY.md).
- Keep pull requests small, and run the three test suites above before submitting.
- Patches may only copy bytes from official files the user downloads, plus this project's changes. Never commit Grok Bot program files, extracted code or IPAs.
- Update both the Chinese and English versions of a document.
- By contributing you agree that your contribution is released under the [ProkBot Noncommercial License 1.0](LICENSE), for noncommercial use only.
