/**
 * abot-health v1 — 个人健康数据服务
 * 病历/处方/体检/疫苗，MCP 给 agent 用（经网关聚合）
 *
 * 安全约定：
 * - /mcp 只接受网关的 X-Internal-Token
 * - 必须携带 X-Abot-Owner-Email（网关从 OAuth token 注入）；
 *   若配置了 OWNER_EMAIL，则必须与之匹配（单家庭模式）
 * - 所有写操作校验 patient_id 存在
 */

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

async function ensureTables(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT,
      dob TEXT, notes TEXT,
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
    `CREATE TABLE IF NOT EXISTS vaccinations (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, vaccine_name TEXT NOT NULL,
      dose_number INTEGER, total_doses INTEGER,
      vaccinated_at TEXT, next_due_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  ];
  for (const sql of stmts) {
    await env.DB.prepare(sql).run();
  }
}

// 每个 isolate 只建一次表，避免每请求 5 次 D1 写入
let tablesReady = null;
function ensureTablesCached(env) {
  if (!tablesReady) tablesReady = ensureTables(env);
  return tablesReady;
}

const MCP_TOOLS = [
  { name: "add_patient", description: "添加家庭成员（病人）",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, relationship: { type: "string", description: "本人/父亲/母亲/…" },
      dob: { type: "string" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "list_patients", description: "列出所有家庭成员",
    inputSchema: { type: "object", properties: {} } },
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
];

// 写操作前校验病人存在，防止孤儿记录
async function requirePatient(DB, patient_id) {
  if (!patient_id) throw new InputError("patient_id_required");
  const row = await DB.prepare("SELECT 1 AS ok FROM patients WHERE id=?").bind(patient_id).first();
  if (!row) throw new InputError("patient_not_found");
}

async function callTool(name, args, env) {
  await ensureTablesCached(env);
  const DB = env.DB;

  if (name === "add_patient") {
    if (!args.name) throw new InputError("name_required");
    const id = newId("pat");
    await DB.prepare("INSERT INTO patients (id,name,relationship,dob,notes) VALUES (?,?,?,?,?)")
      .bind(id, args.name, args.relationship || null, args.dob || null, args.notes || null).run();
    return { id };
  }
  if (name === "list_patients") {
    const r = await DB.prepare("SELECT * FROM patients ORDER BY created_at").all();
    return { patients: r.results };
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
      `SELECT vaccine_name, dose_number, total_doses, next_due_at FROM vaccinations WHERE next_due_at IS NOT NULL`
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
  throw new Error(`unknown tool: ${name}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      await ensureTablesCached(env);
      return Response.json({ ok: true, service: "abot-health" });
    }
    // 内部鉴权：只接受网关的 X-Internal-Token，且必须携带网关注入的 owner 邮箱
    if (url.pathname === "/mcp") {
      const it = request.headers.get("X-Internal-Token") || "";
      if (!env.INTERNAL_TOKEN || !safeEqual(it, env.INTERNAL_TOKEN)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const ownerEmail = request.headers.get("X-Abot-Owner-Email") || "";
      if (!ownerEmail) {
        return Response.json({ error: "owner email required" }, { status: 401 });
      }
      // 单家庭模式：若配置了 OWNER_EMAIL，必须匹配，防止直连绕过网关身份
      if (env.OWNER_EMAIL && ownerEmail !== env.OWNER_EMAIL) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const msg = await request.json();
      const id = msg.id ?? null;
      try {
        if (msg.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id, result: {
            protocolVersion: "2025-06-18", capabilities: { tools: {} },
            serverInfo: { name: "abot-health-mcp", version: "1.0.1" } } });
        }
        if (msg.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
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
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
