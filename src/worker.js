/**
 * abot-health v1 — 个人健康数据服务
 * 病历/处方/体检/疫苗，MCP 给 agent 用
 */

function newId(prefix) {
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${r}`;
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

async function callTool(name, args, env) {
  await ensureTables(env);
  const DB = env.DB;

  if (name === "add_patient") {
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
    const sets = [], params = [];
    if (args.status !== undefined) { sets.push("status=?"); params.push(args.status); }
    if (args.end_date !== undefined) { sets.push("end_date=?"); params.push(args.end_date); }
    if (!sets.length) return { ok: false, error: "nothing to update" };
    params.push(args.id);
    await DB.prepare(`UPDATE prescriptions SET ${sets.join(",")} WHERE id=?`).bind(...params).run();
    return { ok: true };
  }
  if (name === "add_lab_report") {
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
    const id = newId("vax");
    await DB.prepare(`INSERT INTO vaccinations (id,patient_id,vaccine_name,dose_number,total_doses,vaccinated_at,next_due_at)
      VALUES (?,?,?,?,?,?,?)`).bind(id, args.patient_id, args.vaccine_name,
      args.dose_number || null, args.total_doses || null,
      args.vaccinated_at || null, args.next_due_at || null).run();
    return { id };
  }
  if (name === "upcoming_vaccinations") {
    const days = args.days || 30;
    const r = await DB.prepare(`SELECT v.*, p.name as patient_name FROM vaccinations v
      JOIN patients p ON v.patient_id = p.id
      WHERE v.next_due_at IS NOT NULL
      AND date(v.next_due_at) <= date('now', '+' || ? || ' days')
      ORDER BY v.next_due_at`).bind(days).all();
    return { vaccinations: r.results };
  }
  if (name === "health_summary") {
    const pid = args.patient_id;
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
      await ensureTables(env);
      return Response.json({ ok: true, service: "abot-health" });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const msg = await request.json();
      const id = msg.id ?? null;
      try {
        if (msg.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id, result: {
            protocolVersion: "2025-06-18", capabilities: { tools: {} },
            serverInfo: { name: "abot-health-mcp", version: "1.0.0" } } });
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
          const result = await callTool(name, args || {}, env);
          return Response.json({ jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: JSON.stringify(result) }] } } });
        }
        return Response.json({ jsonrpc: "2.0", id,
          error: { code: -32601, message: "Method not found" } });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id,
          error: { code: -32603, message: e.message } });
      }
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
