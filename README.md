# abot-health

健康数据服务：病人（任意人，不限于亲属）、就诊记录、处方、用药、检查报告、报告附件、疫苗、医疗保险。

- Worker: `abot-health`
- 域名: `health.abot.run`
- MCP: `POST /mcp`（34 个工具）
- 医疗保险：`list_insurance` / `add_insurance` / `update_insurance` / `delete_insurance`，按 `patient_id` 隔离。查看页医保标签在到期前 30 天黄色提醒
- 数据：D1 存记录和附件元数据（文件名、MIME、大小、R2 key）；R2 binding `FILES` 存文件
- 附件：`upload_lab_report_file` / `get_lab_report_file` / `list_lab_report_files`。仅 jpg、png、webp、pdf，单文件 10MB，按 `patient_id` 隔离
- 病人：`relationship`、`notes` 可选，只用于区分身份。病历和附件仍按 `patient_id` 查询

测试：`npm test`；部署前的完整校验（测试 + 两个 Worker 的 wrangler dry-run）：`npm run build`

## 部署

唯一的部署流程是 Cloudflare 控制台的 Workers Builds，调用 `scripts/cf-build.mjs`。不要在本地或其他 CI 里 `wrangler deploy`：

- `scripts/cf-build.mjs --deploy` 只在 `WORKERS_CI=1` 且分支为 `main` 时放行
- 生产配置 `deploy/<worker>/wrangler.jsonc` 的入口是脚本测试通过后才生成的 `.build/`，绕过脚本直接部署会找不到入口
- 根目录 `wrangler.jsonc` 只用于本地和 e2e，`name` 为 `abot-health-local`，不会覆盖线上

两个 Worker 在控制台 **Workers & Pages → Worker → Settings → Builds** 里各自连接本仓库：

| 设置 | abot-health | abot-health-viewer |
|---|---|---|
| 生产分支 | `main` | `main` |
| 根目录 | `deploy/abot-health` | `deploy/abot-health-viewer` |
| 构建命令 | 留空 | 留空 |
| 部署命令 | `npm run deploy` | `npm run deploy` |
| 非生产分支构建 | 关闭（或预览命令 `npm run preview`，只校验不上传） | 同左 |
| 构建监视路径 | `src/*`、`test/*`、`scripts/*`、`deploy/abot-health/*`、`package*.json`、`wrangler.jsonc` | `pages/*`、`test/*`、`scripts/*`、`deploy/abot-health-viewer/*`、`package*.json`、`wrangler.jsonc` |
| 构建变量 | `NODE_VERSION=22` | `NODE_VERSION=22` |
| Git 仓库 | Cursor Origin `dagow/abot-health` | 同左 |

生产配置要点：两个 Worker 都关闭 `workers_dev` 和预览 URL。`abot-health` 只经网关 Service Bindings 访问。`abot-health-viewer` 只走 `health-view.abot.run/*`（Cloudflare Access 保护），Worker 内还会用 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 校验 Access JWT，未配置时拒绝所有请求。`OWNER_EMAIL` 请在控制台设为 Secret（部署不会覆盖 Secret）。
