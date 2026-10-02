// abot-health 安全审计测试：node test/basic.js
// 静态安全断言 + 内存 fake D1 功能测试
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error("FAIL:", name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ---------- 静态安全断言 ----------
ok(!src.includes("Math.random"), "static: no Math.random (predictable ids)");
ok(src.includes("crypto.getRandomValues"), "static: crypto.getRandomValues ids");
ok(!/\$\{args/.test(src), "static: no ${args...} SQL interpolation");
ok(src.includes("X-Abot-Owner-Email"), "static: owner email enforced");
ok(src.includes('"internal_error"'), "static: sanitized internal error");
ok(!/message: e\.message/.test(src.replace(/e instanceof InputError[\s\S]{0,120}/, "")),
  "static: no raw e.message leak in generic catch");
ok(src.includes("safeEqual"), "static: constant-time token compare");

// ---------- 内存 fake D1 ----------
function fakeD1() {
  const tables = { patients: [], visits: [], prescriptions: [], lab_reports: [], lab_report_files: [], vaccinations: [] };
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const stripWhere11 = (w) => w.replace(/^1\s*=\s*1\s*(AND\s+)?/i, "").replace(/\s+AND\s+1\s*=\s*1/i, "").trim();

  function matchConds(row, where, params) {
    if (!where) return true;
    const conds = stripWhere11(where).split(/\s+AND\s+/i).filter(Boolean);
    let pi = 0;
    for (const c of conds) {
      let m = c.match(/^([\w.]+)\s*=\s*\?$/);
      if (m) {
        const col = m[1].includes(".") ? m[1].split(".")[1] : m[1];
        if (String(row[col]) !== String(params[pi++])) return false;
        continue;
      }
      m = c.match(/^([\w.]+)\s*=\s*'([^']*)'$/);
      if (m) {
        const col = m[1].includes(".") ? m[1].split(".")[1] : m[1];
        if (String(row[col]) !== m[2]) return false;
        continue;
      }
      m = c.match(/^([\w.]+)\s+IS\s+NOT\s+NULL$/i);
      if (m) {
        const col = m[1].includes(".") ? m[1].split(".")[1] : m[1];
        if (row[col] === null || row[col] === undefined) return false;
        continue;
      }
      m = c.match(/^date\(([\w.]+)\)\s*>=\s*date\('now'\)$/i);
      if (m) {
        const col = m[1].includes(".") ? m[1].split(".")[1] : m[1];
        const today = new Date().toISOString().slice(0, 10);
        const val = row[col];
        if (val === null || val === undefined || String(val).slice(0, 10) < today) return false;
        continue;
      }
      throw new Error("fakeD1: unsupported cond: " + c);
    }
    return true;
  }

  function project(row, cols) {
    if (cols === "*") return { ...row };
    if (cols === "v.*") return { ...row };
    if (/^1\s+AS\s+ok$/i.test(cols)) return { ok: 1 };
    const out = {};
    for (const c of cols.split(",")) {
      const m = c.trim().match(/^(?:\w+\.)?(\w+)(?:\s+as\s+(\w+))?$/i);
      out[m[2] || m[1]] = row[m[1]];
    }
    return out;
  }

  function doSelect(sql, params) {
    const q = norm(sql);
    // PRAGMA table_info：模拟老库（没有 phone/email 列），让迁移逻辑走 ALTER
    let pm = q.match(/^PRAGMA table_info\((\w+)\)$/i);
    if (pm) {
      const base = {
        patients: ["id", "name", "relationship", "dob", "notes", "created_at"],
      }[pm[1]] || [];
      return base.map((name) => ({ name }));
    }
    // upcoming_vaccinations 的 JOIN 查询单独处理
    if (/JOIN patients/i.test(q)) {
      const days = Number(params[0]) || 30;
      const today = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      return tables.vaccinations
        .filter((v) => v.next_due_at && String(v.next_due_at).slice(0, 10) >= today && String(v.next_due_at).slice(0, 10) <= cutoff)
        .map((v) => {
          const p = tables.patients.find((x) => x.id === v.patient_id) || {};
          return { ...v, patient_name: p.name };
        })
        .sort((a, b) => String(a.next_due_at).localeCompare(String(b.next_due_at)));
    }
    const m = q.match(/^SELECT (.+) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/i);
    if (!m) throw new Error("fakeD1: unsupported select: " + q);
    const [, cols, table, where, orderBy, limit] = m;
    let rows = tables[table].filter((r) => matchConds(r, where, params));
    if (orderBy) {
      const om = orderBy.match(/^([\w.]+)(?:\s+(DESC))?$/i);
      const col = om[1].includes(".") ? om[1].split(".")[1] : om[1];
      const desc = !!om[2];
      rows = [...rows].sort((a, b) => {
        const c = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
        return desc ? -c : c;
      });
    }
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map((r) => project(r, cols));
  }

  return {
    prepare(sql) {
      const stmt = (params) => ({
        async run() {
          if (/^CREATE TABLE/i.test(norm(sql))) return {};
          if (/^ALTER TABLE/i.test(norm(sql))) return {};
          let m = norm(sql).match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i);
          if (m) {
            const cols = m[2].split(",").map((s) => s.trim());
            const row = {};
            cols.forEach((c, i) => { row[c] = params[i]; });
            tables[m[1]].push(row);
            return { meta: { changes: 1 } };
          }
          m = norm(sql).match(/^UPDATE (\w+) SET (.+) WHERE id=\?$/i);
          if (m) {
            const sets = m[2].split(",").map((s) => s.trim().match(/^(\w+)=\?$/)[1]);
            const id = params[params.length - 1];
            const row = tables[m[1]].find((r) => r.id === id);
            if (!row) return { meta: { changes: 0 } };
            sets.forEach((c, i) => { row[c] = params[i]; });
            return { meta: { changes: 1 } };
          }
          throw new Error("fakeD1: unsupported run: " + norm(sql));
        },
        async all() { return { results: doSelect(sql, params) }; },
        async first() {
          const rows = doSelect(sql, params);
          return rows[0] ?? null;
        },
      });
      return { ...stmt([]), bind(...params) { return stmt(params); } };
    },
    __tables: tables,
  };
}

