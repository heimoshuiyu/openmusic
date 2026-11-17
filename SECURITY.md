# 安全策略（Security Policy）

## 报告漏洞

请不要通过公开 issue 报告安全问题。仓库托管在 GitHub 后，请使用 GitHub 的
私密漏洞报告功能（Private vulnerability reporting）提交，内容包括：

- 受影响的版本（`/api/v1/system/health` 返回的 `version`）
- 复现步骤与受影响的端点
- 可能的缓解措施

## 部署侧提醒

OpenMusic 是自托管软件，部署者负责自己的凭据与网络暴露面：

- 生产部署务必设置强管理员密码（或首启后立即改密）；
- 实例置于 TLS 反代之后（参见 `docs/07-runbook.md`）；
- 妥善备份 `DATA_DIR/secret.key`（丢失后果见 docs/07）。
