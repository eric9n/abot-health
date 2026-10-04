// 病历查看页：医保标签、到期前 30 天黄色提醒，以及 /api/patient 按病人返回保单
import { readFileSync } from "node:fs";
import vm from "node:vm";
import viewer from "../pages/worker.js";

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; console.error("FAIL:", name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function localDay(offset) {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const m = String(day.getMonth() + 1).padStart(2, "0");
  const d = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${m}-${d}`;
}

function node(tag) {
  return {
    nodeType: 1,
    tag,
    className: "",
    textContent: "",
    hidden: false,
    children: [],
    attrs: {},
    append(...kids) {
      for (const kid of kids) if (kid != null && kid !== false) this.children.push(kid);
    },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    addEventListener() {},
    replaceChildren(...kids) { this.children = kids.filter((kid) => kid != null); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function texts(n) {
  if (!n) return [];
  const out = n.textContent ? [n.textContent] : [];
  for (const child of n.children || []) out.push(...texts(child));
  return out;
}

function classes(n) {
  if (!n) return [];
  const out = n.className ? [n.className] : [];
  for (const child of n.children || []) out.push(...classes(child));
  return out;
}

function loadApp() {
  const elements = {};
  const document = {
    getElementById(id) { return elements[id] || (elements[id] = node(id)); },
    createElement: node,
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: node("body"),
  };
  const sandbox = {
    document,
    sessionStorage: { getItem() { return ""; }, setItem() {} },
    window: { addEventListener() {}, innerWidth: 1200 },
    CSS: { escape(s) { return s; } },
    fetch: async () => { throw new Error("no fetch"); },
    console,
  };
  vm.createContext(sandbox);
  const code = readFileSync(new URL("../pages/app.js", import.meta.url), "utf8")
    .replace("const state = {", "var state = globalThis.__state = {")
    .replace(/\ninit\(\);\s*$/, "\n");
  vm.runInContext(code, sandbox, { filename: "pages/app.js" });
  return { sandbox, elements };
}

function policy(id, extra) {
  return {
    id,
    patient_id: "p1",
    provider: extra.provider,
    policy_number: extra.policy_number || "",
    plan_type: extra.plan_type || "",
    coverage_details: extra.coverage_details || "",
    valid_from: extra.valid_from || "",
    valid_to: extra.valid_to || "",
    contact_phone: extra.contact_phone || "",
    notes: extra.notes || "",
  };
}

// 嵌入的查看页必须和 pages/app.js、pages/style.css 一致
{
  const bundled = readFileSync(new URL("../pages/worker.js", import.meta.url), "utf8");
  function unescapeTemplate(src, name) {
    const token = `const ${name} = \``;
    const start = src.indexOf(token);
    ok(start >= 0, `bundle contains ${name}`);
    let i = start + token.length;
    let out = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        const next = src[i + 1];
        if (next === "\\" || next === "`" || next === "$") { out += next; i += 2; continue; }
        throw new Error(`unexpected escape \\${next} in ${name}`);
      }
      if (ch === "`") break;
      out += ch;
      i++;
    }
    return out;
  }
  eq(unescapeTemplate(bundled, "APP_JS"), readFileSync(new URL("../pages/app.js", import.meta.url), "utf8"), "bundled app.js matches source");
  eq(unescapeTemplate(bundled, "STYLE_CSS"), readFileSync(new URL("../pages/style.css", import.meta.url), "utf8"), "bundled style.css matches source");
  ok(bundled.includes("SELECT * FROM insurance WHERE patient_id=?"), "viewer query is scoped by patient_id");
}

const { sandbox } = loadApp();
const soon = localDay(30);
const later = localDay(31);
const today = localDay(0);
const yesterday = localDay(-1);
const rows = [
  policy("soon", { provider: "平安健康", policy_number: "PH-1", plan_type: "商保", coverage_details: "住院报销 80%", valid_from: "2026-01-01", valid_to: soon, contact_phone: "95511" }),
  policy("edge", { provider: "中国人寿", policy_number: "CL-2", plan_type: "社保", coverage_details: "门诊", valid_to: later }),
  policy("today", { provider: "新农合", policy_number: "NH-3", plan_type: "新农合", valid_to: today }),
  policy("old", { provider: "过期保", policy_number: "EX-4", plan_type: "商保", valid_to: yesterday }),
  policy("open", { provider: "未填到期", policy_number: "NO-5", plan_type: "城乡居民医保" }),
];