// ---------- 功能测试 ----------
const TOKEN = "internal-test-token";
const EMAIL = "eric@abot.run";
function fakeR2() {
  const objects = new Map();
  return {
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
      objects.set(key, { bytes, options });
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        size: obj.bytes.byteLength,
        httpMetadata: obj.options && obj.options.httpMetadata,
        async arrayBuffer() {
          return obj.bytes.buffer.slice(obj.bytes.byteOffset, obj.bytes.byteOffset + obj.bytes.byteLength);
        },
      };
    },
    async delete(key) { objects.delete(key); },
    __objects: objects,
  };
}
function mcpEnv(extra = {}) {
  return { DB: fakeD1(), FILES: fakeR2(), INTERNAL_TOKEN: TOKEN, ...extra };
}
function postRpc(env, body, headers = {}) {
  const h = { "X-Internal-Token": TOKEN, "X-Abot-Owner-Email": EMAIL, ...headers };
  return worker.fetch(
    new Request("https://health.abot.run/mcp", {
      method: "POST", headers: { "content-type": "application/json", ...h },
      body: JSON.stringify(body),
    }),
    env,
  );
}
async function call(env, name, args, headers) {
  const r = await postRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
  const j = await r.json();
  if (j.error) return { __error: j.error };
  return JSON.parse(j.result.content[0].text);
}

const env = mcpEnv();

