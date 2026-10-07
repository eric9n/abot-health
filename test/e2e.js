// abot-health e2e：wrangler dev（workerd + 本地 D1）打真实 /mcp
// 跑法：node test/e2e.js
import { unstable_dev } from "wrangler";
import { fileURLToPath } from "node:url";

const EMAIL = "eric@abot.run";
const config = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
    console.error("FAIL:", name);
  }
}
function eq(a, b, name) {
  const same = a === b;
  ok(same, same ? name : `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const LEAK_RE = /\/workspace|\.wrangler|worker\.js|SyntaxError|TypeError|D1_|sqlite|SELECT |INSERT |UPDATE |stack|internal-test-token|secret\.internal/i;
function noLeak(text, name) {
  const s = String(text);
  ok(!LEAK_RE.test(s), `${name}: no internal details (body ${s.slice(0, 240)})`);
}

function utcDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

let worker;
function authHeaders(extra = {}, { email = true } = {}) {
  const h = { "content-type": "application/json" };
  if (email) h["X-Abot-Owner-Email"] = EMAIL;
  return { ...h, ...extra };
}

async function raw(path, { method = "GET", headers = {}, body } = {}) {
  const res = await worker.fetch("https://health.abot.run" + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, text, json };
}

async function rpc(body, headers = authHeaders(), { rawBody = false } = {}) {
  return raw("/mcp", {
    method: "POST",
    headers,
    body: rawBody ? body : JSON.stringify(body),
  });
}

async function call(name, args, headers) {
  const r = await rpc({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  }, headers);
  if (!r.json) return { __status: r.status, __text: r.text, __error: { message: "non_json" } };
  if (r.json.error) return { __status: r.status, __text: r.text, __error: r.json.error };
  const text = r.json.result && r.json.result.content && r.json.result.content[0] && r.json.result.content[0].text;
  return { __status: r.status, __text: r.text, ...(text ? JSON.parse(text) : {}) };
}

function toolErr(res, code, message, name) {
  eq(res.__status, 200, `${name} http 200`);
  eq(res.__error && res.__error.code, code, `${name} code`);
  eq(res.__error && res.__error.message, message, `${name} message`);
  noLeak(res.__text, name);
}

async function main() {
  worker = await unstable_dev("src/worker.js", {
    config,
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    vars: { OWNER_EMAIL: EMAIL },
    local: true,
    persist: false,
    logLevel: "error",
    ip: "127.0.0.1",
    port: 8791,
  });

  // ---------- 探活 / 未授权 ----------
  {
    const h = await raw("/health");
    eq(h.status, 200, "GET /health no auth -> 200");
    eq(h.json && h.json.ok, true, "health ok");
    eq(h.json && h.json.service, "abot-health", "health service");
    noLeak(h.text, "health body");

    const missing = await raw("/no-such");
    eq(missing.status, 404, "unknown path -> 404");
    eq(missing.json && missing.json.error, "not found", "404 message");
    noLeak(missing.text, "404 body");

    const withEmail = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    eq(withEmail.status, 200, "email only -> 200");
    ok(withEmail.json && withEmail.json.result && Array.isArray(withEmail.json.result.tools), "email only lists tools");
    noLeak(withEmail.text, "email only body");

    const ignoredTok = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authHeaders({ "X-Internal-Token": "internal-test-token-WRONG" }),
    );
    eq(ignoredTok.status, 200, "X-Internal-Token is ignored");
    noLeak(ignoredTok.text, "ignored token body");

    const noEmail = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "content-type": "application/json" },
    );
    eq(noEmail.status, 401, "no X-Abot-Owner-Email -> 401");
    eq(noEmail.json && noEmail.json.error, "owner email required", "missing email message");
    noLeak(noEmail.text, "missing email body");

    const emptyEmail = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authHeaders({ "X-Abot-Owner-Email": "" }),
    );
    eq(emptyEmail.status, 401, "empty X-Abot-Owner-Email -> 401");

    const wrongEmail = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authHeaders({ "X-Abot-Owner-Email": "other@example.com" }),
    );
    eq(wrongEmail.status, 401, "OWNER_EMAIL mismatch -> 401");
    eq(wrongEmail.json && wrongEmail.json.error, "unauthorized", "mismatch message");
    noLeak(wrongEmail.text, "mismatch body");

    const getMcp = await raw("/mcp");
    eq(getMcp.status, 401, "GET /mcp without auth -> 401");

    const listed = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    eq(listed.status, 200, "email only tools/list -> 200");
    const names = (listed.json.result.tools || []).map((t) => t.name);
    eq(names.length, 35, "tools/list count");
    for (const n of [
      "add_patient", "list_patients", "add_visit", "list_visits",
      "add_prescription", "list_prescriptions", "update_prescription",
      "add_lab_report", "list_lab_reports", "add_vaccination",
      "list_vaccinations", "update_vaccination",
      "health_summary",
      "list_insurance", "add_insurance", "update_insurance", "delete_insurance",
    ]) ok(names.includes(n), `tool present: ${n}`);
    ok(!names.includes("upcoming_vaccinations"), "upcoming_vaccinations removed");

    const lower = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "content-type": "application/json", "x-abot-owner-email": EMAIL },
    );
    eq(lower.status, 200, "header names are case-insensitive");

    const init = await rpc({ jsonrpc: "2.0", id: "init-1", method: "initialize" });
    eq(init.status, 200, "initialize 200");
    eq(init.json.result.serverInfo.name, "abot-health-mcp", "server name");
    eq(init.json.result.protocolVersion, "2025-06-18", "protocol");
    eq(init.json.id, "init-1", "initialize echoes id");

    const initNo = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, authHeaders({}, { email: false }));
    eq(initNo.status, 401, "initialize without auth -> 401");
  }

  // ---------- 解析错误不泄漏 ----------
  {
    const bad = await rpc("{", authHeaders(), { rawBody: true });
    eq(bad.status, 400, "invalid json -> 400");
    eq(bad.json && bad.json.error && bad.json.error.code, -32700, "invalid json code");
    eq(bad.json && bad.json.error && bad.json.error.message, "parse_error", "invalid json message");
    noLeak(bad.text, "invalid json body");

    const nul = await rpc("null", authHeaders(), { rawBody: true });
    eq(nul.status, 400, "json null -> 400");
    eq(nul.json && nul.json.error && nul.json.error.message, "invalid_request", "json null message");
    noLeak(nul.text, "json null body");

    const arr = await rpc("[]", authHeaders(), { rawBody: true });
    eq(arr.json && arr.json.error && arr.json.error.message, "invalid_request", "json array message");
    noLeak(arr.text, "json array body");

    const num = await rpc("1", authHeaders(), { rawBody: true });
    eq(num.json && num.json.error && num.json.error.message, "invalid_request", "json number message");
    noLeak(num.text, "json number body");

    const empty = await rpc("", authHeaders(), { rawBody: true });
    eq(empty.json && empty.json.error && empty.json.error.message, "parse_error", "empty body message");
    noLeak(empty.text, "empty body");
  }

  // ---------- 校验：病人必须存在，缺字段，未知工具 ----------
  {
    const noName = await call("add_patient", {});
    toolErr(noName, -32602, "name_required", "add_patient missing name");

    const vNo = await call("add_visit", { visit_date: "2026-01-01" });
    toolErr(vNo, -32602, "patient_id_required", "add_visit missing patient");
    const vBad = await call("add_visit", { patient_id: "pat_missing", visit_date: "2026-01-01" });
    toolErr(vBad, -32602, "patient_not_found", "add_visit unknown patient");

    const rxNo = await call("add_prescription", { drug_name: "药" });
    toolErr(rxNo, -32602, "patient_id_required", "add_prescription missing patient");
    const rxBad = await call("add_prescription", { patient_id: "pat_missing", drug_name: "药" });
    toolErr(rxBad, -32602, "patient_not_found", "add_prescription unknown patient");

    const labBad = await call("add_lab_report", { patient_id: "pat_missing", report_date: "2026-01-01" });
    toolErr(labBad, -32602, "patient_not_found", "add_lab_report unknown patient");
    const labNoDate = await call("add_lab_report", { patient_id: "pat_missing" });
    toolErr(labNoDate, -32602, "patient_not_found", "add_lab_report missing patient before date");

    const vaxBad = await call("add_vaccination", { patient_id: "pat_missing", vaccine_name: "流感" });
    toolErr(vaxBad, -32602, "patient_not_found", "add_vaccination unknown patient");

    const sumBad = await call("health_summary", { patient_id: "pat_missing" });
    toolErr(sumBad, -32602, "patient_not_found", "health_summary unknown patient");

    const upNo = await call("update_prescription", {});
    toolErr(upNo, -32602, "id_required", "update_prescription missing id");
    const upBad = await call("update_prescription", { id: "rx_does_not_exist", patient_id: "pat_missing", status: "finished" });
    toolErr(upBad, -32602, "patient_not_found", "update_prescription unknown patient");

    const weird = await call("add_visit", { patient_id: { bad: true }, visit_date: "2026-01-01" });
    eq(weird.__error && weird.__error.code, -32603, "non-string patient_id -> internal");
    eq(weird.__error && weird.__error.message, "internal_error", "non-string patient_id sanitized");
    noLeak(weird.__text, "d1 type error");

    const unk = await call("drop_table_patients", {});
    eq(unk.__error && unk.__error.code, -32601, "unknown tool code");
    noLeak(unk.__text, "unknown tool");
    const nope = await rpc({ jsonrpc: "2.0", id: 3, method: "nope" });
    eq(nope.json.error.code, -32601, "unknown method");
    eq(nope.json.error.message, "Method not found", "unknown method message");
    noLeak(nope.text, "unknown method body");
  }

  // ---------- 每个工具的正常流程 + 病人隔离 ----------
  const mark = Date.now().toString(36);
  const dueSoon = utcDate(5);
  const dueFar = utcDate(120);

  const a = await call("add_patient", {
    name: `本人_${mark}`, relationship: "本人", dob: "1990-01-02", notes: `备注A_${mark} "引号"`,
  });
  ok(a.id && a.id.startsWith("pat_"), "add_patient A id");
  const aMin = await call("add_patient", { name: `仅名字_${mark}` });
  ok(aMin.id && aMin.id !== a.id, "add_patient minimal distinct id");
  const b = await call("add_patient", {
    name: `父亲_${mark}`, relationship: "父亲", dob: "1960-05-06", notes: `备注B_${mark}`,
  });
  ok(b.id && b.id.startsWith("pat_") && b.id !== a.id, "add_patient B id");

  const patients = await call("list_patients", {});
  ok(Array.isArray(patients.patients), "list_patients array");
  const pa = patients.patients.find((p) => p.id === a.id);
  const pb = patients.patients.find((p) => p.id === b.id);
  const pmin = patients.patients.find((p) => p.id === aMin.id);
  eq(pa && pa.name, `本人_${mark}`, "list patient A name");
  eq(pa && pa.relationship, "本人", "list patient A relationship");
  eq(pa && pa.dob, "1990-01-02", "list patient A dob");
  eq(pa && pa.notes, `备注A_${mark} "引号"`, "list patient A notes");
  ok(pa && typeof pa.created_at === "string" && pa.created_at.includes("T"), "patient A created_at");
  eq(pb && pb.name, `父亲_${mark}`, "list patient B name");
  eq(pmin && pmin.relationship, null, "minimal patient null relationship");
  eq(pmin && pmin.notes, null, "minimal patient null notes");

  // 就诊：全字段 + 排序 + 隔离
  const vOld = await call("add_visit", {
    patient_id: a.id, visit_date: "2024-01-01", hospital: `医院A_${mark}`,
    department: "内科", complaint: `主诉A_${mark}`, diagnosis: `DX_A1_${mark}`, advice: `建议A_${mark}`,
  });
  ok(vOld.id && vOld.id.startsWith("visit_"), "add_visit id");
  await call("add_visit", { patient_id: a.id, visit_date: "2025-03-03", diagnosis: `DX_A2_${mark}` });
  await call("add_visit", { patient_id: a.id, visit_date: "2026-01-01", diagnosis: `DX_A3_${mark}` });
  await call("add_visit", { patient_id: a.id, visit_date: "2026-06-01", diagnosis: `DX_A4_${mark}` });
  const vB = await call("add_visit", {
    patient_id: b.id, visit_date: "2026-02-02", hospital: `医院B_${mark}`, diagnosis: `DX_B_${mark}`,
  });
  ok(vB.id && vB.id.startsWith("visit_"), "add_visit B id");

  const vNoDate = await call("add_visit", { patient_id: a.id });
  toolErr(vNoDate, -32602, "visit_date_required", "add_visit missing date");

  const visitsA = await call("list_visits", { patient_id: a.id });
  eq(visitsA.visits.length, 4, "list_visits A count");
  ok(visitsA.visits.every((v) => v.patient_id === a.id), "list_visits A only A");
  ok(!visitsA.visits.some((v) => String(v.diagnosis).includes(`DX_B_${mark}`)), "list_visits A hides B diagnosis");
  eq(visitsA.visits.map((v) => v.visit_date).join(","), "2026-06-01,2026-01-01,2025-03-03,2024-01-01", "list_visits A date desc");
  const fullV = visitsA.visits.find((v) => v.id === vOld.id);
  eq(fullV.hospital, `医院A_${mark}`, "visit hospital roundtrip");
  eq(fullV.department, "内科", "visit department roundtrip");
  eq(fullV.complaint, `主诉A_${mark}`, "visit complaint roundtrip");
  eq(fullV.advice, `建议A_${mark}`, "visit advice roundtrip");

  const visitsB = await call("list_visits", { patient_id: b.id });
  eq(visitsB.visits.length, 1, "list_visits B count");
  eq(visitsB.visits[0].diagnosis, `DX_B_${mark}`, "list_visits B diagnosis");
  ok(!visitsB.visits.some((v) => String(v.diagnosis).includes("DX_A")), "list_visits B hides A");

  const visitsInj = await call("list_visits", { patient_id: "' OR 1=1 --" });
  toolErr(visitsInj, -32602, "patient_not_found", "list_visits injection rejected");

  // 处方：关联本人就诊、拒绝跨病人 visit、状态更新不是假成功
  const rxActive = await call("add_prescription", {
    patient_id: a.id, visit_id: vOld.id, drug_name: `DRUG_A_ON_${mark}`,
    spec: "0.25g", usage: "tid", start_date: "2026-06-01",
  });
  ok(rxActive.id && rxActive.id.startsWith("rx_"), "add_prescription id");
  const rxDone = await call("add_prescription", {
    patient_id: a.id, drug_name: `DRUG_A_OFF_${mark}`, spec: "5mg",
  });
  const rxB = await call("add_prescription", {
    patient_id: b.id, visit_id: vB.id, drug_name: `DRUG_B_${mark}`, usage: "qd",
  });
  ok(rxB.id.startsWith("rx_"), "add_prescription B");

  const rxCross = await call("add_prescription", {
    patient_id: a.id, visit_id: vB.id, drug_name: `DRUG_CROSS_${mark}`,
  });
  toolErr(rxCross, -32602, "visit_not_found", "add_prescription other patient's visit");
  const rxMissingVisit = await call("add_prescription", {
    patient_id: a.id, visit_id: "visit_missing", drug_name: `DRUG_NOV_${mark}`,
  });
  toolErr(rxMissingVisit, -32602, "visit_not_found", "add_prescription missing visit");

  const rxNoDrug = await call("add_prescription", { patient_id: a.id });
  toolErr(rxNoDrug, -32602, "drug_name_required", "add_prescription missing drug");

  const beforeBadUp = await call("list_prescriptions", { patient_id: a.id });
  const upMissing = await call("update_prescription", { id: "rx_still_missing", patient_id: a.id, status: "finished", end_date: "2026-01-01" });
  toolErr(upMissing, -32602, "prescription_not_found", "update still errors after rows exist");
  const afterBadUp = await call("list_prescriptions", { patient_id: a.id });
  eq(afterBadUp.prescriptions.length, beforeBadUp.prescriptions.length, "failed update does not insert");
  ok(!afterBadUp.prescriptions.some((p) => p.drug_name === `DRUG_CROSS_${mark}`), "cross visit rx not stored");
  ok(!afterBadUp.prescriptions.some((p) => p.drug_name === `DRUG_NOV_${mark}`), "missing visit rx not stored");

  const nothing = await call("update_prescription", { id: rxDone.id, patient_id: a.id });
  toolErr(nothing, -32602, "nothing_to_update", "update_prescription empty patch");

  const rxListA0 = await call("list_prescriptions", { patient_id: a.id });
  const doneRow0 = rxListA0.prescriptions.find((p) => p.id === rxDone.id);
  eq(doneRow0.status, "active", "new prescription defaults to active");
  eq(doneRow0.end_date ?? null, null, "end_date null before update");

  const updated = await call("update_prescription", { id: rxDone.id, patient_id: a.id, status: "finished", end_date: "2026-09-30" });
  eq(updated.ok, true, "update_prescription ok");
  eq(updated.__error, undefined, "update_prescription no error");

  const onlyEnd = await call("update_prescription", { id: rxActive.id, patient_id: a.id, end_date: "2026-12-31" });
  eq(onlyEnd.ok, true, "update_prescription end_date only");

  const rxListA = await call("list_prescriptions", { patient_id: a.id });
  eq(rxListA.prescriptions.length, 2, "list_prescriptions A count");
  ok(rxListA.prescriptions.every((p) => p.patient_id === a.id), "rx A rows stay on A");
  const on = rxListA.prescriptions.find((p) => p.id === rxActive.id);
  const off = rxListA.prescriptions.find((p) => p.id === rxDone.id);
  eq(on.drug_name, `DRUG_A_ON_${mark}`, "rx drug roundtrip");
  eq(on.spec, "0.25g", "rx spec roundtrip");
  eq(on.usage, "tid", "rx usage roundtrip");
  eq(on.start_date, "2026-06-01", "rx start roundtrip");
  eq(on.visit_id, vOld.id, "rx visit_id roundtrip");
  eq(on.status, "active", "end_date update keeps status");
  eq(on.end_date, "2026-12-31", "end_date roundtrip");
  eq(off.status, "finished", "status updated");
  eq(off.end_date, "2026-09-30", "finished end_date");

  const rxActiveA = await call("list_prescriptions", { patient_id: a.id, status: "active" });
  eq(rxActiveA.prescriptions.length, 1, "status filter count");
  eq(rxActiveA.prescriptions[0].id, rxActive.id, "status filter row");
  const rxFinishedA = await call("list_prescriptions", { patient_id: a.id, status: "finished" });
  eq(rxFinishedA.prescriptions.length, 1, "finished filter count");
  eq(rxFinishedA.prescriptions[0].drug_name, `DRUG_A_OFF_${mark}`, "finished filter row");

  const rxListB = await call("list_prescriptions", { patient_id: b.id });
  eq(rxListB.prescriptions.length, 1, "list_prescriptions B count");
  eq(rxListB.prescriptions[0].drug_name, `DRUG_B_${mark}`, "B drug");
  eq(rxListB.prescriptions[0].status, "active", "B still active after A update");
  ok(!rxListB.prescriptions.some((p) => String(p.drug_name).includes("DRUG_A")), "rx B hides A");

  const rxInj = await call("list_prescriptions", { patient_id: a.id, status: "active' OR '1'='1" });
  eq(rxInj.prescriptions.length, 0, "status injection returns none");

  // 化验
  const labNew = await call("add_lab_report", {
    patient_id: a.id, report_date: "2026-08-08", report_type: "血常规",
    summary: `LAB_A_NEW_${mark}`, file_url: `https://files.example/${mark}/a.pdf`,
  });
  ok(labNew.id && labNew.id.startsWith("lab_"), "add_lab_report id");
  await call("add_lab_report", { patient_id: a.id, report_date: "2025-01-01", summary: `LAB_A_OLD_${mark}` });
  const labB = await call("add_lab_report", {
    patient_id: b.id, report_date: "2026-08-08", summary: `LAB_B_${mark}`,
  });
  ok(labB.id.startsWith("lab_"), "add_lab_report B");
  const labNo = await call("add_lab_report", { patient_id: a.id });
  toolErr(labNo, -32602, "report_date_required", "add_lab_report missing date");

  const labsA = await call("list_lab_reports", { patient_id: a.id });
  eq(labsA.lab_reports.length, 2, "list_lab_reports A count");
  eq(labsA.lab_reports.map((r) => r.report_date).join(","), "2026-08-08,2025-01-01", "labs date desc");
  ok(labsA.lab_reports.every((r) => r.patient_id === a.id), "labs A only A");
  const labRow = labsA.lab_reports.find((r) => r.id === labNew.id);
  eq(labRow.report_type, "血常规", "lab type roundtrip");
  eq(labRow.summary, `LAB_A_NEW_${mark}`, "lab summary roundtrip");
  eq(labRow.file_url, `https://files.example/${mark}/a.pdf`, "lab file_url roundtrip");
  const labsB = await call("list_lab_reports", { patient_id: b.id });
  eq(labsB.lab_reports.length, 1, "list_lab_reports B count");
  eq(labsB.lab_reports[0].summary, `LAB_B_${mark}`, "lab B summary");
  ok(!labsA.lab_reports.some((r) => String(r.summary).includes(`LAB_B_${mark}`)), "labs A hides B");

  // 疫苗是已经打过的静态记录。待接种不写在这里。
  const vaxNoDate = await call("add_vaccination", { patient_id: a.id, vaccine_name: `VAX_NODATE_${mark}`, next_due_at: dueSoon });
  toolErr(vaxNoDate, -32602, "vaccinated_at_required", "add_vaccination missing date");
  const vaxNoName = await call("add_vaccination", { patient_id: a.id, vaccinated_at: "2026-09-01" });
  toolErr(vaxNoName, -32602, "vaccine_name_required", "add_vaccination missing name");
  const vaxA = await call("add_vaccination", {
    patient_id: a.id, vaccine_name: `VAX_A_${mark}`, dose_number: 0, total_doses: 3,
    vaccinated_at: "2026-09-01", next_due_at: dueSoon,
  });
  ok(vaxA.id && vaxA.id.startsWith("vax_"), "add_vaccination id");
  const vaxA2 = await call("add_vaccination", {
    patient_id: a.id, vaccine_name: `VAX_A2_${mark}`, dose_number: 1, total_doses: 1,
    vaccinated_at: "2026-08-01",
  });
  ok(vaxA2.id.startsWith("vax_"), "second completed dose");
  const vaxB = await call("add_vaccination", {
    patient_id: b.id, vaccine_name: `VAX_B_${mark}`, dose_number: 2, total_doses: 2,
    vaccinated_at: "2026-07-01",
  });
  ok(vaxB.id.startsWith("vax_"), "vaccination for B");

  const vaxListNo = await call("list_vaccinations", {});
  toolErr(vaxListNo, -32602, "patient_id_required", "list_vaccinations requires patient_id");
  const vaxListA = await call("list_vaccinations", { patient_id: a.id });
  eq(vaxListA.vaccinations.map((row) => row.vaccinated_at).join(","), "2026-09-01,2026-08-01", "list_vaccinations date desc");
  ok(vaxListA.vaccinations.every((row) => row.patient_id === a.id), "list_vaccinations A only A");
  const soon = vaxListA.vaccinations.find((row) => row.id === vaxA.id);
  eq(soon.dose_number, 0, "dose_number 0 preserved");
  eq(soon.total_doses, 3, "total_doses roundtrip");
  eq(soon.vaccinated_at, "2026-09-01", "vaccinated_at roundtrip");
  eq(soon.next_due_at ?? null, null, "next_due_at is not stored");
  const vaxListB = await call("list_vaccinations", { patient_id: b.id });
  eq(vaxListB.vaccinations.length, 1, "list_vaccinations B count");
  eq(vaxListB.vaccinations[0].vaccine_name, `VAX_B_${mark}`, "list B name");
  ok(!vaxListA.vaccinations.some((row) => row.vaccine_name === `VAX_B_${mark}`), "list A hides B");
  const gone = await call("upcoming_vaccinations", { days: 30 });
  eq(gone.__error && gone.__error.code, -32601, "upcoming_vaccinations removed");

  // 概况：只看该病人的在用药、最近 3 次就诊。下次疫苗不在病历里。
  const sumA = await call("health_summary", { patient_id: a.id });
  const medsA = sumA.active_medications.map((m) => m.drug_name);
  ok(medsA.includes(`DRUG_A_ON_${mark}`), "summary A active drug");
  ok(!medsA.includes(`DRUG_A_OFF_${mark}`), "summary A hides finished drug");
  ok(!medsA.includes(`DRUG_B_${mark}`), "summary A hides B drug");
  eq(sumA.active_medications.find((m) => m.drug_name === `DRUG_A_ON_${mark}`).spec, "0.25g", "summary spec");
  ok(!("upcoming_vaccines" in sumA), "summary does not list upcoming vaccines");
  const dxA = sumA.recent_visits.map((v) => v.diagnosis);
  eq(dxA.join(","), [`DX_A4_${mark}`, `DX_A3_${mark}`, `DX_A2_${mark}`].join(","), "summary A 3 newest visits");
  ok(!dxA.some((d) => String(d).includes(`DX_B_${mark}`)), "summary visits hide B");

  const sumB = await call("health_summary", { patient_id: b.id });
  eq(sumB.active_medications.map((m) => m.drug_name).join(","), `DRUG_B_${mark}`, "summary B only B drug");
  eq(sumB.recent_visits.length, 1, "summary B one visit");
  eq(sumB.recent_visits[0].diagnosis, `DX_B_${mark}`, "summary B diagnosis");
  eq(sumB.recent_visits[0].hospital, `医院B_${mark}`, "summary B hospital");

  // 已写下的记录可以更正，但不能改成别人的，也不能抹掉接种日期
  const vaxEmpty = await call("update_vaccination", { id: vaxA.id, patient_id: a.id });
  toolErr(vaxEmpty, -32602, "nothing_to_update", "update_vaccination empty patch");
  const vaxNoId = await call("update_vaccination", { patient_id: a.id, vaccinated_at: utcDate(0) });
  toolErr(vaxNoId, -32602, "id_required", "update_vaccination missing id");
  const vaxMissing = await call("update_vaccination", { id: "vax_missing", patient_id: a.id, vaccinated_at: utcDate(0) });
  toolErr(vaxMissing, -32602, "vaccination_not_found", "update_vaccination unknown id");
  const vaxCross = await call("update_vaccination", {
    id: vaxA.id, patient_id: b.id, vaccinated_at: utcDate(0),
  });
  toolErr(vaxCross, -32602, "vaccination_not_found", "update_vaccination other patient");
  const vaxAfterCross = (await call("list_vaccinations", { patient_id: a.id })).vaccinations.find((row) => row.id === vaxA.id);
  eq(vaxAfterCross.vaccinated_at, "2026-09-01", "cross update keeps vaccinated_at");
  eq(vaxAfterCross.dose_number, 0, "cross update keeps dose 0");
  const vaxBlank = await call("update_vaccination", { id: vaxA.id, patient_id: a.id, vaccine_name: " " });
  toolErr(vaxBlank, -32602, "vaccine_name_required", "update_vaccination blank name");
  const vaxBadDose = await call("update_vaccination", { id: vaxA.id, patient_id: a.id, dose_number: 1.5 });
  toolErr(vaxBadDose, -32602, "invalid_dose_number", "update_vaccination fractional dose");
  const vaxClear = await call("update_vaccination", { id: vaxA.id, patient_id: a.id, vaccinated_at: "" });
  toolErr(vaxClear, -32602, "vaccinated_at_required", "update_vaccination cannot clear date");
  const vaxFixed = await call("update_vaccination", {
    id: vaxA2.id, patient_id: a.id, vaccine_name: `VAX_A2_FIXED_${mark}`,
    vaccinated_at: utcDate(0), dose_number: 4, total_doses: 4,
  });
  eq(vaxFixed.ok, true, "update_vaccination corrects a recorded dose");
  const fixedRow = (await call("list_vaccinations", { patient_id: a.id })).vaccinations.find((row) => row.id === vaxA2.id);
  eq(fixedRow.vaccine_name, `VAX_A2_FIXED_${mark}`, "vaccine_name updated");
  eq(fixedRow.vaccinated_at, utcDate(0), "vaccinated_at corrected");
  eq(fixedRow.dose_number, 4, "dose_number corrected");
  eq(fixedRow.total_doses, 4, "total_doses corrected");
  eq((await call("list_vaccinations", { patient_id: a.id })).vaccinations.find((row) => row.id === vaxA.id).vaccinated_at,
    "2026-09-01", "correcting one dose leaves the other");

  const sumAll = await call("health_summary", {});
  ok(sumAll.active_medications.some((m) => m.drug_name === `DRUG_A_ON_${mark}`), "family summary has A drug");
  ok(sumAll.active_medications.some((m) => m.drug_name === `DRUG_B_${mark}`), "family summary has B drug");
  ok(!sumAll.active_medications.some((m) => m.drug_name === `DRUG_A_OFF_${mark}`), "family summary hides finished");
  const sumAllA = sumAll.active_medications.find((m) => m.drug_name === `DRUG_A_ON_${mark}`);
  eq(sumAllA && sumAllA.patient_id, a.id, "family summary row carries patient_id");
  eq(sumAllA && sumAllA.patient_name, (await call("list_patients", {})).patients.find((x) => x.id === a.id).name,
    "family summary row carries patient_name");
  ok(sumAll.recent_visits.every((v) => v.patient_id && "patient_name" in v), "family summary visits are attributed");

  // 医疗保险：字段往返、按病人隔离，更新和删除不能改到别人的保单
  const insNo = await call("add_insurance", { provider: "平安健康" });
  toolErr(insNo, -32602, "patient_id_required", "add_insurance missing patient");
  const insBad = await call("add_insurance", { patient_id: "pat_missing", provider: "平安健康" });
  toolErr(insBad, -32602, "patient_not_found", "add_insurance unknown patient");
  const insBlank = await call("add_insurance", { patient_id: a.id, provider: "   " });
  toolErr(insBlank, -32602, "provider_required", "add_insurance blank provider");

  const insA = await call("add_insurance", {
    patient_id: a.id,
    provider: `平安健康_${mark}`,
    policy_number: `PH_${mark}`,
    plan_type: "商保",
    coverage_details: `住院报销 80%_${mark}`,
    valid_from: "2026-01-01",
    valid_to: dueSoon,
    contact_phone: "95511",
    notes: `备注保单_${mark}`,
  });
  ok(insA.id && insA.id.startsWith("ins_"), "add_insurance id");
  const insA2 = await call("add_insurance", { patient_id: a.id, provider: `中国人寿_${mark}` });
  ok(insA2.id && insA2.id !== insA.id, "second insurance id");
  const insB = await call("add_insurance", {
    patient_id: b.id, provider: `城乡居民医保_${mark}`, policy_number: `CX_${mark}`, plan_type: "城乡居民医保",
    coverage_details: `门诊额度_${mark}`, valid_to: dueFar,
  });
  ok(insB.id.startsWith("ins_"), "add_insurance B");

  const insListA = await call("list_insurance", { patient_id: a.id });
  eq(insListA.insurance.length, 2, "list_insurance A count");
  ok(insListA.insurance.every((row) => row.patient_id === a.id), "list_insurance A only A");
  const insRow = insListA.insurance.find((row) => row.id === insA.id);
  eq(insRow.provider, `平安健康_${mark}`, "insurance provider roundtrip");
  eq(insRow.policy_number, `PH_${mark}`, "insurance policy_number roundtrip");
  eq(insRow.plan_type, "商保", "insurance plan_type roundtrip");
  eq(insRow.coverage_details, `住院报销 80%_${mark}`, "insurance coverage roundtrip");
  eq(insRow.valid_from, "2026-01-01", "insurance valid_from roundtrip");
  eq(insRow.valid_to, dueSoon, "insurance valid_to roundtrip");
  eq(insRow.contact_phone, "95511", "insurance phone roundtrip");
  eq(insRow.notes, `备注保单_${mark}`, "insurance notes roundtrip");
  ok(insRow.created_at && insRow.created_at.includes("T"), "insurance created_at");
  const insBare = insListA.insurance.find((row) => row.id === insA2.id);
  eq(insBare.policy_number, null, "insurance optional policy null");
  eq(insBare.coverage_details, null, "insurance optional coverage null");
  const insListB = await call("list_insurance", { patient_id: b.id });
  eq(insListB.insurance.length, 1, "list_insurance B count");
  eq(insListB.insurance[0].policy_number, `CX_${mark}`, "list_insurance B policy");
  ok(!insListA.insurance.some((row) => row.policy_number === `CX_${mark}`), "list_insurance A hides B");
  const insInj = await call("list_insurance", { patient_id: "' OR 1=1 --" });
  toolErr(insInj, -32602, "patient_not_found", "list_insurance injection");

  const insEmpty = await call("update_insurance", { id: insA.id, patient_id: a.id });
  toolErr(insEmpty, -32602, "nothing_to_update", "update_insurance empty patch");
  const insCross = await call("update_insurance", {
    id: insA.id, patient_id: b.id, provider: `被改掉_${mark}`, notes: "越权",
  });
  toolErr(insCross, -32602, "insurance_not_found", "update_insurance other patient");
  const insAfterCross = (await call("list_insurance", { patient_id: a.id })).insurance.find((row) => row.id === insA.id);
  eq(insAfterCross.provider, `平安健康_${mark}`, "cross update keeps provider");
  eq(insAfterCross.notes, `备注保单_${mark}`, "cross update keeps notes");
  const insUpdated = await call("update_insurance", {
    id: insA.id, patient_id: a.id, coverage_details: `住院报销 90%_${mark}`, valid_to: dueFar, contact_phone: "",
  });
  eq(insUpdated.ok, true, "update_insurance ok");
  const insAfter = (await call("list_insurance", { patient_id: a.id })).insurance.find((row) => row.id === insA.id);
  eq(insAfter.coverage_details, `住院报销 90%_${mark}`, "insurance coverage updated");
  eq(insAfter.valid_to, dueFar, "insurance valid_to updated");
  eq(insAfter.contact_phone, null, "empty phone clears");
  eq(insAfter.provider, `平安健康_${mark}`, "omitted provider stays");
  eq(insAfter.plan_type, "商保", "omitted plan_type stays");
  eq((await call("list_insurance", { patient_id: b.id })).insurance[0].provider, `城乡居民医保_${mark}`, "B unchanged after A update");

  const delCross = await call("delete_insurance", { id: insA.id, patient_id: b.id });
  toolErr(delCross, -32602, "insurance_not_found", "delete_insurance other patient");
  ok((await call("list_insurance", { patient_id: a.id })).insurance.some((row) => row.id === insA.id), "cross delete keeps policy");
  const delNoId = await call("delete_insurance", { patient_id: a.id });
  toolErr(delNoId, -32602, "id_required", "delete_insurance missing id");
  const delMissing = await call("delete_insurance", { id: "ins_missing", patient_id: a.id });
  toolErr(delMissing, -32602, "insurance_not_found", "delete_insurance unknown id");
  const delOk = await call("delete_insurance", { id: insA2.id, patient_id: a.id });
  eq(delOk.ok, true, "delete_insurance ok");
  const insLeft = await call("list_insurance", { patient_id: a.id });
  eq(insLeft.insurance.length, 1, "delete drops one policy");
  eq(insLeft.insurance[0].id, insA.id, "deleted the intended policy");
  eq((await call("list_insurance", { patient_id: b.id })).insurance.length, 1, "delete leaves the other patient");

  // 病历列表必须指定病人；处方只能由所属病人更新
  for (const tool of ["list_visits", "list_prescriptions", "list_lab_reports", "list_vaccinations"]) {
    toolErr(await call(tool, {}), -32602, "patient_id_required", `${tool} requires patient_id`);
  }
  const rxOfB = (await call("list_prescriptions", { patient_id: b.id })).prescriptions[0];
  toolErr(await call("update_prescription", { id: rxOfB.id, patient_id: a.id, status: "finished" }),
    -32602, "prescription_not_found", "update_prescription cannot touch another patient's rx");
  eq((await call("list_prescriptions", { patient_id: b.id })).prescriptions[0].status, rxOfB.status,
    "cross-patient update leaves B unchanged");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("FAILED CASES:");
    for (const f of failures) console.log(" - " + f);
  }
}

try {
  await main();
} catch (e) {
  failed++;
  console.error("E2E CRASH:", e);
} finally {
  if (worker) await worker.stop();
}
process.exit(failed ? 1 : 0);
