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
  const tables = { patients: [], visits: [], prescriptions: [], lab_reports: [], vaccinations: [] };
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
    // upcoming_vaccinations 的 JOIN 查询单独处理
    if (/JOIN patients/i.test(q)) {
      const days = Number(params[0]) || 30;
      const cutoff = new Date(Date.now() + days * 86400000);
      return tables.vaccinations
        .filter((v) => v.next_due_at && new Date(v.next_due_at) <= cutoff)
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
function mcpEnv(extra = {}) {
  return { DB: fakeD1(), INTERNAL_TOKEN: TOKEN, ...extra };
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
  eq(tools.length, 12, "tools/list: 12 tools");
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
  eq(j.result.serverInfo.version, "1.0.1", "initialize version");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