// 鉴权
{
  const r1 = await postRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Internal-Token": "wrong" });
  eq(r1.status, 401, "auth: wrong internal token -> 401");
  const r2 = await postRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Abot-Owner-Email": "" });
  eq(r2.status, 401, "auth: missing owner email -> 401");
  const r3 = await postRpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  eq(r3.status, 200, "auth: valid token + email -> 200");
  const tools = (await r3.json()).result.tools;
  eq(tools.length, 30, "tools/list: 30 tools");
  for (const name of ["upload_lab_report_file", "get_lab_report_file", "list_lab_report_files"]) {
    ok(tools.some((t) => t.name === name), `tools/list includes ${name}`);
  }
  // OWNER_EMAIL allowlist
  const env2 = mcpEnv({ OWNER_EMAIL: "owner@example.com" });
  const r4 = await postRpc(env2, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  eq(r4.status, 401, "auth: OWNER_EMAIL mismatch -> 401");
  const r5 = await postRpc(env2, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Abot-Owner-Email": "owner@example.com" });
  eq(r5.status, 200, "auth: OWNER_EMAIL match -> 200");
}

// 病人校验
const p = await call(env, "add_patient", { name: "本人" });
ok(p.id && p.id.startsWith("pat_"), "add_patient returns pat_ id");
const p2 = await call(env, "add_patient", { name: "父亲" });
ok(p2.id !== p.id, "ids unique (crypto random)");

const vBad = await call(env, "add_visit", { patient_id: "nope", visit_date: "2026-10-01" });
eq(vBad.__error && vBad.__error.code, -32602, "add_visit bogus patient -> -32602");
eq(vBad.__error && vBad.__error.message, "patient_not_found", "add_visit bogus patient message");
const vNoPid = await call(env, "add_visit", { visit_date: "2026-10-01" });
eq(vNoPid.__error && vNoPid.__error.message, "patient_id_required", "add_visit missing patient_id");
const v = await call(env, "add_visit", { patient_id: p.id, visit_date: "2026-09-26", diagnosis: "咽炎" });
ok(v.id && v.id.startsWith("visit_"), "add_visit valid ok");

const rxBad = await call(env, "add_prescription", { patient_id: "nope", drug_name: "药" });
eq(rxBad.__error && rxBad.__error.code, -32602, "add_prescription bogus patient -> -32602");
const rx = await call(env, "add_prescription", { patient_id: p.id, drug_name: "氨苄西林" });
ok(rx.id.startsWith("rx_"), "add_prescription valid ok");
const upBad = await call(env, "update_prescription", { id: "rx_nope", status: "finished" });
eq(upBad.__error && upBad.__error.message, "prescription_not_found", "update_prescription bogus id");
const up = await call(env, "update_prescription", { id: rx.id, status: "finished" });
eq(up.ok, true, "update_prescription valid ok");

const labBad = await call(env, "add_lab_report", { patient_id: "nope", report_date: "2026-10-01" });
eq(labBad.__error && labBad.__error.code, -32602, "add_lab_report bogus patient -> -32602");
const vaxBad = await call(env, "add_vaccination", { patient_id: "nope", vaccine_name: "狂犬" });
eq(vaxBad.__error && vaxBad.__error.code, -32602, "add_vaccination bogus patient -> -32602");
const vax = await call(env, "add_vaccination", { patient_id: p.id, vaccine_name: "狂犬疫苗", dose_number: 1, next_due_at: "2026-10-07" });
ok(vax.id.startsWith("vax_"), "add_vaccination valid ok");

const sum = await call(env, "health_summary", { patient_id: p.id });
eq(sum.active_medications.length, 0, "health_summary: finished rx not active");
const sumBad = await call(env, "health_summary", { patient_id: "nope" });
eq(sumBad.__error && sumBad.__error.message, "patient_not_found", "health_summary bogus patient");

const up2 = await call(env, "upcoming_vaccinations", { days: 30 });
eq(up2.vaccinations.length, 1, "upcoming_vaccinations finds due vaccine");
eq(up2.vaccinations[0].patient_name, "本人", "upcoming_vaccinations joins patient name");
await call(env, "add_vaccination", { patient_id: p.id, vaccine_name: "过期苗", next_due_at: "2020-01-01" });
const upPast = await call(env, "upcoming_vaccinations", { days: 30 });
eq(upPast.vaccinations.length, 1, "upcoming_vaccinations skips overdue");
eq(upPast.vaccinations[0].vaccine_name, "狂犬疫苗", "upcoming keeps the future dose");

const vP2 = await call(env, "add_visit", { patient_id: p2.id, visit_date: "2026-01-01" });
const cross = await call(env, "add_prescription", { patient_id: p.id, visit_id: vP2.id, drug_name: "串方" });
eq(cross.__error && cross.__error.message, "visit_not_found", "add_prescription other patient's visit");
const missingVisit = await call(env, "add_prescription", { patient_id: p.id, visit_id: "visit_missing", drug_name: "无就诊" });
eq(missingVisit.__error && missingVisit.__error.message, "visit_not_found", "add_prescription missing visit");

// 错误信息不泄漏
{
  const badEnv = mcpEnv();
  badEnv.DB = { prepare() { throw new Error("D1 exploded: host=secret.internal table=creds"); } };
  const r = await postRpc(badEnv, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_patients", arguments: {} } });
  const j = await r.json();
  eq(j.error && j.error.code, -32603, "internal error code -32603");
  eq(j.error && j.error.message, "internal_error", "internal error sanitized");
  ok(!(j.error && j.error.message || "").includes("secret"), "no leak in message");
}

// initialize
{
  const r = await postRpc(env, { jsonrpc: "2.0", id: 2, method: "initialize" });
  const j = await r.json();
  eq(j.result.serverInfo.version, "1.1.0", "initialize version");
}

ok(!src.includes("家庭成员"), "static: patients are not family-only");
ok(!src.includes("单家庭"), "static: no single-family mode");
ok(src.includes("MAX_FILE_BYTES = 10 * 1024 * 1024"), "static: 10MB file cap");
ok(src.includes("lab_report_files"), "static: file metadata table");
ok(src.includes("env.FILES"), "static: R2 binding FILES");

// ---------- 通用病人（不限家人）----------
{
  const friend = await call(env, "add_patient", { name: "周同事", relationship: "同事", notes: "外院会诊" });
  ok(friend.id.startsWith("pat_"), "add non-family patient");
  const anon = await call(env, "add_patient", { name: "未填关系" });
  const listed = await call(env, "list_patients", {});
  const friendRow = listed.patients.find((x) => x.id === friend.id);
  const anonRow = listed.patients.find((x) => x.id === anon.id);
  eq(friendRow.relationship, "同事", "optional relationship stored");
  eq(friendRow.notes, "外院会诊", "optional notes stored");
  eq(anonRow.relationship, null, "relationship may be omitted");
  eq(anonRow.notes, null, "notes may be omitted");
  const fv = await call(env, "add_visit", { patient_id: friend.id, visit_date: "2026-10-02", diagnosis: "复诊" });
  ok(fv.id.startsWith("visit_"), "visit for non-family patient");
  const onlyFriend = await call(env, "list_visits", { patient_id: friend.id });
  eq(onlyFriend.visits.length, 1, "visits stay isolated by patient_id");
  ok(onlyFriend.visits.every((row) => row.patient_id === friend.id), "listed visits belong to that patient");
}

// ---------- 病人联系方式（phone/email）----------
{
  const c = await call(env, "add_patient", { name: "联系人", phone: "13800001111", email: "a@b.com" });
  ok(c.id.startsWith("pat_"), "add_patient with phone/email");
  const listed = await call(env, "list_patients", {});
  const row = listed.patients.find((x) => x.id === c.id);
  eq(row.phone, "13800001111", "phone stored and listed");
  eq(row.email, "a@b.com", "email stored and listed");
  const up = await call(env, "update_patient", { patient_id: c.id, phone: "13900002222" });
  eq(up.ok, true, "update_patient ok");
  const listed2 = await call(env, "list_patients", {});
  const row2 = listed2.patients.find((x) => x.id === c.id);
  eq(row2.phone, "13900002222", "phone updated");
  eq(row2.email, "a@b.com", "email unchanged after partial update");
  const upBad = await call(env, "update_patient", { patient_id: "pat_nope", phone: "1" });
  eq(upBad.__error && upBad.__error.message, "patient_not_found", "update_patient bogus id -> patient_not_found");
  const upEmpty = await call(env, "update_patient", { patient_id: c.id });
  eq(upEmpty.__error && upEmpty.__error.message, "nothing_to_update", "update_patient no fields -> nothing_to_update");
}

// ---------- 检查报告附件：上传 / 下载 / 隔离 ----------
{
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngB64 = png.toString("base64");
  const pdfB64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const webp = Buffer.alloc(12);
  webp.write("RIFF");
  webp.writeUInt32LE(4, 4);
  webp.write("WEBP", 8);
  const webpB64 = webp.toString("base64");

  const owner = await call(env, "add_patient", { name: "甲", notes: "门诊" });
  const other = await call(env, "add_patient", { name: "乙", relationship: "朋友" });
  const lab = await call(env, "add_lab_report", {
    patient_id: owner.id, report_date: "2026-10-01", report_type: "血常规", summary: "正常",
  });
  const otherLab = await call(env, "add_lab_report", {
    patient_id: other.id, report_date: "2026-10-01", report_type: "处方",
  });

  const missingPatient = await call(env, "upload_lab_report_file", {
    patient_id: "nope", filename: "a.png", content_base64: pngB64,
  });
  eq(missingPatient.__error && missingPatient.__error.message, "patient_not_found", "upload bogus patient");

  const crossLab = await call(env, "upload_lab_report_file", {
    patient_id: other.id, lab_report_id: lab.id, filename: "a.png", content_base64: pngB64,
  });
  eq(crossLab.__error && crossLab.__error.message, "lab_report_not_found", "cannot attach another patient's report");

  const badType = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, filename: "notes.txt", content_base64: Buffer.from("hello").toString("base64"),
  });
  eq(badType.__error && badType.__error.message, "unsupported_file_type", "reject non image/pdf");

  const mismatch = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, filename: "photo.jpg", content_base64: pngB64,
  });
  eq(mismatch.__error && mismatch.__error.message, "file_type_mismatch", "reject mismatched magic bytes");

  const badB64 = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, filename: "a.png", content_base64: "@@@not-base64",
  });
  eq(badB64.__error && badB64.__error.message, "invalid_base64", "reject invalid base64");

  const tooBig = "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4);
  const big = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, filename: "big.png", content_base64: tooBig,
  });
  eq(big.__error && big.__error.message, "file_too_large", "reject over 10MB");

  const uploaded = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, lab_report_id: lab.id, filename: "../../血常规.png", content_base64: pngB64,
  });
  ok(uploaded.file_id && uploaded.file_id.startsWith("file_"), "upload returns file_id");

  const pdf = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, filename: "处方.pdf", content_base64: pdfB64,
  });
  ok(pdf.file_id.startsWith("file_"), "upload pdf");
  const jpeg = await call(env, "upload_lab_report_file", {
    patient_id: owner.id, lab_report_id: lab.id, filename: "scan.jpeg", content_base64: jpegB64,
  });
  ok(jpeg.file_id.startsWith("file_"), "upload jpeg");
  const webpUp = await call(env, "upload_lab_report_file", {
    patient_id: other.id, lab_report_id: otherLab.id, filename: "x.webp", content_base64: webpB64,
  });
  ok(webpUp.file_id.startsWith("file_"), "upload webp for other patient");

  const meta = env.DB.__tables.lab_report_files.find((row) => row.id === uploaded.file_id);
  eq(meta.filename, "血常规.png", "metadata keeps basename only");
  eq(meta.mime, "image/png", "metadata mime");
  eq(meta.size, png.length, "metadata size");
  eq(meta.patient_id, owner.id, "metadata patient");
  eq(meta.lab_report_id, lab.id, "metadata linked report");
  ok(meta.r2_key === `patients/${owner.id}/lab-files/${uploaded.file_id}`, "r2 key scoped to patient");
  ok(env.FILES.__objects.has(meta.r2_key), "object stored in R2");

  const got = await call(env, "get_lab_report_file", { patient_id: owner.id, file_id: uploaded.file_id });
  eq(got.content_base64, pngB64, "download returns original bytes");
  eq(got.filename, "血常规.png", "download filename");
  eq(got.mime, "image/png", "download mime");
  eq(got.lab_report_id, lab.id, "download keeps report link");

  const stolen = await call(env, "get_lab_report_file", { patient_id: other.id, file_id: uploaded.file_id });
  eq(stolen.__error && stolen.__error.code, -32602, "cross-patient download rejected");
  eq(stolen.__error && stolen.__error.message, "file_not_found", "cross-patient download is file_not_found");
  const noPid = await call(env, "get_lab_report_file", { file_id: uploaded.file_id });
  eq(noPid.__error && noPid.__error.message, "patient_id_required", "download requires patient_id");
  const missingFile = await call(env, "get_lab_report_file", { patient_id: owner.id, file_id: "file_missing" });
  eq(missingFile.__error && missingFile.__error.message, "file_not_found", "unknown file_id");

  const listOther = await call(env, "list_lab_report_files", { patient_id: other.id });
  eq(listOther.files.length, 1, "other patient sees only own file");
  eq(listOther.files[0].file_id, webpUp.file_id, "other patient's file id");
  ok(!listOther.files.some((row) => row.file_id === uploaded.file_id), "list does not leak other patient's files");
  ok(!("r2_key" in listOther.files[0]), "list omits r2 key");
  ok(!("content_base64" in listOther.files[0]), "list omits file bytes");

  const listOwner = await call(env, "list_lab_report_files", { patient_id: owner.id, lab_report_id: lab.id });
  eq(listOwner.files.length, 2, "filter files by lab report");
  ok(listOwner.files.every((row) => row.lab_report_id === lab.id && row.patient_id === owner.id), "filtered files stay on that report");
  const listAllOwner = await call(env, "list_lab_report_files", { patient_id: owner.id });
  eq(listAllOwner.files.length, 3, "owner has png, pdf, jpeg");

  const listMissing = await call(env, "list_lab_report_files", {});
  eq(listMissing.__error && listMissing.__error.message, "patient_id_required", "list requires patient_id");
}

