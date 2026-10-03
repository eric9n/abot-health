# MCP 工具

摘自 `src/worker.js` 的 `MCP_TOOLS`，共 34 个。`*` 表示该参数在 `inputSchema.required` 里。参数说明只保留源码里的 `description`。

## add_patient

添加病人（任意人）。relationship、gender、phone、email 与 notes 可选，用于区分身份

参数：

- `name`*（string）
- `relationship`（string） — 可选。身份或与记录者的关系，如本人、亲属、朋友、同事
- `dob`（string）
- `gender`（string） — 可选。性别，如男、女
- `phone`（string） — 可选。联系电话
- `email`（string） — 可选。联系邮箱
- `notes`（string） — 可选备注，用于区分病人

## update_patient

更新病人信息（relationship、dob、gender、phone、email、notes 可选更新）

参数：

- `patient_id`*（string）
- `name`（string）
- `relationship`（string）
- `dob`（string）
- `gender`（string）
- `phone`（string）
- `email`（string）
- `notes`（string）

## list_patients

列出所有病人

参数：无

## upload_patient_avatar

上传/更换病人头像（jpg/png/webp，2MB 以内）。覆盖同一病人的旧头像

参数：

- `patient_id`*（string）
- `filename`*（string） — 原始文件名，用于判断图片类型
- `content_base64`*（string） — 图片内容的 base64（可带 data URL 前缀）

## add_visit

添加就诊记录

参数：

- `patient_id`*（string）
- `visit_date`*（string）
- `hospital`（string）
- `department`（string）
- `complaint`（string）
- `diagnosis`（string）
- `advice`（string）

## list_visits

列出就诊记录

参数：

- `patient_id`（string）

## add_prescription

添加处方/用药

参数：

- `patient_id`*（string）
- `visit_id`（string）
- `drug_name`*（string）
- `spec`（string）
- `usage`（string）
- `start_date`（string）

## list_prescriptions

列出用药（可按状态过滤）

参数：

- `patient_id`（string）
- `status`（string）

## update_prescription

更新用药状态（停药/吃完）

参数：

- `id`*（string）
- `status`（string）
- `end_date`（string）

## add_lab_report

添加检查报告

参数：

- `patient_id`*（string）
- `report_date`*（string）
- `report_type`（string）
- `summary`（string）
- `file_url`（string）

## list_lab_reports

列出检查报告

参数：

- `patient_id`（string）

## upload_lab_report_file

上传检查报告附件（jpg/png/webp/pdf，单文件 10MB），返回 file_id

参数：

- `patient_id`*（string）
- `lab_report_id`（string） — 可选，关联到某条检查报告；必须属于同一病人
- `filename`*（string） — 原始文件名，用于判断类型
- `content_base64`*（string） — 文件内容的 base64

## get_lab_report_file

下载检查报告附件。必须带所属 patient_id，不能读取其他病人的文件

参数：

- `patient_id`*（string）
- `file_id`*（string）

## list_lab_report_files

列出某病人的检查报告附件（不含文件内容）

参数：

- `patient_id`*（string）
- `lab_report_id`（string）

## add_vaccination

添加疫苗接种记录

参数：

- `patient_id`*（string）
- `vaccine_name`*（string）
- `dose_number`（integer）
- `total_doses`（integer）
- `vaccinated_at`（string）
- `next_due_at`（string）

## upcoming_vaccinations

即将到期的疫苗

参数：

- `days`（integer）

## health_summary

健康概况：在吃什么药、下次疫苗、最近就诊

参数：

- `patient_id`（string）

## list_allergies

列出某病人的过敏史

参数：

- `patient_id`*（string）

## add_allergy

添加过敏史

参数：

- `patient_id`*（string）
- `allergen`*（string） — 过敏原
- `reaction`（string） — 反应症状
- `severity`（string） — 严重程度：mild/moderate/severe
- `notes`（string）

## delete_allergy

删除过敏史（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）

## list_chronic_conditions

列出某病人的慢性病史

参数：

- `patient_id`*（string）

## add_chronic_condition

添加慢性病史

参数：

- `patient_id`*（string）
- `condition_name`*（string） — 疾病名
- `diagnosed_date`（string） — 确诊日期
- `status`（string） — active/managed/cured
- `notes`（string）

## update_chronic_condition

更新慢性病史（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）
- `condition_name`（string）
- `diagnosed_date`（string）
- `status`（string） — active/managed/cured
- `notes`（string）

## delete_chronic_condition

删除慢性病史（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）

## list_surgeries

列出某病人的手术史

参数：

- `patient_id`*（string）

## add_surgery

添加手术史

参数：

- `patient_id`*（string）
- `surgery_name`*（string） — 手术名
- `surgery_date`（string）
- `hospital`（string）
- `surgeon`（string）
- `notes`（string）

## delete_surgery

删除手术史（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）

## list_emergency_contacts

列出某病人的紧急联系人

参数：

- `patient_id`*（string）

## add_emergency_contact

添加紧急联系人；设为首选时，同一病人的其他联系人取消首选

参数：

- `patient_id`*（string）
- `name`*（string）
- `relationship`（string）
- `phone`（string）
- `is_primary`（boolean） — 是否首选

## delete_emergency_contact

删除紧急联系人（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）

## list_insurance

列出某病人的医疗保险

参数：

- `patient_id`*（string）

## add_insurance

添加医疗保险

参数：

- `patient_id`*（string）
- `provider`*（string） — 保险公司，如平安健康、中国人寿
- `policy_number`（string） — 保单号
- `plan_type`（string） — 险种：社保/商保/新农合/城乡居民医保等
- `coverage_details`（string） — 保障内容，如住院报销比例、门诊额度
- `valid_from`（string） — 生效日期
- `valid_to`（string） — 到期日期
- `contact_phone`（string） — 保险公司客服电话
- `notes`（string）

## update_insurance

更新医疗保险（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）
- `provider`（string）
- `policy_number`（string）
- `plan_type`（string）
- `coverage_details`（string）
- `valid_from`（string）
- `valid_to`（string）
- `contact_phone`（string）
- `notes`（string）

## delete_insurance

删除医疗保险（仅限该病人的记录）

参数：

- `id`*（string）
- `patient_id`*（string）

