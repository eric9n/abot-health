# abot-health

健康数据服务：病人（任意人，不限于亲属）、就诊记录、处方、用药、检查报告、报告附件、疫苗、医疗保险。

- Worker: `abot-health`
- 域名: `health.abot.run`
- MCP: `POST /mcp`（34 个工具）
- 医疗保险：`list_insurance` / `add_insurance` / `update_insurance` / `delete_insurance`，按 `patient_id` 隔离。查看页医保标签在到期前 30 天黄色提醒
- 数据：D1 存记录和附件元数据（文件名、MIME、大小、R2 key）；R2 binding `FILES` 存文件
- 附件：`upload_lab_report_file` / `get_lab_report_file` / `list_lab_report_files`。仅 jpg、png、webp、pdf，单文件 10MB，按 `patient_id` 隔离
- 病人：`relationship`、`notes` 可选，只用于区分身份。病历和附件仍按 `patient_id` 查询

测试：`node test/basic.js`