// ---------- 病人头像：上传 / 校验 / 覆盖 ----------
{
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngB64 = png.toString("base64");
  const pdfB64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

  const p1 = await call(env, "add_patient", { name: "头像甲" });
  const p2 = await call(env, "add_patient", { name: "头像乙" });

  const noPatient = await call(env, "upload_patient_avatar", {
    patient_id: "nope", filename: "a.png", content_base64: pngB64,
  });
  eq(noPatient.__error && noPatient.__error.message, "patient_not_found", "avatar requires patient");

  const badType = await call(env, "upload_patient_avatar", {
    patient_id: p1.id, filename: "doc.pdf", content_base64: pdfB64,
  });
  eq(badType.__error && badType.__error.message, "unsupported_file_type", "avatar rejects pdf");

  const mismatch = await call(env, "upload_patient_avatar", {
    patient_id: p1.id, filename: "fake.png", content_base64: jpegB64,
  });
  eq(mismatch.__error && mismatch.__error.message, "file_type_mismatch", "avatar rejects content mismatch");

  const tooBig = "A".repeat(Math.ceil((2 * 1024 * 1024 + 1) / 3) * 4);
  const big = await call(env, "upload_patient_avatar", {
    patient_id: p1.id, filename: "big.png", content_base64: tooBig,
  });
  eq(big.__error && big.__error.message, "file_too_large", "avatar rejects over 2MB");

  const up1 = await call(env, "upload_patient_avatar", {
    patient_id: p1.id, filename: "头像.png", content_base64: pngB64,
  });
  ok(up1.ok === true, "avatar upload ok");
  eq(up1.r2_key, `avatars/${p1.id}.png`, "avatar r2 key path");
  ok(env.FILES.__objects.has(`avatars/${p1.id}.png`), "avatar stored in R2");

  const listed = await call(env, "list_patients", {});
  const row1 = listed.patients.find((r) => r.id === p1.id);
  eq(row1.avatar_r2_key, `avatars/${p1.id}.png`, "list_patients exposes avatar_r2_key");
  const row2 = listed.patients.find((r) => r.id === p2.id);
  ok(!row2.avatar_r2_key, "patient without avatar has empty avatar_r2_key");

  // 更换头像（不同扩展名）：旧文件被清理
  const up2 = await call(env, "upload_patient_avatar", {
    patient_id: p1.id, filename: "new.jpg", content_base64: jpegB64,
  });
  ok(up2.ok === true, "avatar replace ok");
  eq(up2.r2_key, `avatars/${p1.id}.jpg`, "avatar key follows new ext");
  ok(!env.FILES.__objects.has(`avatars/${p1.id}.png`), "old avatar object cleaned");
  ok(env.FILES.__objects.has(`avatars/${p1.id}.jpg`), "new avatar object stored");
  const listed2 = await call(env, "list_patients", {});
  eq(listed2.patients.find((r) => r.id === p1.id).avatar_r2_key, `avatars/${p1.id}.jpg`, "avatar_r2_key updated");
}

