/**
 * abot-health — 健康数据服务
 * 病人、就诊、处方、检查报告、报告附件、疫苗、医疗保险。MCP 给 agent 用（经网关聚合）
 *
 * 安全约定：
 * - /mcp 只接受网关的 X-Internal-Token
 * - 必须携带 X-Abot-Owner-Email（网关从 OAuth token 注入）；
 *   若配置了 OWNER_EMAIL，则必须与之匹配
 * - 病人可以是任何人；relationship / notes 可选，只用于区分身份
 * - 病历与附件按 patient_id 隔离；写操作校验病人存在
 * - 附件存在 R2（binding FILES），元数据在 D1；仅 jpg/png/webp/pdf，单文件 10MB
 * - 病人头像存在 R2 avatars/{patient_id}.{ext}，仅 jpg/png/webp，单文件 2MB；
 *   patients.avatar_r2_key 存 R2 key
 * - 所有写操作校验 patient_id 存在；处方的 visit_id 必须属于同一病人
 * - 非法 JSON / 非对象请求就地返回，不把运行时异常抛给网关
 */

const PATIENT_SCOPED_TABLES = {
  allergies: "allergy_not_found",
  chronic_conditions: "chronic_condition_not_found",
  surgeries: "surgery_not_found",
  emergency_contacts: "emergency_contact_not_found",
  insurance: "insurance_not_found",
};

