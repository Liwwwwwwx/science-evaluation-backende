# Science 测评后端

独立进程，提供内部 AI 题目生成预览与可选的独立登录接口；运行核心已迁入但没有对外开放。尚未接入真实服务适配器、前端切换和自动化任务，不能代替现有后端。

## 架构与当前状态

```text
评测前端 / 自动化任务
        ↓ 由现有管理端验证用户身份与权限
测评后端（独立进程）
  ├─ 题库：题目、版本、生成与审核入库
  ├─ 运行核心：人工 / 自动任务共用，SSE 输出
  ├─ 评分：记录独立的执行与评分状态
  ├─ 服务适配：各被测服务各自的请求和评分接口
  └─ 运行记录与题库仓储：通过显式数据库连接访问
```

这是目标边界。题目生成预览接口仅供受信任的服务端调用；登录功能通过显式配置连接共享账号与权限数据库，并使用测评平台自己的会话。运行核心、评分状态和运行记录仓储是可测试的内部代码，尚无真实适配器和运行接口。题库 CRUD、SSE 接口、管理端代理及自动化接入尚待迁移。现有管理后台仍处理当前用户流量与定时任务。

需要 Node.js 22。通过部署环境提供至少 32 字节的 `EVALUATION_SERVICE_TOKEN`，以及模型的 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`）。默认监听 `127.0.0.1:7714`，可使用 `EVALUATION_HOST` 和 `PORT` 配置。不要把令牌或模型密钥提交到仓库。

启动：`npm start`；隔离测试：`npm test`。本进程不会自动启动夜间任务、通知或运行数据库迁移。

`GET /health` 返回存活状态。`POST /api/admin/team-services/evaluations/question-bank/generate` 需服务端 Bearer 令牌，接收 `{ "serviceKey": "alloy", "topic": "合金性能", "count": 2 }`，返回 `{ "items": [{ "serviceKey": "alloy", "question": "..." }], "model": "..." }`，错误格式为 `{ "error": { "code": "...", "message": "..." } }`。该接口只返回候选，不写数据库。浏览器不得直接使用该令牌：管理端代理必须先验证用户身份及 `team-services:write` 权限。当前代理尚未切换。

运行记录仓储已迁入，必须由调用方显式注入 PostgreSQL 连接池，并检查数据库名为 `science_admin`；运行核心可以接收该仓储。服务入口目前尚未创建连接池或启用运行接口，仓储仅用模拟数据库测试。现有表依赖旧后端迁移 041、042，不能自动执行迁移或擅自迁移生产数据。

## 独立登录

配置 `EVALUATION_DATABASE_URL` 后启用，必须同时设置 `EVALUATION_PUBLIC_ORIGIN` 为浏览器实际访问的 HTTPS origin（非生产环境允许 localhost HTTP）。连接会先验证数据库名是 `science_admin`。首次使用前需审核并手工执行 `migrations/001_evaluation_sessions.sql`；进程不会自动建表或迁移。生产数据库、连接配置和部署均须另行确认。

认证读取 `auth_users` 和管理端权限表；需要 `team-services:read` 或 `team-services:write`。支持现有 scrypt、Argon2 哈希、TOTP 与一次性备用码；备用码消费会更新共享用户表。账号创建、修改密码和权限分配仍由 Science Admin 管理。每次读取会话都校验密码哈希、token_version 和当前权限；旧数据库实现中的 `auth_users` 没有禁用状态字段，因此不能仅靠此表识别产品用户禁用状态，接入前需要核对账号禁用数据源。

- `POST /api/auth/login`：JSON `{username,password,rememberMe,totpCode}`；成功设置 HttpOnly、SameSite=Lax Cookie。未勾选记住时为浏览器会话 Cookie，服务端最长 12 小时；勾选后最长 30 天。需要二次验证时返回 `2FA_REQUIRED`。
- `GET /api/auth/me`：返回当前用户和权限；会话无效 401，权限不足 403。
- `POST /api/auth/logout`：退出当前会话；`POST /api/auth/logout-all`：退出测评平台所有会话。写请求必须携带与配置一致的 Origin。

Cookie 在生产或 HTTPS 下启用 Secure；必须经 HTTPS 同源反向代理访问，禁止将内部数据库及服务令牌暴露到浏览器。限流目前为单进程内存计数，分别按连接 IP 和账号限制，重启会清空，代理后的 IP 可能都是代理地址；多实例或反向代理部署前应在可信网关配置统一限流。过期会话不会自动清理，需后续设计安全的清理任务。前端登录已切换到新会话；旧业务代理不能使用新会话，需逐步迁移。

后续迁移顺序：接入真实数据库和服务适配、题库版本、用户权限与网关、前端与自动任务调用、影子验证和逐步切流；保留回滚通道。