// R2 已写入但 D1 失败时回滚对象，且错误不泄漏
{
  const envFail = mcpEnv();
  const who = await call(envFail, "add_patient", { name: "回滚" });
  const orig = envFail.DB.prepare.bind(envFail.DB);
  envFail.DB.prepare = (sql) => {
    const prepared = orig(sql);
    if (!/INSERT INTO lab_report_files/i.test(sql)) return prepared;
    return { bind() { return { async run() { throw new Error("d1 insert failed: secret-bucket"); } }; } };
  };
  const pngB64 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");
  const failed = await call(envFail, "upload_lab_report_file", {
    patient_id: who.id, filename: "a.png", content_base64: pngB64,
  });
  eq(failed.__error && failed.__error.code, -32603, "d1 failure is internal_error");
  eq(failed.__error && failed.__error.message, "internal_error", "d1 failure sanitized");
  ok(!(failed.__error && failed.__error.message || "").includes("secret"), "no secret in upload failure");
  eq(envFail.FILES.__objects.size, 0, "R2 object rolled back when metadata insert fails");
}

// 畸形 JSON 不能把异常栈返回给调用方
{
  const r = await worker.fetch(new Request("https://health.abot.run/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Internal-Token": TOKEN, "X-Abot-Owner-Email": EMAIL },
    body: "{",
  }), env);
  eq(r.status, 400, "invalid json -> 400");
  const j = await r.json();
  eq(j.error && j.error.code, -32700, "invalid json code");
  eq(j.error && j.error.message, "parse_error", "invalid json message");
  ok(!JSON.stringify(j).includes("SyntaxError"), "invalid json hides SyntaxError");
  const r2 = await worker.fetch(new Request("https://health.abot.run/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Internal-Token": TOKEN, "X-Abot-Owner-Email": EMAIL },
    body: "null",
  }), env);
  const j2 = await r2.json();
  eq(r2.status, 400, "json null -> 400");
  eq(j2.error && j2.error.message, "invalid_request", "json null message");
  ok(!JSON.stringify(j2).includes("TypeError"), "json null hides TypeError");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