function newId(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const r = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

// 恒定时间比较，防时序攻击
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 客户端参数错误 → JSON-RPC -32602，message 可安全返回
class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = -32602;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const ALLERGY_SEVERITIES = ["mild", "moderate", "severe"];
const CHRONIC_STATUSES = ["active", "managed", "cured"];

const FILE_TYPES = [
  { ext: "jpg", mime: "image/jpeg", check: isJpeg },
  { ext: "jpeg", mime: "image/jpeg", check: isJpeg },
  { ext: "png", mime: "image/png", check: isPng },
  { ext: "webp", mime: "image/webp", check: isWebp },
  { ext: "pdf", mime: "application/pdf", check: isPdf },
];

function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
function isPng(b) {
  return b.length >= 8
    && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
}
function isWebp(b) {
  return b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
}
function isPdf(b) {
  return b.length >= 5
    && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

function decodeBase64(input, maxBytes = MAX_FILE_BYTES) {
  if (typeof input !== "string" || !input.trim()) throw new InputError("content_required");
  let b64 = input.trim();
  const dataUrl = b64.match(/^data:[^;,]+;base64,([\s\S]*)$/i);
  if (dataUrl) b64 = dataUrl[1];
  b64 = b64.replace(/\s/g, "");
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new InputError("invalid_base64");
  }
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const declared = (b64.length / 4) * 3 - pad;
  if (declared > maxBytes) throw new InputError("file_too_large");
  if (declared === 0) throw new InputError("empty_file");
  let bin;
  try { bin = atob(b64); } catch { throw new InputError("invalid_base64"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  if (out.length !== declared || out.length > maxBytes) throw new InputError("file_too_large");
  return out;
}

function bytesToBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function classifyFile(filename, bytes, types = FILE_TYPES) {
  if (typeof filename !== "string" || !filename.trim()) throw new InputError("filename_required");
  const base = filename.trim().split(/[/\\]/).pop();
  if (!base || base === "." || base === ".." || base.length > 200 || /[\u0000-\u001f]/.test(base)) {
    throw new InputError("invalid_filename");
  }
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const type = types.find((t) => t.ext === ext);
  if (!type) throw new InputError("unsupported_file_type");
  if (!type.check(bytes)) throw new InputError("file_type_mismatch");
  return { filename: base, mime: type.mime };
}

// 头像只接受图片（不接受 pdf）
const AVATAR_TYPES = [
  { ext: "jpg", mime: "image/jpeg", check: isJpeg },
  { ext: "jpeg", mime: "image/jpeg", check: isJpeg },
  { ext: "png", mime: "image/png", check: isPng },
  { ext: "webp", mime: "image/webp", check: isWebp },
];

function avatarExtFor(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function requireBucket(env) {
  if (!env.FILES || typeof env.FILES.put !== "function" || typeof env.FILES.get !== "function") {
    throw new Error("r2_not_configured");
  }
  return env.FILES;
}

async function ensureTables(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT,
      dob TEXT, gender TEXT, phone TEXT, email TEXT, notes TEXT,
      avatar_r2_key TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, visit_date TEXT NOT NULL,
      hospital TEXT, department TEXT, complaint TEXT, diagnosis TEXT, advice TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, visit_id TEXT,
      drug_name TEXT NOT NULL, spec TEXT, usage TEXT,
      start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS lab_reports (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, report_date TEXT NOT NULL,
      report_type TEXT, summary TEXT, file_url TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS lab_report_files (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, lab_report_id TEXT,
      filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS vaccinations (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, vaccine_name TEXT NOT NULL,
      dose_number INTEGER, total_doses INTEGER,
      vaccinated_at TEXT, next_due_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS allergies (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, allergen TEXT NOT NULL,
      reaction TEXT, severity TEXT, notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS chronic_conditions (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, condition_name TEXT NOT NULL,
      diagnosed_date TEXT, status TEXT DEFAULT 'active', notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS surgeries (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, surgery_name TEXT NOT NULL,
      surgery_date TEXT, hospital TEXT, surgeon TEXT, notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS emergency_contacts (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, name TEXT NOT NULL,
      relationship TEXT, phone TEXT, is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
    `CREATE TABLE IF NOT EXISTS insurance (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, provider TEXT NOT NULL,
      policy_number TEXT, plan_type TEXT, coverage_details TEXT,
      valid_from TEXT, valid_to TEXT, contact_phone TEXT, notes TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  ];
  for (const sql of stmts) {
    await env.DB.prepare(sql).run();
  }
  // 幂等迁移：老库 patients 表补 phone/email/gender/avatar_r2_key 列
  const cols = await env.DB.prepare("PRAGMA table_info(patients)").all();
  const names = new Set((cols.results || []).map((c) => c.name));
  if (!names.has("phone")) await env.DB.prepare("ALTER TABLE patients ADD COLUMN phone TEXT").run();
  if (!names.has("email")) await env.DB.prepare("ALTER TABLE patients ADD COLUMN email TEXT").run();
  if (!names.has("gender")) await env.DB.prepare("ALTER TABLE patients ADD COLUMN gender TEXT").run();
  if (!names.has("avatar_r2_key")) await env.DB.prepare("ALTER TABLE patients ADD COLUMN avatar_r2_key TEXT").run();
}

// 每个 isolate 只建一次表，避免每请求重复 D1 写入
let tablesReady = null;
function ensureTablesCached(env) {
  if (!tablesReady) {
    tablesReady = ensureTables(env).catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

const MCP_TOOLS = [
  { name: "add_patient", description: "添加病人（任意人）。relationship、gender、phone、email 与 notes 可选，用于区分身份",
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      relationship: { type: "string", description: "可选。身份或与记录者的关系，如本人、亲属、朋友、同事" },
      dob: { type: "string" },
      gender: { type: "string", description: "可选。性别，如男、女" },
      phone: { type: "string", description: "可选。联系电话" },
      email: { type: "string", description: "可选。联系邮箱" },
      notes: { type: "string", description: "可选备注，用于区分病人" } }, required: ["name"] } },
  { name: "update_patient", description: "更新病人信息（relationship、dob、gender、phone、email、notes 可选更新）",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" },
      name: { type: "string" },
      relationship: { type: "string" },
      dob: { type: "string" },
      gender: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      notes: { type: "string" } }, required: ["patient_id"] } },
  { name: "list_patients", description: "列出所有病人",
    inputSchema: { type: "object", properties: {} } },
  { name: "upload_patient_avatar", description: "上传/更换病人头像（jpg/png/webp，2MB 以内）。覆盖同一病人的旧头像",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" },
      filename: { type: "string", description: "原始文件名，用于判断图片类型" },
      content_base64: { type: "string", description: "图片内容的 base64（可带 data URL 前缀）" } },
      required: ["patient_id", "filename", "content_base64"] } },
  { name: "add_visit", description: "添加就诊记录",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, visit_date: { type: "string" },
      hospital: { type: "string" }, department: { type: "string" },
      complaint: { type: "string" }, diagnosis: { type: "string" }, advice: { type: "string" } },
      required: ["patient_id", "visit_date"] } },
  { name: "list_visits", description: "列出就诊记录",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } } } },
  { name: "add_prescription", description: "添加处方/用药",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, visit_id: { type: "string" },
      drug_name: { type: "string" }, spec: { type: "string" }, usage: { type: "string" },
      start_date: { type: "string" } }, required: ["patient_id", "drug_name"] } },
  { name: "list_prescriptions", description: "列出用药（可按状态过滤）",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, status: { type: "string" } } } },
  { name: "update_prescription", description: "更新用药状态（停药/吃完）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, status: { type: "string" }, end_date: { type: "string" } },
      required: ["id"] } },
  { name: "add_lab_report", description: "添加检查报告",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, report_date: { type: "string" },
      report_type: { type: "string" }, summary: { type: "string" }, file_url: { type: "string" } },
      required: ["patient_id", "report_date"] } },
  { name: "list_lab_reports", description: "列出检查报告",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } } } },
  { name: "upload_lab_report_file", description: "上传检查报告附件（jpg/png/webp/pdf，单文件 10MB），返回 file_id",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" },
      lab_report_id: { type: "string", description: "可选，关联到某条检查报告；必须属于同一病人" },
      filename: { type: "string", description: "原始文件名，用于判断类型" },
      content_base64: { type: "string", description: "文件内容的 base64" } },
      required: ["patient_id", "filename", "content_base64"] } },
  { name: "get_lab_report_file", description: "下载检查报告附件。必须带所属 patient_id，不能读取其他病人的文件",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, file_id: { type: "string" } },
      required: ["patient_id", "file_id"] } },
  { name: "list_lab_report_files", description: "列出某病人的检查报告附件（不含文件内容）",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" },
      lab_report_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_vaccination", description: "添加疫苗接种记录",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, vaccine_name: { type: "string" },
      dose_number: { type: "integer" }, total_doses: { type: "integer" },
      vaccinated_at: { type: "string" }, next_due_at: { type: "string" } },
      required: ["patient_id", "vaccine_name"] } },
  { name: "upcoming_vaccinations", description: "即将到期的疫苗",
    inputSchema: { type: "object", properties: { days: { type: "integer" } } } },
  { name: "health_summary", description: "健康概况：在吃什么药、下次疫苗、最近就诊",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } } } },
{ name: "list_allergies", description: "列出某病人的过敏史",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_allergy", description: "添加过敏史",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, allergen: { type: "string", description: "过敏原" },
      reaction: { type: "string", description: "反应症状" },
      severity: { type: "string", description: "严重程度：mild/moderate/severe" },
      notes: { type: "string" } }, required: ["patient_id", "allergen"] } },
  { name: "delete_allergy", description: "删除过敏史（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "list_chronic_conditions", description: "列出某病人的慢性病史",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_chronic_condition", description: "添加慢性病史",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, condition_name: { type: "string", description: "疾病名" },
      diagnosed_date: { type: "string", description: "确诊日期" },
      status: { type: "string", description: "active/managed/cured" },
      notes: { type: "string" } }, required: ["patient_id", "condition_name"] } },
  { name: "update_chronic_condition", description: "更新慢性病史（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" },
      condition_name: { type: "string" }, diagnosed_date: { type: "string" },
      status: { type: "string", description: "active/managed/cured" }, notes: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "delete_chronic_condition", description: "删除慢性病史（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "list_surgeries", description: "列出某病人的手术史",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_surgery", description: "添加手术史",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, surgery_name: { type: "string", description: "手术名" },
      surgery_date: { type: "string" }, hospital: { type: "string" },
      surgeon: { type: "string" }, notes: { type: "string" } },
      required: ["patient_id", "surgery_name"] } },
  { name: "delete_surgery", description: "删除手术史（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "list_emergency_contacts", description: "列出某病人的紧急联系人",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_emergency_contact", description: "添加紧急联系人；设为首选时，同一病人的其他联系人取消首选",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" }, name: { type: "string" },
      relationship: { type: "string" }, phone: { type: "string" },
      is_primary: { type: "boolean", description: "是否首选" } },
      required: ["patient_id", "name"] } },
  { name: "delete_emergency_contact", description: "删除紧急联系人（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "list_insurance", description: "列出某病人的医疗保险",
    inputSchema: { type: "object", properties: { patient_id: { type: "string" } },
      required: ["patient_id"] } },
  { name: "add_insurance", description: "添加医疗保险",
    inputSchema: { type: "object", properties: {
      patient_id: { type: "string" },
      provider: { type: "string", description: "保险公司，如平安健康、中国人寿" },
      policy_number: { type: "string", description: "保单号" },
      plan_type: { type: "string", description: "险种：社保/商保/新农合/城乡居民医保等" },
      coverage_details: { type: "string", description: "保障内容，如住院报销比例、门诊额度" },
      valid_from: { type: "string", description: "生效日期" },
      valid_to: { type: "string", description: "到期日期" },
      contact_phone: { type: "string", description: "保险公司客服电话" },
      notes: { type: "string" } },
      required: ["patient_id", "provider"] } },
  { name: "update_insurance", description: "更新医疗保险（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" },
      provider: { type: "string" }, policy_number: { type: "string" },
      plan_type: { type: "string" }, coverage_details: { type: "string" },
      valid_from: { type: "string" }, valid_to: { type: "string" },
      contact_phone: { type: "string" }, notes: { type: "string" } },
      required: ["id", "patient_id"] } },
  { name: "delete_insurance", description: "删除医疗保险（仅限该病人的记录）",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, patient_id: { type: "string" } },
      required: ["id", "patient_id"] } },
];

// 写操作前校验病人存在，防止孤儿记录
async function requirePatient(DB, patient_id) {
  if (!patient_id) throw new InputError("patient_id_required");
  const row = await DB.prepare("SELECT 1 AS ok FROM patients WHERE id=?").bind(patient_id).first();
  if (!row) throw new InputError("patient_not_found");
}

async function deleteOwned(DB, table, args) {
  const notFound = PATIENT_SCOPED_TABLES[table];
  if (!notFound) throw new Error("bad table");
  if (!args.id) throw new InputError("id_required");
  await requirePatient(DB, args.patient_id);
  const res = await DB.prepare(`DELETE FROM ${table} WHERE id=? AND patient_id=?`)
    .bind(args.id, args.patient_id).run();
  const changes = res && res.meta ? res.meta.changes : 0;
  if (!changes) throw new InputError(notFound);
  return { ok: true };
}

async function requireOwnLabReport(DB, lab_report_id, patient_id) {
  if (!lab_report_id) return null;
  const row = await DB.prepare("SELECT id, patient_id FROM lab_reports WHERE id=?").bind(lab_report_id).first();
  if (!row || row.patient_id !== patient_id) throw new InputError("lab_report_not_found");
  return row;
}

// 缺失、别人的就诊，都报 visit_not_found，避免用存在性差异探测其他病人
async function requireOwnedVisit(DB, visit_id, patient_id) {
  if (!visit_id) return;
  if (typeof visit_id !== "string") throw new InputError("visit_not_found");
  const row = await DB.prepare("SELECT patient_id FROM visits WHERE id=?").bind(visit_id).first();
  if (!row || row.patient_id !== patient_id) throw new InputError("visit_not_found");
}

async function callTool(name, args, env) {
  await ensureTablesCached(env);
  const DB = env.DB;

  if (name === "add_patient") {
    if (!args.name || !String(args.name).trim()) throw new InputError("name_required");
    const id = newId("pat");
    await DB.prepare("INSERT INTO patients (id,name,relationship,dob,gender,phone,email,notes) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, String(args.name).trim(), args.relationship || null, args.dob || null, args.gender || null,
        args.phone || null, args.email || null, args.notes || null).run();
    return { id };
  }
  if (name === "update_patient") {
    await requirePatient(DB, args.patient_id);
    const fields = [];
    const params = [];
    for (const key of ["name", "relationship", "dob", "gender", "phone", "email", "notes"]) {
      if (args[key] !== undefined) {
        const v = key === "name" ? String(args[key]).trim() : (args[key] || null);
        if (key === "name" && !v) throw new InputError("name_required");
        fields.push(`${key}=?`);
        params.push(v);
      }
    }
    if (!fields.length) throw new InputError("nothing_to_update");
    params.push(args.patient_id);
    await DB.prepare(`UPDATE patients SET ${fields.join(", ")} WHERE id=?`).bind(...params).run();
    return { ok: true };
  }
  if (name === "list_patients") {
    const r = await DB.prepare("SELECT * FROM patients ORDER BY created_at").all();
    return { patients: r.results };
  }
  if (name === "upload_patient_avatar") {
    await requirePatient(DB, args.patient_id);
    const bytes = decodeBase64(args.content_base64, MAX_AVATAR_BYTES);
    const { mime } = classifyFile(args.filename, bytes, AVATAR_TYPES);
    const bucket = requireBucket(env);
    const r2Key = "avatars/" + args.patient_id + "." + avatarExtFor(mime);
    const prev = await DB.prepare("SELECT avatar_r2_key FROM patients WHERE id=?").bind(args.patient_id).first();
    const prevKey = prev && prev.avatar_r2_key;
    await bucket.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
    try {
      await DB.prepare("UPDATE patients SET avatar_r2_key=? WHERE id=?")
        .bind(r2Key, args.patient_id).run();
    } catch (err) {
      try { await bucket.delete(r2Key); } catch { /* D1 写入失败时尽量清掉对象 */ }
      throw err;
    }
    // 清理旧头像（换扩展名时），只删该病人自己的旧 key
    if (typeof prevKey === "string" && prevKey !== r2Key
      && prevKey.startsWith("avatars/" + args.patient_id + ".")) {
      try { await bucket.delete(prevKey); } catch { /* 忽略 */ }
    }
    return { ok: true, r2_key: r2Key };
  }
  if (name === "add_visit") {
    await requirePatient(DB, args.patient_id);
    if (!args.visit_date) throw new InputError("visit_date_required");
    const id = newId("visit");
    await DB.prepare(`INSERT INTO visits (id,patient_id,visit_date,hospital,department,complaint,diagnosis,advice)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.visit_date,
      args.hospital || null, args.department || null, args.complaint || null,
      args.diagnosis || null, args.advice || null).run();
    return { id };
  }
  if (name === "list_visits") {
    let sql = "SELECT * FROM visits", params = [];
    if (args.patient_id) { sql += " WHERE patient_id=?"; params.push(args.patient_id); }
    sql += " ORDER BY visit_date DESC";
    const r = await DB.prepare(sql).bind(...params).all();
    return { visits: r.results };
  }
  if (name === "add_prescription") {
    await requirePatient(DB, args.patient_id);
    await requireOwnedVisit(DB, args.visit_id, args.patient_id);
    if (!args.drug_name) throw new InputError("drug_name_required");
    const id = newId("rx");
    await DB.prepare(`INSERT INTO prescriptions (id,patient_id,visit_id,drug_name,spec,usage,start_date)
      VALUES (?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.visit_id || null,
      args.drug_name, args.spec || null, args.usage || null, args.start_date || null).run();
    return { id };
  }
  if (name === "list_prescriptions") {
    let sql = "SELECT * FROM prescriptions WHERE 1=1", params = [];
    if (args.patient_id) { sql += " AND patient_id=?"; params.push(args.patient_id); }
    if (args.status) { sql += " AND status=?"; params.push(args.status); }
    sql += " ORDER BY created_at DESC";
    const r = await DB.prepare(sql).bind(...params).all();
    return { prescriptions: r.results };
  }
  if (name === "update_prescription") {
    if (!args.id) throw new InputError("id_required");
    const sets = [], params = [];
    if (args.status !== undefined) { sets.push("status=?"); params.push(args.status); }
    if (args.end_date !== undefined) { sets.push("end_date=?"); params.push(args.end_date); }
    if (!sets.length) throw new InputError("nothing_to_update");
    params.push(args.id);
    const res = await DB.prepare(`UPDATE prescriptions SET ${sets.join(",")} WHERE id=?`).bind(...params).run();
    const changes = res && res.meta ? res.meta.changes : 0;
    if (!changes) throw new InputError("prescription_not_found");
    return { ok: true };
  }
  if (name === "add_lab_report") {
    await requirePatient(DB, args.patient_id);
    if (!args.report_date) throw new InputError("report_date_required");
    const id = newId("lab");
    await DB.prepare(`INSERT INTO lab_reports (id,patient_id,report_date,report_type,summary,file_url)
      VALUES (?,?,?,?,?,?)`).bind(id, args.patient_id, args.report_date,
      args.report_type || null, args.summary || null, args.file_url || null).run();
    return { id };
  }
  if (name === "list_lab_reports") {
    let sql = "SELECT * FROM lab_reports", params = [];
    if (args.patient_id) { sql += " WHERE patient_id=?"; params.push(args.patient_id); }
    sql += " ORDER BY report_date DESC";
    const r = await DB.prepare(sql).bind(...params).all();
    return { lab_reports: r.results };
  }
  if (name === "upload_lab_report_file") {
    await requirePatient(DB, args.patient_id);
    await requireOwnLabReport(DB, args.lab_report_id, args.patient_id);
    const bytes = decodeBase64(args.content_base64);
    const { filename, mime } = classifyFile(args.filename, bytes);
    const bucket = requireBucket(env);
    const id = newId("file");
    const patientId = args.patient_id;
    const r2Key = `patients/${patientId}/lab-files/${id}`;
    await bucket.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
    try {
      await DB.prepare(`INSERT INTO lab_report_files (id,patient_id,lab_report_id,filename,mime,size,r2_key)
        VALUES (?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.lab_report_id || null,
        filename, mime, bytes.length, r2Key).run();
    } catch (err) {
      try { await bucket.delete(r2Key); } catch { /* 元数据写入失败时尽量清掉对象 */ }
      throw err;
    }
    return { file_id: id };
  }
  if (name === "get_lab_report_file") {
    await requirePatient(DB, args.patient_id);
    if (!args.file_id) throw new InputError("file_id_required");
    const row = await DB.prepare(
      "SELECT id, patient_id, lab_report_id, filename, mime, size, r2_key FROM lab_report_files WHERE id=? AND patient_id=?"
    ).bind(args.file_id, args.patient_id).first();
    const patientId = args.patient_id;
    const prefix = `patients/${patientId}/`;
    if (!row || typeof row.r2_key !== "string" || !row.r2_key.startsWith(prefix)) {
      throw new InputError("file_not_found");
    }
    const obj = await requireBucket(env).get(row.r2_key);
    if (!obj) throw new InputError("file_not_found");
    const buf = new Uint8Array(await obj.arrayBuffer());
    return {
      file_id: row.id,
      patient_id: row.patient_id,
      lab_report_id: row.lab_report_id,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      content_base64: bytesToBase64(buf),
    };
  }
  if (name === "list_lab_report_files") {
    await requirePatient(DB, args.patient_id);
    let sql = "SELECT id, patient_id, lab_report_id, filename, mime, size, r2_key, created_at FROM lab_report_files WHERE patient_id=?";
    const params = [args.patient_id];
    if (args.lab_report_id) { sql += " AND lab_report_id=?"; params.push(args.lab_report_id); }
    sql += " ORDER BY created_at DESC";
    const r = await DB.prepare(sql).bind(...params).all();
    const files = (r.results || []).map((row) => ({
      file_id: row.id,
      patient_id: row.patient_id,
      lab_report_id: row.lab_report_id,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      created_at: row.created_at,
    }));
    return { files };
  }
  if (name === "add_vaccination") {
    await requirePatient(DB, args.patient_id);
    if (!args.vaccine_name) throw new InputError("vaccine_name_required");
    const id = newId("vax");
    await DB.prepare(`INSERT INTO vaccinations (id,patient_id,vaccine_name,dose_number,total_doses,vaccinated_at,next_due_at)
      VALUES (?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.vaccine_name,
      args.dose_number ?? null, args.total_doses ?? null,
      args.vaccinated_at || null, args.next_due_at || null).run();
    return { id };
  }
  if (name === "upcoming_vaccinations") {
    const days = Number.isInteger(args.days) && args.days > 0 ? args.days : 30;
    const r = await DB.prepare(`SELECT v.*, p.name as patient_name FROM vaccinations v
      JOIN patients p ON v.patient_id = p.id
      WHERE v.next_due_at IS NOT NULL
      AND date(v.next_due_at) >= date('now')
      AND date(v.next_due_at) <= date('now', '+' || ? || ' days')
      ORDER BY v.next_due_at`).bind(days).all();
    return { vaccinations: r.results };
  }
  if (name === "health_summary") {
    const pid = args.patient_id;
    if (pid) await requirePatient(DB, pid);
    const rx = await DB.prepare(
      `SELECT drug_name, spec, usage FROM prescriptions WHERE status='active'`
      + (pid ? " AND patient_id=?" : "")).bind(...(pid ? [pid] : [])).all();
    const vax = await DB.prepare(
      `SELECT vaccine_name, dose_number, total_doses, next_due_at FROM vaccinations WHERE next_due_at IS NOT NULL AND date(next_due_at) >= date('now')`
      + (pid ? " AND patient_id=?" : "") + ` ORDER BY next_due_at LIMIT 5`).bind(...(pid ? [pid] : [])).all();
    const visit = await DB.prepare(
      `SELECT visit_date, hospital, diagnosis FROM visits`
      + (pid ? " WHERE patient_id=?" : "") + ` ORDER BY visit_date DESC LIMIT 3`).bind(...(pid ? [pid] : [])).all();
    return {
      active_medications: rx.results,
      upcoming_vaccines: vax.results,
      recent_visits: visit.results,
    };
  }
  if (name === "list_allergies") {
    await requirePatient(DB, args.patient_id);
    const r = await DB.prepare("SELECT * FROM allergies WHERE patient_id=? ORDER BY created_at DESC")
      .bind(args.patient_id).all();
    return { allergies: r.results };
  }
  if (name === "add_allergy") {
    await requirePatient(DB, args.patient_id);
    if (!args.allergen) throw new InputError("allergen_required");
    const severity = args.severity || null;
    if (severity && !ALLERGY_SEVERITIES.includes(severity)) throw new InputError("invalid_severity");
    const id = newId("alg");
    await DB.prepare(`INSERT INTO allergies (id,patient_id,allergen,reaction,severity,notes)
      VALUES (?,?,?,?,?,?)`).bind(id, args.patient_id, args.allergen,
      args.reaction || null, severity, args.notes || null).run();
    return { id };
  }
  if (name === "delete_allergy") return deleteOwned(DB, "allergies", args);
  if (name === "list_chronic_conditions") {
    await requirePatient(DB, args.patient_id);
    const r = await DB.prepare(
      "SELECT * FROM chronic_conditions WHERE patient_id=? ORDER BY created_at DESC")
      .bind(args.patient_id).all();
    return { chronic_conditions: r.results };
  }
  if (name === "add_chronic_condition") {
    await requirePatient(DB, args.patient_id);
    if (!args.condition_name) throw new InputError("condition_name_required");
    const status = args.status || "active";
    if (!CHRONIC_STATUSES.includes(status)) throw new InputError("invalid_status");
    const id = newId("cond");
    await DB.prepare(`INSERT INTO chronic_conditions (id,patient_id,condition_name,diagnosed_date,status,notes)
      VALUES (?,?,?,?,?,?)`).bind(id, args.patient_id, args.condition_name,
      args.diagnosed_date || null, status, args.notes || null).run();
    return { id };
  }
  if (name === "update_chronic_condition") {
    if (!args.id) throw new InputError("id_required");
    await requirePatient(DB, args.patient_id);
    const sets = [], params = [];
    if (args.condition_name !== undefined) {
      if (!args.condition_name) throw new InputError("condition_name_required");
      sets.push("condition_name=?"); params.push(args.condition_name);
    }
    if (args.diagnosed_date !== undefined) { sets.push("diagnosed_date=?"); params.push(args.diagnosed_date || null); }
    if (args.status !== undefined) {
      if (!CHRONIC_STATUSES.includes(args.status)) throw new InputError("invalid_status");
      sets.push("status=?"); params.push(args.status);
    }
    if (args.notes !== undefined) { sets.push("notes=?"); params.push(args.notes || null); }
    if (!sets.length) throw new InputError("nothing_to_update");
    params.push(args.id, args.patient_id);
    const res = await DB.prepare(
      `UPDATE chronic_conditions SET ${sets.join(",")} WHERE id=? AND patient_id=?`).bind(...params).run();
    const changes = res && res.meta ? res.meta.changes : 0;
    if (!changes) throw new InputError("chronic_condition_not_found");
    return { ok: true };
  }
  if (name === "delete_chronic_condition") return deleteOwned(DB, "chronic_conditions", args);
  if (name === "list_surgeries") {
    await requirePatient(DB, args.patient_id);
    const r = await DB.prepare("SELECT * FROM surgeries WHERE patient_id=? ORDER BY created_at DESC")
      .bind(args.patient_id).all();
    return { surgeries: r.results };
  }
  if (name === "add_surgery") {
    await requirePatient(DB, args.patient_id);
    if (!args.surgery_name) throw new InputError("surgery_name_required");
    const id = newId("surg");
    await DB.prepare(`INSERT INTO surgeries (id,patient_id,surgery_name,surgery_date,hospital,surgeon,notes)
      VALUES (?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.surgery_name,
      args.surgery_date || null, args.hospital || null, args.surgeon || null, args.notes || null).run();
    return { id };
  }
  if (name === "delete_surgery") return deleteOwned(DB, "surgeries", args);
  if (name === "list_emergency_contacts") {
    await requirePatient(DB, args.patient_id);
    const r = await DB.prepare(
      "SELECT * FROM emergency_contacts WHERE patient_id=? ORDER BY created_at DESC")
      .bind(args.patient_id).all();
    return { emergency_contacts: r.results };
  }
  if (name === "add_emergency_contact") {
    await requirePatient(DB, args.patient_id);
    if (!args.name) throw new InputError("name_required");
    const primary = args.is_primary ? 1 : 0;
    if (primary) {
      await DB.prepare("UPDATE emergency_contacts SET is_primary=? WHERE patient_id=?")
        .bind(0, args.patient_id).run();
    }
    const id = newId("ec");
    await DB.prepare(`INSERT INTO emergency_contacts (id,patient_id,name,relationship,phone,is_primary)
      VALUES (?,?,?,?,?,?)`).bind(id, args.patient_id, args.name,
      args.relationship || null, args.phone || null, primary).run();
    return { id };
  }
  if (name === "delete_emergency_contact") return deleteOwned(DB, "emergency_contacts", args);
  if (name === "list_insurance") {
    await requirePatient(DB, args.patient_id);
    const r = await DB.prepare("SELECT * FROM insurance WHERE patient_id=? ORDER BY created_at DESC")
      .bind(args.patient_id).all();
    return { insurance: r.results };
  }
  if (name === "add_insurance") {
    await requirePatient(DB, args.patient_id);
    if (!args.provider || !String(args.provider).trim()) throw new InputError("provider_required");
    const id = newId("ins");
    await DB.prepare(`INSERT INTO insurance
      (id,patient_id,provider,policy_number,plan_type,coverage_details,valid_from,valid_to,contact_phone,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      id, args.patient_id, String(args.provider).trim(),
      args.policy_number || null, args.plan_type || null, args.coverage_details || null,
      args.valid_from || null, args.valid_to || null, args.contact_phone || null, args.notes || null).run();
    return { id };
  }
  if (name === "update_insurance") {
    if (!args.id) throw new InputError("id_required");
    await requirePatient(DB, args.patient_id);
    const sets = [], params = [];
    if (args.provider !== undefined) {
      if (!args.provider || !String(args.provider).trim()) throw new InputError("provider_required");
      sets.push("provider=?"); params.push(String(args.provider).trim());
    }
    if (args.policy_number !== undefined) { sets.push("policy_number=?"); params.push(args.policy_number || null); }
    if (args.plan_type !== undefined) { sets.push("plan_type=?"); params.push(args.plan_type || null); }
    if (args.coverage_details !== undefined) { sets.push("coverage_details=?"); params.push(args.coverage_details || null); }
    if (args.valid_from !== undefined) { sets.push("valid_from=?"); params.push(args.valid_from || null); }
    if (args.valid_to !== undefined) { sets.push("valid_to=?"); params.push(args.valid_to || null); }
    if (args.contact_phone !== undefined) { sets.push("contact_phone=?"); params.push(args.contact_phone || null); }
    if (args.notes !== undefined) { sets.push("notes=?"); params.push(args.notes || null); }
    if (!sets.length) throw new InputError("nothing_to_update");
    params.push(args.id, args.patient_id);
    const res = await DB.prepare(
      `UPDATE insurance SET ${sets.join(",")} WHERE id=? AND patient_id=?`).bind(...params).run();
    const changes = res && res.meta ? res.meta.changes : 0;
    if (!changes) throw new InputError("insurance_not_found");
    return { ok: true };
  }
  if (name === "delete_insurance") return deleteOwned(DB, "insurance", args);
  throw new Error(`unknown tool: ${name}`);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Internal-Token, X-Abot-Owner-Email",
  "Access-Control-Max-Age": "86400",
};

function corsJson(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      try {
        await ensureTablesCached(env);
        return corsJson({ ok: true, service: "abot-health" });
      } catch (e) {
        console.error("health check error:", e && e.stack ? e.stack : e);
        return corsJson({ ok: false, error: "internal_error" }, 500);
      }
    }
    // 内部鉴权：只接受网关的 X-Internal-Token，且必须携带网关注入的 owner 邮箱
    if (url.pathname === "/mcp") {
      const it = request.headers.get("X-Internal-Token") || "";
      if (!env.INTERNAL_TOKEN || !safeEqual(it, env.INTERNAL_TOKEN)) {
        return corsJson({ error: "unauthorized" }, 401);
      }
      const ownerEmail = request.headers.get("X-Abot-Owner-Email") || "";
      if (!ownerEmail) {
        return corsJson({ error: "owner email required" }, 401);
      }
      // 部署身份校验：配置了 OWNER_EMAIL 时必须匹配，防止直连绕过网关身份
      if (env.OWNER_EMAIL && ownerEmail !== env.OWNER_EMAIL) {
        return corsJson({ error: "unauthorized" }, 401);
      }
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      let msg;
      try {
        msg = await request.json();
      } catch {
        console.error("health mcp parse error");
        return Response.json({ jsonrpc: "2.0", id: null,
          error: { code: -32700, message: "parse_error" } }, { status: 400 });
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        return Response.json({ jsonrpc: "2.0", id: null,
          error: { code: -32600, message: "invalid_request" } }, { status: 400 });
      }
      const id = msg.id ?? null;
      try {
        if (msg.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id, result: {
            protocolVersion: "2025-06-18", capabilities: { tools: {} },
            serverInfo: { name: "abot-health-mcp", version: "1.1.0" } } });
        }
        if (msg.method === "tools/list") {
          return corsJson({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
        }
        if (msg.method === "tools/call") {
          const params = msg.params || {};
          const name = params.name;
          const args = params.arguments || {};
          const known = MCP_TOOLS.some((t) => t.name === name);
          if (!known) {
            return Response.json({ jsonrpc: "2.0", id,
              error: { code: -32601, message: `unknown tool: ${name}` } });
          }
          const result = await callTool(name, args, env);
          const text = JSON.stringify(result);
          return Response.json({ jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: text }] } });
        }
        return Response.json({ jsonrpc: "2.0", id,
          error: { code: -32601, message: "Method not found" } });
      } catch (e) {
        // 客户端参数错误可安全返回；其余一律 internal_error，不泄漏实现细节
        if (e instanceof InputError) {
          return Response.json({ jsonrpc: "2.0", id,
            error: { code: -32602, message: e.message } });
        }
        console.error("health mcp error:", e && e.stack ? e.stack : e);
        return Response.json({ jsonrpc: "2.0", id,
          error: { code: -32603, message: "internal_error" } });
      }
    }
    return corsJson({ error: "not found" }, 404);
  },
};