const flagged = sandbox.expiringInsurance(rows);
eq(flagged.map((row) => row.id).join(","), "old,today,soon", "expiring sorted, includes today and day 30, skips day 31");
eq(flagged.find((row) => row.id === "old").expired, true, "yesterday is expired");
eq(flagged.find((row) => row.id === "today").expired, false, "expires today is not yet expired");
eq(flagged.find((row) => row.id === "soon").expired, false, "day 30 is 即将到期");
eq(sandbox.expiringInsurance([{ id: "x", valid_to: "不是日期" }]).length, 0, "unparseable valid_to is ignored");
eq(sandbox.expiringInsurance(null).length, 0, "missing list is empty");

const view = sandbox.renderInsurance({ insurance: rows });
const viewText = texts(view).join("\n");
ok(viewText.includes("有 3 份保单需关注，含已到期"), "banner counts soon and expired");
ok(viewText.includes("平安健康"), "shows provider");
ok(viewText.includes("PH-1"), "shows policy number");
ok(viewText.includes("商保"), "shows plan type");
ok(viewText.includes("住院报销 80%"), "shows coverage");
ok(viewText.includes("至"), "shows validity range");
ok(viewText.includes("95511"), "shows insurer phone");
ok(viewText.includes("即将到期"), "soon policy tagged");
ok(viewText.includes("已到期"), "expired policy tagged");
const cards = view.children.filter((child) => child.tag === "article");
eq(cards.length, 5, "one card per policy");
eq(cards.find((card) => texts(card).join(" ").includes("平安健康")).className, "card ins is-due", "soon card is yellow");
eq(cards.find((card) => texts(card).join(" ").includes("过期保")).className, "card ins is-due", "expired card is yellow");
eq(cards.find((card) => texts(card).join(" ").includes("中国人寿")).className, "card ins", "day 31 card is not highlighted");
ok(classes(view).includes("due-banner"), "banner uses the vaccine due style");

const onlySoon = sandbox.renderInsurance({
  insurance: [policy("soon", { provider: "平安健康", policy_number: "PH-1", plan_type: "商保", valid_to: soon })],
});
ok(texts(onlySoon).join("\n").includes("有 1 份保单将在 30 天内到期"), "banner for the 30-day window");
ok(!texts(onlySoon).join("\n").includes("已到期"), "window banner does not say expired");

const empty = sandbox.renderInsurance({ insurance: [] });
eq(empty.textContent, "还没有医疗保险", "empty insurance tab");
eq(empty.className, "hint", "empty state uses hint");

sandbox.__state.patients = [{ id: "p1", name: "甲" }];
sandbox.__state.selectedId = "p1";
sandbox.__state.loadingList = false;
sandbox.__state.loadingDetail = false;
sandbox.__state.detailError = "";
sandbox.__state.tab = "insurance";
sandbox.__state.detail = {
  patientId: "p1",
  patient: { id: "p1", name: "甲" },
  visits: [],
  prescriptions: [],
  reports: [],
  files: [],
  vaccinations: [],
  allergies: [],
  chronic_conditions: [],
  surgeries: [],
  emergency_contacts: [],
  insurance: rows,
};
sandbox.renderMain();
const mainText = texts(sandbox.document.getElementById("main")).join("\n");
ok(mainText.includes("医保"), "insurance tab is rendered");
const tabButtons = [];
(function walk(n) {
  if (!n) return;
  if (n.tag === "button" && n.attrs && n.attrs.role === "tab") tabButtons.push(n);
  for (const child of n.children || []) walk(child);
})(sandbox.document.getElementById("main"));
const insuranceTab = tabButtons.find((button) => button.textContent === "医保");
ok(insuranceTab, "医保 tab button");
eq(insuranceTab && insuranceTab.attrs["aria-selected"], "true", "insurance tab selected");
const badge = insuranceTab && insuranceTab.children.find((child) => child.className === "badge");
eq(badge && badge.textContent, "3", "tab badge counts policies inside 30 days and already expired");

