## 改了什么 / What changed

## 怎么验证的 / How it was tested

- [ ] `node --test "host/tests/*.test.mjs"`
- [ ] `node --test "windows/tests/*.test.mjs"`
- [ ] `node --test mac/tests/*.test.mjs`
- [ ] `node --test "android/tests/*.test.mjs"`
- [ ] 改了 `android/shell/` 的话，已执行 `node android/shell/release-shell.mjs` / Rebuilt the prebuilt shell after changing `android/shell/`
- [ ] 真实环境验证（写明验证了什么）/ Tested on a real deployment (describe)

## 确认 / Checklist

- [ ] 没有提交任何 Grok Bot 官方程序文件、解包代码、IPA 或生成的 APK / No Grok Bot program files, extracted code, IPAs or built APKs
- [ ] 没有包含密码、Key、私人地址 / No passwords, keys or private addresses
- [ ] 中英文文档都已更新（如涉及）/ Both Chinese and English docs updated (if relevant)
- [ ] 我同意按 ProkBot 非商业许可证 1.0 发布这些改动 / I agree to release this under the ProkBot Noncommercial License 1.0
