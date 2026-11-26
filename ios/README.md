# ProkBot Plus iOS 补丁

[English](README.en.md)

为 Grok Bot 1.28.0（29649，推荐）、1.27.0（29519，回退）、1.26.0（29388，回退）或 1.16.0（23152，回退）arm64 砸壳 IPA 注入补丁，脚本按 IPA 版本与摘要自动匹配对应清单。主程序和三个扩展都必须是解密过的，需要 Python 3.10+。本仓库不提供任何原版或修改过的 IPA，请自己准备。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#ios-客户端)。

## 使用

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./GrokBot-Patched \
  --bundle-id dev.grokbot.local
```

输出 `GrokBot-Local-resignable.ipa`、`GrokBotLocal.dylib` 和 `extension-signing.json`。按下一节用自己的工具签名并安装，然后填写 Host 地址和六位配对码。

推送用 APNs 或 Bark，在 Host 管理页配置。实时通话在 App 设置中开启。

## 签名

补丁默认保留 Widgets、Share 和 NotificationService 三个扩展。签名工具要为以下四个目标配置描述文件：

| 目标 | Bundle ID |
| --- | --- |
| 主应用 | 传入 `--bundle-id` 的值 |
| Widgets | `<主应用 ID>.widgets` |
| Share | `<主应用 ID>.share` |
| NotificationService | `<主应用 ID>.NotificationService` |

- 四个目标使用同一个 App Group，默认是 `group.<主应用 ID>`，可以用 `--app-group` 指定。
- 共享钥匙串组是 `<AppIdentifierPrefix>.<主应用 ID>.shared`。把它加进四个目标的签名 entitlement，并把各目标 Info.plist 的 `SandKeychainAccessGroups` 设为包含这个组的数组。若主应用或扩展的 Info.plist 含有 `GrokAppProtection` 字典，也需要同步改写其中的 `appGroupIdentifiers` 与 `keychainAccessGroups`（`patch-app.py` 与 `extensions.py` 会自动隔离）。
- 生成的 `extension-signing.json` 列出了上面这些配置（含 `GrokAppProtection` 说明）。
- 保留扩展但签名描述文件缺少对应 App Group 时，`signing.py` 会输出明确警告并跳过该 entitlement（小组件、分享与通知扩展将无法与主应用共享状态）。
- 安装包带 APNs 权限时用 APNs，推送凭证在 Host 里配置；没有 APNs 权限时，在 App 的通知设置里填写 Bark 链接。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