sandbox.__state.detail = { ...sandbox.__state.detail, insurance: [policy("edge", { provider: "中国人寿", valid_to: later })] };
sandbox.renderMain();
const quiet = [];
(function walk(n) {
  if (!n) return;
  if (n.tag === "button" && n.attrs && n.attrs.role === "tab" && n.textContent === "医保") quiet.push(n);
  for (const child of n.children || []) walk(child);
})(sandbox.document.getElementById("main"));
eq(quiet.length, 1, "rerender keeps one insurance tab");
eq((quiet[0].children || []).some((child) => child.className === "badge"), false, "no badge when expiry is outside 30 days");

function viewerDb(seed) {
  const tables = {
    patients: seed.patients || [],
    visits: [],
    prescriptions: [],
    lab_reports: [],
    lab_report_files: [],
    vaccinations: [],
    allergies: [],
    chronic_conditions: [],
    surgeries: [],
    emergency_contacts: [],
    insurance: seed.insurance || [],
  };
  return {
    prepare(sql) {
      const exec = (params) => ({
        async run() { return { meta: { changes: 1 } }; },
        async all() {
          const q = sql.replace(/\s+/g, " ").trim();
          if (/^PRAGMA table_info\(patients\)$/i.test(q)) return { results: [{ name: "avatar_r2_key" }] };
          const match = q.match(/^SELECT (.+) FROM (\w+)(?: WHERE patient_id=\?)?(?: ORDER BY .+)?$/i);
          if (!match) throw new Error("viewer fake select: " + q);
          let found = tables[match[2]] || [];
          if (/WHERE patient_id=\?/.test(q)) found = found.filter((row) => row.patient_id === params[0]);
          return { results: found.map((row) => ({ ...row })) };
        },
        async first() {
          const q = sql.replace(/\s+/g, " ").trim();
          if (/FROM patients WHERE id=\?/.test(q)) return tables.patients.find((row) => row.id === params[0]) || null;
          throw new Error("viewer fake first: " + q);
        },
      });
      return { ...exec([]), bind(...params) { return exec(params); } };
    },
  };
}

