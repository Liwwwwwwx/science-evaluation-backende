# 发布与运维

两个仓库独立：`dev` 开发，PR 合入 `main`；PR/分支提交触发 CI，只有 `main` 的 CI 成功才部署。Actions 固定提交 SHA；PR 不获取部署密钥。分支保护要求 `CI` 成功、通过 PR 合并，不要求单人仓库自审。

部署目标为 36.103.177.195。前端 `http://36.103.177.195:1101`，后端 `127.0.0.1:7714`。独立账号 `science-eval`、目录 `/data/science-evaluation`、systemd 服务 `science-evaluation-{backend,frontend}`；不复用或重启 Science Admin。数据库使用现有 `science_evaluation`，不执行迁移。

首次部署：管理员检查 `bootstrap.sh` 后执行。将私有配置分别放入 `shared/backend.env`、`shared/frontend.env`，属主 science-eval、权限 600。后端设置生产环境、数据库本机 5432、现有服务/模型/测试机器人配置；需要夜间自动化时在 `shared/backend.env` 设置 `EVALUATION_AUTOMATION_ENABLED=true`（本地 `.env.local` 设为 `false`）；前后端显式 `EVALUATION_ALLOW_HTTP=true`。前端 `PORT=1101`、`HOSTNAME=0.0.0.0`、`SCIENCE_EVALUATION_BACKEND_URL=http://127.0.0.1:7714`。后端 `PORT=7714`、`EVALUATION_HOST=127.0.0.1`、`EVALUATION_PUBLIC_ORIGIN=http://36.103.177.195:1101`。更换为 HTTPS 时更新 origin 并关闭 HTTP 开关。

每日测评日报同时发送正式与测试机器人时，在 `shared/backend.env` 配置 Science Admin 已有的 `FEISHU_WEBHOOK_URL` 和 `MATERIAL_EVAL_DIGEST_BRIEF_WEBHOOK_URL`，并启用 `EVALUATION_DAILY_REPORT_NOTIFY_ENABLED=true`。配置只在服务器安全传递，不输出地址、不放入仓库。更改生产配置和重启前先获用户确认并核对无活动测评；仅更新独立测评后端，不恢复 Science Admin 的自动测评，不清除旧日报通知状态或补发历史消息。无需数据库迁移。

免登录日报分享需先部署包含 `/shared/daily-reports/:date` 的前端，再在后端配置独立随机密钥 `EVALUATION_REPORT_SHARE_SECRET`（至少32字节）并发布后端，避免飞书先发出前端不支持的链接。分享链接有效30天，仅开放单份日报正文；密钥不输出、不进Git，移除或更换后旧链接失效。回退到旧前端前应先关闭分享配置并重启独立后端。无需数据库迁移，不清除既有通知状态；生产配置和部署须先获用户确认。

两个仓库的 `production` 环境配置 secrets `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`，variables `DEPLOY_HOST`、`DEPLOY_USER`。部署 SSH 密钥使用独立非 root 用户；sudo 仅允许重启/停止这两个新服务。SSH 严格验证预存主机密钥。应用凭据只在服务器，不放入 GitHub 构建配置或产物。

部署脚本由管理员安装到 `/usr/local/bin/science-evaluation-deploy`。CI 经 SSH 将构建包送到脚本 stdin；后端安装生产依赖，前端在 CI 校验 standalone 后传输小型源码包，在服务器用 Node 22、Yarn 1.22.22 和锁定依赖重新构建，以 standalone 运行。发布目录按提交号及随机后缀隔离，软链接切换；健康检查失败恢复上一版。目录保留供人工回滚，不自动清除。后端发现排队/运行/评分或报告生成时拒绝重启，任务结束后在 Actions 重跑。部署共用文件锁，避免前后端同时切换。

查询：`systemctl status science-evaluation-backend science-evaluation-frontend`。回滚时先确认无运行任务，将 `current-组件` 切回 `previous-组件`，仅重启对应新服务。环境配置不随代码回滚，不自动执行数据库 DDL。

切流时先停本机新测评后端，确认同一数据库只有服务器上的新调度器。旧 Science Admin 夜检按用户决定继续保留。
