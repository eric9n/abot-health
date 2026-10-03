---
name: health
description: 记录或查询 abot 健康档案时使用：病人（不限于亲属）、就诊、处方与用药、检查报告及附件、疫苗、过敏史、慢性病、手术史、紧急联系人、医疗保险。经网关 abot.run，用 abot-mcp CLI 调用 health 服务。调用前先读 references/tools.md 里的工具名和参数。
---

# health

管理健康档案。工具名和参数以 [references/tools.md](references/tools.md) 为准，该文件从 `src/worker.js` 的 `MCP_TOOLS` 抽出，共 34 个。

## 何时使用

用户要记下或查出这些人的健康资料时用这个 skill：

- 病人档案（姓名、关系、出生日期、性别、电话、邮箱、备注、头像）
- 就诊、处方与用药状态
- 检查报告和报告附件
- 疫苗接种与即将到期的疫苗
- 过敏史、慢性病、手术史、紧急联系人
- 医疗保险
- 某人的健康概况（在用药、下次疫苗、最近就诊）

病人可以是任何人，不限于亲属。

## 服务简介

Worker `abot-health`，域名 `health.abot.run`，MCP 入口 `POST /mcp`，`serverInfo.name` 为 `abot-health-mcp`。

记录和附件元数据在 D1。文件在 R2 binding `FILES`：检查报告附件的 key 在 `patients/{patient_id}/lab-files/`，头像在 `avatars/{patient_id}.{ext}`。

病历、附件、医保按 `patient_id` 隔离。写操作会先确认病人存在。处方若带 `visit_id`，该就诊必须属于同一病人。检查报告附件若带 `lab_report_id`，该报告必须属于同一病人。

检查报告附件只接受 jpg、jpeg、png、webp、pdf，单文件 10MB。头像只接受 jpg、jpeg、png、webp，单文件 2MB。`content_base64` 可以带 data URL 前缀。

过敏 `severity` 只接受 `mild`、`moderate`、`severe`。慢性病 `status` 只接受 `active`、`managed`、`cured`。新建处方的 `status` 默认为 `active`。`add_emergency_contact` 把 `is_primary` 设为真时，同一病人的其他联系人会取消首选。`upcoming_vaccinations` 未传入正整数 `days` 时按 30 天查询。

## 认证

经网关 `abot.run` 调用，使用 `abot-mcp` CLI。网关从 OAuth token 注入 `X-Abot-Owner-Email`。本服务要求这个头；若配置了 `OWNER_EMAIL`，邮箱必须与之相同。服务不读取 `X-Internal-Token`。

不要直连 Worker 的 `/mcp`，也不要自己塞内部令牌。

## 使用示例

`abot-mcp` 的第一个参数是服务名 `health`。后面是发给 `/mcp` 的 JSON-RPC 正文，`method` 与 `params` 与 `src/worker.js` 一致。参数字段见 [references/tools.md](references/tools.md)，必填项标了 `*`。

列出工具：

```bash
abot-mcp health '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

添加病人并查看概况：

```bash
abot-mcp health '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_patient","arguments":{"name":"张三","relationship":"本人","gender":"男"}}}'

abot-mcp health '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health_summary","arguments":{"patient_id":"pat_替换成上一步返回的 id"}}}'
```

记下一次就诊和关联处方：

```bash
abot-mcp health '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_visit","arguments":{"patient_id":"pat_替换成实际 id","visit_date":"2026-10-01","hospital":"市一院","diagnosis":"感冒"}}}'

abot-mcp health '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"add_prescription","arguments":{"patient_id":"pat_替换成实际 id","visit_id":"visit_替换成上一步返回的 id","drug_name":"氨苄西林","usage":"一日三次"}}}'
```