// ---------- Cloudflare Access JWT ----------
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-viewer";
const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const signingKeys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const otherKeys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signingKeys.publicKey)), kid: "k1" };
let certFetches = 0;
globalThis.fetch = async (input) => {
  const u = String(input && input.url ? input.url : input);
  if (u !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error("unexpected fetch " + u);
  certFetches++;
  return Response.json({ keys: [publicJwk] });
};
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
async function accessJwt(claims = {}, { kid = "k1", key = signingKeys.privateKey, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(Buffer.from(JSON.stringify({ alg, kid, typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify({
    aud: [AUD], iss: `https://${TEAM}`, email: "owner@example.com", iat: now, nbf: now, exp: now + 600, ...claims,
  })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(new Uint8Array(sig));
}
const goodJwt = await accessJwt();
function authed(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Cf-Access-Jwt-Assertion", goodJwt);
  return new Request(url, { ...init, headers });
}

{
  const env = { ...ACCESS_ENV, DB: viewerDb({ patients: [{ id: "pat_a", name: "甲" }] }) };
  const status = async (req, e = env) => (await viewer.fetch(req, e)).status;
  eq(await status(new Request("https://viewer.local/api/patients")), 403, "access: no jwt is rejected");
  eq(await status(new Request("https://viewer.local/")), 403, "access: static page also requires jwt");
  eq(await status(authed("https://viewer.local/api/patients"), { DB: env.DB }), 403, "access: unconfigured env fails closed");
  eq(await status(authed("https://viewer.local/api/patients")), 200, "access: valid jwt allowed");
  const withJwt = async (jwt) => status(new Request("https://viewer.local/api/patients", { headers: { "Cf-Access-Jwt-Assertion": jwt } }));
  eq(await withJwt(await accessJwt({ aud: ["other-app"] })), 403, "access: wrong aud rejected");
  eq(await withJwt(await accessJwt({ iss: "https://evil.cloudflareaccess.com" })), 403, "access: wrong issuer rejected");
  eq(await withJwt(await accessJwt({ exp: Math.floor(Date.now() / 1000) - 5 })), 403, "access: expired rejected");
  eq(await withJwt(await accessJwt({}, { key: otherKeys.privateKey })), 403, "access: bad signature rejected");
  eq(await withJwt(await accessJwt({}, { alg: "none" })), 403, "access: alg none rejected");
  eq(await withJwt("not.a.jwt"), 403, "access: garbage rejected");
  const before = certFetches;
  eq(await withJwt(await accessJwt({}, { kid: "unknown" })), 403, "access: unknown kid rejected");
  eq(await withJwt(await accessJwt({}, { kid: "unknown2" })), 403, "access: unknown kid rejected again");
  ok(certFetches - before <= 1, "access: unknown kids do not hammer the certs endpoint");

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  const avatarBody = JSON.stringify({ patient_id: "pat_a", filename: "a.png", content_base64: png });
  eq(await status(authed("https://viewer.local/api/avatar", {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: avatarBody,
  })), 403, "avatar: cross-origin POST rejected");
  eq(await status(authed("https://viewer.local/api/avatar", {
    method: "POST", headers: { "content-type": "application/json" }, body: avatarBody,
  })), 403, "avatar: POST without Origin rejected");
  eq(await status(authed("https://viewer.local/api/avatar", {
    method: "POST", headers: { origin: "https://viewer.local", "content-type": "text/plain" }, body: avatarBody,
  })), 400, "avatar: non-JSON content type rejected");
  const huge = "A".repeat(4 * 1024 * 1024);
  const tooBig = await viewer.fetch(authed("https://viewer.local/api/avatar", {
    method: "POST", headers: { origin: "https://viewer.local", "content-type": "application/json" },
    body: JSON.stringify({ patient_id: "pat_a", filename: "a.png", content_base64: huge }),
  }), { ...env, FILES: { async put() { throw new Error("should not upload"); } } });
  eq(tooBig.status, 400, "avatar: oversized base64 rejected before decode");
  eq((await tooBig.json()).error, "file_too_large", "avatar: oversized error code");
}

{
  const env = {
    ...ACCESS_ENV,
    DB: viewerDb({
      patients: [
        { id: "pat_a", name: "甲" },
        { id: "pat_b", name: "乙" },
      ],
      insurance: [
        { id: "ins_a", patient_id: "pat_a", provider: "平安健康", policy_number: "PH-1", plan_type: "商保", coverage_details: "住院报销 80%", valid_from: "2026-01-01", valid_to: soon },
        { id: "ins_b", patient_id: "pat_b", provider: "中国人寿", policy_number: "CL-9", plan_type: "社保", coverage_details: "门诊", valid_to: later },
      ],
    }),
  };
  const res = await viewer.fetch(authed("https://viewer.local/api/patient?id=pat_a"), env);
  eq(res.status, 200, "patient api 200");
  const body = await res.json();
  eq(body.insurance.length, 1, "api returns only that patient's policies");
  eq(body.insurance[0].provider, "平安健康", "api provider");
  eq(body.insurance[0].policy_number, "PH-1", "api policy number");
  eq(body.insurance[0].plan_type, "商保", "api plan type");
  eq(body.insurance[0].coverage_details, "住院报销 80%", "api coverage");
  eq(body.insurance[0].valid_to, soon, "api valid_to");
  ok(!body.insurance.some((row) => row.patient_id === "pat_b"), "api does not leak the other patient");
  const other = await viewer.fetch(authed("https://viewer.local/api/patient?id=pat_b"), env);
  const otherBody = await other.json();
  eq(otherBody.insurance.length, 1, "other patient has their own policy");
  eq(otherBody.insurance[0].id, "ins_b", "other patient policy id");
  const missing = await viewer.fetch(authed("https://viewer.local/api/patient?id=pat_missing"), env);
  eq(missing.status, 404, "unknown patient 404");
  const noId = await viewer.fetch(authed("https://viewer.local/api/patient"), env);
  eq(noId.status, 400, "patient api requires id");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
