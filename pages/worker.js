// abot-health-viewer Worker
// 直接绑定 D1/R2，前端同域调用 /api/*，无需 MCP 鉴权
// Cloudflare Access 已做登录保护

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%2310b981'/%3E%3C/svg%3E">
  <title>病历查看</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="header">
    <div class="logo" aria-hidden="true">🏥</div>
    <h1>abot-health</h1>
    <span class="sub">病历查看</span>
  </header>

  <div class="layout">
    <aside id="sidebar" class="sidebar">
      <input id="search" class="search" type="search" placeholder="搜索病人姓名..." aria-label="搜索病人">
      <div id="patient-list" class="patient-list" role="listbox" aria-label="病人列表"></div>
    </aside>
    <main id="main" class="main"></main>
  </div>

  <div id="lightbox" class="lightbox" hidden>
    <div class="lightbox-card" role="dialog" aria-modal="true" aria-label="检查图片">
      <div class="lightbox-bar">
        <p id="lightbox-name"></p>
        <div class="lightbox-actions">
          <button type="button" id="lightbox-download">下载</button>
          <button type="button" id="lightbox-close" class="ghost">关闭</button>
        </div>
      </div>
      <img id="lightbox-img" alt="">
    </div>
  </div>
  <noscript><p class="noscript">需要启用 JavaScript 才能查看病历。</p></noscript>
  <script src="app.js"></script>
</body>
</html>
`;
const STYLE_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f5f7fa;
  color: #1a1a1a;
}

button { font-family: inherit; }

button { cursor: pointer; }

.header {
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  position: sticky;
  top: 0;
  z-index: 10;
}

.header .logo {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, #10b981, #059669);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 20px;
  flex: none;
}

.header h1 { font-size: 18px; font-weight: 600; }

.header .sub {
  color: #6b7280;
  font-size: 13px;
  margin-left: auto;
}

.layout {
  display: flex;
  max-width: 1400px;
  margin: 0 auto;
  min-height: calc(100vh - 69px);
}

.sidebar {
  width: 300px;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  padding: 16px;
  overflow-y: auto;
  flex: none;
}

.search {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  font-size: 14px;
  margin-bottom: 12px;
  outline: none;
  background: #fff;
}

.search:focus { border-color: #10b981; }

.patient-card {
  display: block;
  width: 100%;
  text-align: left;
  padding: 14px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: all .15s;
  background: #fff;
  color: inherit;
  font-size: inherit;
}

.patient-card:hover { border-color: #10b981; }

.patient-card.active {
  border-color: #10b981;
  background: #ecfdf5;
}

.patient-card .name { font-weight: 600; font-size: 15px; }

.patient-card .meta {
  color: #6b7280;
  font-size: 12px;
  margin-top: 4px;
}

.patient-card .tag {
  display: inline-block;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 20px;
  margin-top: 6px;
}

.patient-card .tag-due {
  background: #fef3c7;
  color: #92400e;
  margin-left: 6px;
}

.main {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  min-width: 0;
}

.patient-head {
  background: #fff;
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 16px;
  display: flex;
  gap: 20px;
  align-items: center;
}

.avatar {
  width: 64px;
  height: 64px;
  background: linear-gradient(135deg, #a7f3d0, #6ee7b7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  flex: none;
}

.patient-head h2 { font-size: 20px; }

.patient-head .info {
  color: #6b7280;
  font-size: 13px;
  margin-top: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.allergy-alert {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.allergy-alert .allergy-icon { font-size: 20px; }

.allergy-alert .allergy-copy { font-size: 13px; }

.allergy-alert b { color: #dc2626; }

.allergy-alert .allergy-detail { color: #991b1b; }

.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.tab {
  padding: 10px 20px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  cursor: pointer;
  font-size: 14px;
  transition: all .15s;
  color: #1a1a1a;
}

.tab.active {
  background: #10b981;
  color: #fff;
  border-color: #10b981;
}

.section {
  background: #fff;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
}

.section h3 { font-size: 16px; margin-bottom: 14px; }

.section h3 .count {
  color: #9ca3af;
  font-weight: 400;
  font-size: 13px;
  margin-left: 6px;
}

.record {
  border-left: 3px solid #10b981;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: #f9fafb;
  border-radius: 0 10px 10px 0;
}

.record .date { color: #10b981; font-size: 12px; font-weight: 600; }

.record .title { font-weight: 600; margin: 4px 0; }

.record .desc { color: #4b5563; font-size: 13px; line-height: 1.6; }

.record.is-due { border-left-color: #f59e0b; }

.record.is-due .date { color: #f59e0b; }

.record.is-moderate { border-left-color: #f59e0b; }

.record.is-severe { border-left-color: #ef4444; }

.record .files {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.badge {
  display: inline-block;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 20px;
  margin-left: 8px;
}

.badge-green { background: #d1fae5; color: #065f46; }

.badge-blue { background: #dbeafe; color: #1e40af; }

.badge-yellow { background: #fef3c7; color: #92400e; }

.badge-red { background: #fee2e2; color: #991b1b; }

.badge-muted { background: #f3f4f6; color: #4b5563; }

.tab .badge { vertical-align: middle; }

.tab.active .badge-yellow,
.tab.active .badge-red { color: #92400e; }

.tab.active .badge-red { color: #991b1b; }

.thumb {
  width: 80px;
  height: 80px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  background: #e5e7eb;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #6b7280;
  flex: none;
}

.thumb img {
  width: 80px;
  height: 80px;
  object-fit: cover;
  display: block;
}

.file-pdf {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  color: #dc2626;
  height: auto;
  text-align: left;
}

.linkish {
  display: inline-flex;
  align-items: center;
  margin-top: 8px;
  color: #1e40af;
  font-size: 13px;
  text-decoration: none;
}

.note {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  font-size: 13px;
  color: #92400e;
}

.note ul { margin: 8px 0 0 1.1em; }

.note li + li { margin-top: 4px; }

.hint { color: #6b7280; font-size: 13px; }

.empty {
  background: #fff;
  border-radius: 16px;
  padding: 28px 20px;
  color: #6b7280;
  font-size: 14px;
}

.error-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  color: #991b1b;
  font-size: 13px;
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(17, 24, 39, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.lightbox[hidden] { display: none; }

.lightbox-card {
  width: min(960px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  background: #fff;
  border-radius: 16px;
  padding: 16px;
}

.lightbox-bar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.lightbox-bar p {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.lightbox-actions { display: flex; gap: 8px; flex: none; }

#lightbox-download,
.ghost,
#lightbox-close {
  height: auto;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 14px;
}

#lightbox-download {
  background: #10b981;
  color: #fff;
  border: 1px solid #10b981;
}

.ghost,
#lightbox-close {
  background: #fff;
  color: #1a1a1a;
  border: 1px solid #e5e7eb;
}

.lightbox img {
  width: 100%;
  max-height: calc(100vh - 140px);
  object-fit: contain;
  background: #f3f4f6;
  border-radius: 10px;
  display: block;
}

.noscript { padding: 16px; }

:focus-visible {
  outline: 2px solid #10b981;
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .header { padding: 16px; }
  .layout { flex-direction: column; }
  .sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid #e5e7eb;
  }
  .main { padding: 16px; }
  .patient-head { padding: 16px; gap: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .patient-card, .tab { transition: none; }
}
`;
const APP_JS = `const SELECT_KEY = "abot-health-selected";

const TABS = [
  { id: "visits", label: "就诊记录" },
  { id: "prescriptions", label: "处方" },
  { id: "labs", label: "检查报告" },
  { id: "vaccines", label: "疫苗" },
  { id: "allergies", label: "过敏史" },
  { id: "chronic", label: "慢性病" },
  { id: "surgeries", label: "手术史" },
  { id: "contacts", label: "紧急联系人" },
];

const RX_LABEL = {
  active: "在用",
  finished: "已吃完",
  stopped: "已停",
  paused: "暂停",
};

const SEVERITY_LABEL = {
  mild: "轻度",
  moderate: "中度",
  severe: "严重",
};

const CHRONIC_STATUS_LABEL = {
  active: "患病中",
  managed: "管理中",
  cured: "已治愈",
};

const state = {
  patients: [],
  loadingList: false,
  selectedId: "",
  tab: "visits",
  detail: null,
  loadingDetail: false,
  detailError: "",
  generation: 0,
  fileCache: new Map(),
  dueCounts: {},
  lightboxFile: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "hidden") node.hidden = !!value;
    else if (typeof value === "function" && key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children || []) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function humanError(err) {
  const msg = String((err && err.message) || err || "");
  if (msg === "patient_not_found") return "找不到这位病人";
  return msg || "请求失败";
}

async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { "accept": "application/json" } });
  } catch {
    throw new Error("无法连接服务");
  }
  let body;
  try { body = await res.json(); }
  catch { throw new Error("服务返回了无法识别的内容"); }
  if (!res.ok) throw new Error(body.error || "请求失败");
  return body;
}

function parseDay(value) {
  const match = String(value || "").match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDate(value) {
  const day = parseDay(value);
  if (!day) return value ? String(value) : "";
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return \`\${day.getFullYear()}-\${month}-\${date}\`;
}

function ageFromDob(dob) {
  const birth = parseDay(dob);
  if (!birth) return "";
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const month = now.getMonth() - birth.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? \`\${age}岁\` : "";
}

function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return \`\${n} B\`;
  if (n < 1024 * 1024) return \`\${(n / 1024).toFixed(1)} KB\`;
  return \`\${(n / 1024 / 1024).toFixed(1)} MB\`;
}

function safeName(name) {
  const base = String(name || "文件").split(/[/\\\\]/).pop() || "文件";
  return base.replace(/[\\u0000-\\u001f"]/g, "").slice(0, 200) || "文件";
}

function fileKind(file) {
  const mime = String(file.mime || "");
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || /\\.pdf$/i.test(file.filename || "")) return "pdf";
  return "other";
}

function dueVaccines(list) {
  return (list || [])
    .map((row) => {
      const day = parseDay(row.next_due_at);
      if (!day) return null;
      return { ...row, due: day, overdue: day < startOfToday() };
    })
    .filter(Boolean)
    .sort((a, b) => a.due - b.due);
}

function doseText(row) {
  if (row.dose_number == null && row.total_doses == null) return "";
  if (row.total_doses != null) return \`第 \${row.dose_number || "?"} / \${row.total_doses} 剂\`;
  return \`第 \${row.dose_number} 剂\`;
}

function filteredPatients() {
  const q = $("search").value.trim().toLowerCase();
  if (!q) return state.patients;
  return state.patients.filter((patient) => {
    const hay = [patient.name, patient.relationship, patient.notes, patient.dob].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function currentBrief() {
  return state.patients.find((patient) => patient.id === state.selectedId) || null;
}

function renderChrome() {}

function patientMeta(patient) {
  return [formatDate(patient.dob), ageFromDob(patient.dob)].filter(Boolean).join(" · ");
}

function patientInfo(patient) {
  const bits = [];
  const dob = formatDate(patient.dob);
  const age = ageFromDob(patient.dob);
  if (dob && age) bits.push(\`\${dob}（\${age}）\`);
  else if (dob) bits.push(dob);
  else if (age) bits.push(age);
  if (patient.notes) bits.push(\`备注：\${patient.notes}\`);
  return bits.join(" · ");
}

function renderPatientList() {
  const list = $("patient-list");
  list.replaceChildren();
  const rows = filteredPatients();
  if (!rows.length) {
    list.append(el("p", { class: "hint", text: state.patients.length ? "没有匹配的病人" : "还没有病人" }));
    return;
  }
  for (const patient of rows) {
    const meta = patientMeta(patient);
    const button = el("button", {
      type: "button",
      class: "patient-card" + (patient.id === state.selectedId ? " active" : ""),
      role: "option",
      "aria-selected": patient.id === state.selectedId ? "true" : "false",
      onclick: () => selectPatient(patient.id),
    }, [
      el("div", { class: "name", text: patient.name || "未命名" }),
      meta ? el("div", { class: "meta", text: meta }) : null,
      patient.relationship ? el("span", { class: "tag", text: patient.relationship }) : null,
      state.dueCounts[patient.id] ? el("span", { class: "tag tag-due", title: "有待接种疫苗", text: "待接种" }) : null,
    ]);
    list.append(button);
  }
}

function emptyPanel(text) {
  return el("section", { class: "empty", text });
}

function errorBanner(text) {
  return text ? el("div", { class: "error-banner", text }) : null;
}

function sentence(parts) {
  const text = parts.filter(Boolean).join("。");
  return text ? el("p", { class: "desc", text: text + "。" }) : null;
}

function badge(text, kind) {
  if (!text) return null;
  return el("span", { class: \`badge badge-\${kind || "muted"}\`, text });
}

function renderVisits(detail) {
  if (!detail.visits.length) return el("p", { class: "hint", text: "还没有就诊记录" });
  const stack = el("div", {});
  for (const visit of detail.visits) {
    const title = visit.diagnosis || visit.complaint || "就诊";
    stack.append(el("article", { class: "record" }, [
      el("div", { class: "date", text: formatDate(visit.visit_date) || "未填日期" }),
      el("div", { class: "title", text: title }),
      sentence([
        visit.complaint && visit.complaint !== title ? \`主诉：\${visit.complaint}\` : "",
        visit.diagnosis && visit.diagnosis !== title ? \`诊断：\${visit.diagnosis}\` : "",
        visit.hospital ? \`医院：\${visit.hospital}\` : "",
        visit.department ? \`科室：\${visit.department}\` : "",
        visit.advice ? \`医嘱：\${visit.advice}\` : "",
      ]),
    ]));
  }
  return stack;
}

function renderPrescriptions(detail) {
  if (!detail.prescriptions.length) return el("p", { class: "hint", text: "还没有处方" });
  const rank = { active: 0, paused: 1, stopped: 2, finished: 3 };
  const rows = detail.prescriptions.map((item, index) => ({ item, index }));
  rows.sort((a, b) => (rank[a.item.status] ?? 9) - (rank[b.item.status] ?? 9) || a.index - b.index);
  const stack = el("div", {});
  const badgeKind = { active: "green", paused: "yellow", stopped: "red", finished: "muted" };
  for (const { item } of rows) {
    const status = item.status || "";
    stack.append(el("article", { class: "record" }, [
      item.start_date ? el("div", { class: "date", text: \`\${formatDate(item.start_date)} 开具\` }) : null,
      el("div", { class: "title" }, [
        item.drug_name || "未命名药品",
        badge(RX_LABEL[status] || status || "未知", badgeKind[status] || "muted"),
      ]),
      sentence([
        item.spec ? \`规格：\${item.spec}\` : "",
        item.usage ? \`用法：\${item.usage}\` : "",
        item.end_date ? \`结束：\${formatDate(item.end_date)}\` : "",
      ]),
    ]));
  }
  return stack;
}

function filesFor(detail, reportId) {
  return detail.files.filter((file) => file.lab_report_id === reportId);
}

function renderFileBlock(patientId, file) {
  const kind = fileKind(file);
  if (kind === "image") {
    const button = el("button", {
      type: "button",
      class: "thumb",
      "data-thumb": file.id,
      "aria-label": file.filename || "检查图片",
      onclick: () => openLightbox(patientId, file),
    }, [
      el("span", { class: "thumb-wait", text: "报告图片" }),
    ]);
    return button;
  }
  const name = file.filename || (kind === "pdf" ? "报告.pdf" : "附件");
  const size = formatSize(file.size);
  return el("button", {
    type: "button",
    class: "file-pdf",
    title: size ? \`\${name} · \${size}\` : name,
    onclick: (event) => downloadFile(patientId, file, event.currentTarget),
  }, [
    kind === "pdf" ? "📄" : "📎",
    name,
  ]);
}

function renderReportCard(patientId, report, files) {
  const images = files.filter((file) => fileKind(file) === "image");
  const docs = files.filter((file) => fileKind(file) !== "image");
  const link = /^https?:\\/\\//i.test(report.file_url || "")
    ? el("a", { class: "linkish", href: report.file_url, target: "_blank", rel: "noopener noreferrer", text: "打开链接" })
    : null;
  const attachments = [...images, ...docs];
  return el("article", { class: "record" }, [
    report.report_date ? el("div", { class: "date", text: formatDate(report.report_date) }) : null,
    el("div", { class: "title", text: report.report_type || "检查报告" }),
    report.summary ? el("p", { class: "desc", text: report.summary }) : null,
    link,
    attachments.length ? el("div", { class: "files" }, attachments.map((file) => renderFileBlock(patientId, file))) : null,
    !files.length && !link ? el("p", { class: "hint", text: "没有附件" }) : null,
  ]);
}

function renderLabs(detail) {
  if (!detail.reports.length && !detail.files.length) {
    return el("p", { class: "hint", text: "还没有检查报告" });
  }
  const known = new Set(detail.reports.map((report) => report.id));
  const stack = el("div", { class: "stack" });
  for (const report of detail.reports) stack.append(renderReportCard(detail.patientId, report, filesFor(detail, report.id)));
  const loose = detail.files.filter((file) => !file.lab_report_id || !known.has(file.lab_report_id));
  if (loose.length) {
    stack.append(renderReportCard(detail.patientId, { report_type: "未关联到报告的附件", report_date: "" }, loose));
  }
  return stack;
}

function renderVaccines(detail) {
  if (!detail.vaccinations.length) return el("p", { class: "hint", text: "还没有疫苗记录" });
  const due = dueVaccines(detail.vaccinations);
  const banner = due.length
    ? el("div", { class: "note" }, [
      el("div", { text: due.some((row) => row.overdue) ? \`有 \${due.length} 项待接种，含已逾期\` : \`有 \${due.length} 项待接种\` }),
      el("ul", {}, due.map((row) => el("li", {
        text: [row.vaccine_name, doseText(row), formatDate(row.next_due_at), row.overdue ? "已逾期" : "待接种"].filter(Boolean).join(" · "),
      }))),
    ])
    : null;
  const rows = [...detail.vaccinations].sort((a, b) => String(b.vaccinated_at || b.next_due_at || "").localeCompare(String(a.vaccinated_at || a.next_due_at || "")));
  const stack = el("div", {}, [banner]);
  for (const row of rows) {
    const pending = due.find((item) => item.id === row.id);
    const when = pending ? formatDate(row.next_due_at) : formatDate(row.vaccinated_at);
    const whenLabel = pending ? \`\${when} \${pending.overdue ? "已逾期" : "待接种"}\` : when;
    stack.append(el("article", { class: "record" + (pending ? " is-due" : "") }, [
      whenLabel ? el("div", { class: "date", text: whenLabel }) : null,
      el("div", { class: "title" }, [
        [row.vaccine_name || "未命名疫苗", doseText(row)].filter(Boolean).join(" "),
        pending
          ? badge(pending.overdue ? "已逾期" : "待接种", "yellow")
          : (row.vaccinated_at ? badge("已接种", "green") : null),
      ]),
      sentence([
        pending && row.vaccinated_at ? \`接种日期：\${formatDate(row.vaccinated_at)}\` : "",
        !pending && row.next_due_at ? \`下次接种：\${formatDate(row.next_due_at)}\` : "",
      ]),
    ]));
  }
  return stack;
}

function renderAllergies(detail) {
  if (!detail.allergies.length) return el("p", { class: "hint", text: "还没有过敏史记录" });
  const rank = { severe: 0, moderate: 1, mild: 2 };
  const rows = [...detail.allergies].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const stack = el("div", {});
  for (const item of rows) {
    const severe = item.severity === "severe";
    const moderate = item.severity === "moderate";
    const tone = severe ? " is-severe" : moderate ? " is-moderate" : "";
    const kind = severe ? "red" : moderate ? "yellow" : "green";
    stack.append(el("article", { class: "record" + tone }, [
      el("div", { class: "title" }, [
        item.allergen || "未命名过敏原",
        badge(SEVERITY_LABEL[item.severity] || item.severity || "未知", kind),
      ]),
      sentence([
        item.reaction ? \`反应：\${item.reaction}\` : "",
        item.notes ? \`备注：\${item.notes}\` : "",
      ]),
    ]));
  }
  return stack;
}

function renderChronic(detail) {
  if (!detail.chronic_conditions.length) return el("p", { class: "hint", text: "还没有慢性病记录" });
  const stack = el("div", {});
  const badgeKind = { active: "yellow", managed: "blue", cured: "green" };
  for (const item of detail.chronic_conditions) {
    stack.append(el("article", { class: "record" }, [
      item.diagnosed_date ? el("div", { class: "date", text: \`\${formatDate(item.diagnosed_date)} 确诊\` }) : null,
      el("div", { class: "title" }, [
        item.condition_name || "未命名疾病",
        badge(CHRONIC_STATUS_LABEL[item.status] || item.status || "未知", badgeKind[item.status] || "muted"),
      ]),
      item.notes ? el("p", { class: "desc", text: item.notes }) : null,
    ]));
  }
  return stack;
}

function renderSurgeries(detail) {
  if (!detail.surgeries.length) return el("p", { class: "hint", text: "还没有手术记录" });
  const rows = [...detail.surgeries].sort((a, b) => String(b.surgery_date || "").localeCompare(String(a.surgery_date || "")));
  const stack = el("div", {});
  for (const item of rows) {
    stack.append(el("article", { class: "record" }, [
      item.surgery_date ? el("div", { class: "date", text: formatDate(item.surgery_date) }) : null,
      el("div", { class: "title", text: item.surgery_name || "未命名手术" }),
      sentence([
        item.hospital ? \`医院：\${item.hospital}\` : "",
        item.surgeon ? \`主刀：\${item.surgeon}\` : "",
        item.notes ? \`备注：\${item.notes}\` : "",
      ]),
    ]));
  }
  return stack;
}

function renderContacts(detail) {
  if (!detail.emergency_contacts.length) return el("p", { class: "hint", text: "还没有紧急联系人" });
  const rows = [...detail.emergency_contacts].sort((a, b) => (b.is_primary || 0) - (a.is_primary || 0));
  const stack = el("div", {});
  for (const item of rows) {
    stack.append(el("article", { class: "record" }, [
      el("div", { class: "title" }, [
        item.name || "未命名",
        item.is_primary ? badge("首选", "green") : null,
      ]),
      (() => {
        const line = [item.relationship ? \`关系：\${item.relationship}\` : "", item.phone ? \`电话：\${item.phone}\` : ""].filter(Boolean).join(" · ");
        return line ? el("p", { class: "desc", text: line }) : null;
      })(),
    ]));
  }
  return stack;
}

function severeAllergies(detail) {
  return (detail.allergies || []).filter((a) => a.severity === "severe");
}

const SECTION_TITLE = {
  visits: "📋 就诊记录",
  prescriptions: "💊 处方",
  labs: "🔬 检查报告",
  vaccines: "💉 疫苗接种",
  allergies: "⚠️ 过敏史",
  chronic: "🏥 慢性病史",
  surgeries: "🔪 手术史",
  contacts: "📞 紧急联系人",
};

function renderMain() {
  const main = $("main");
  main.replaceChildren();
  if (state.loadingList && !state.patients.length) {
    main.append(emptyPanel("正在读取病人列表…"));
    return;
  }
  if (!state.patients.length) {
    main.append(emptyPanel("还没有病人。"));
    return;
  }
  if (!state.selectedId) {
    main.append(emptyPanel("从左侧选择一位病人。"));
    return;
  }
  const brief = currentBrief() || {};
  const patient = (state.detail && state.detail.patient) || brief;
  const info = patientInfo(patient);
  const panel = el("div", {}, [
    el("div", { class: "patient-head" }, [
      el("div", { class: "avatar", "aria-hidden": "true", text: String(patient.name || "?").slice(0, 1) }),
      el("div", {}, [
        el("h2", {}, [
          patient.name || "未命名",
          patient.relationship ? el("span", { class: "badge badge-green", text: patient.relationship }) : null,
        ]),
        info ? el("div", { class: "info", text: info }) : null,
      ]),
    ]),
  ]);
  if (state.detailError) panel.append(errorBanner(state.detailError));
  if (state.loadingDetail) {
    panel.append(el("p", { class: "hint", text: "正在读取病历…" }));
    main.append(panel);
    return;
  }
  if (!state.detail) {
    main.append(panel);
    return;
  }
  const severe = severeAllergies(state.detail);
  if (severe.length) {
    panel.append(el("div", { class: "allergy-alert" }, [
      el("span", { class: "allergy-icon", text: "⚠️" }),
      el("div", { class: "allergy-copy" }, [
        el("b", { text: "严重过敏：" }),
        el("span", {
          class: "allergy-detail",
          text: severe.map((a) => a.allergen + (a.reaction ? \`（\${a.reaction}）\` : "")).join("、"),
        }),
      ]),
    ]));
  }
  const due = dueVaccines(state.detail.vaccinations);
  panel.append(el("div", { class: "tabs", role: "tablist" }, TABS.map((tab) => {
    const button = el("button", {
      type: "button",
      role: "tab",
      class: "tab" + (state.tab === tab.id ? " active" : ""),
      id: \`tab-\${tab.id}\`,
      "aria-selected": state.tab === tab.id ? "true" : "false",
      "aria-controls": "tab-panel",
      onclick: () => setTab(tab.id),
      text: tab.label,
    });
    if (tab.id === "vaccines" && due.length) button.append(el("span", { class: "badge badge-yellow", text: String(due.length) }));
    if (tab.id === "allergies" && severe.length) button.append(el("span", { class: "badge badge-red", text: String(severe.length) }));
    return button;
  })));
  const content = state.tab === "visits" ? renderVisits(state.detail)
    : state.tab === "prescriptions" ? renderPrescriptions(state.detail)
    : state.tab === "labs" ? renderLabs(state.detail)
    : state.tab === "vaccines" ? renderVaccines(state.detail)
    : state.tab === "allergies" ? renderAllergies(state.detail)
    : state.tab === "chronic" ? renderChronic(state.detail)
    : state.tab === "surgeries" ? renderSurgeries(state.detail)
    : renderContacts(state.detail);
  const count = state.tab === "visits" && state.detail.visits.length ? \`共 \${state.detail.visits.length} 次\` : "";
  const body = el("section", { class: "section", id: "tab-panel", role: "tabpanel", "aria-labelledby": \`tab-\${state.tab}\` }, [
    el("h3", {}, [
      SECTION_TITLE[state.tab] || "",
      count ? el("span", { class: "count", text: count }) : null,
    ]),
    content,
  ]);
  panel.append(body);
  main.append(panel);
  if (state.tab === "labs") loadThumbs(state.generation);
}

function setTab(id) {
  state.tab = id;
  renderMain();
}

async function selectPatient(id) {
  state.selectedId = id;
  sessionStorage.setItem(SELECT_KEY, id);
  state.detail = null;
  state.detailError = "";
  state.loadingDetail = true;
  const gen = ++state.generation;
  renderChrome();
  renderPatientList();
  renderMain();
  try {
    const data = await api(\`/api/patient?id=\${encodeURIComponent(id)}\`);
    if (gen !== state.generation) return;
    if (data.error) throw new Error(data.error);
    state.dueCounts[id] = dueVaccines(data.vaccinations).length;
    state.detail = { patientId: id, ...data };
    state.detailError = "";
  } catch (err) {
    if (gen !== state.generation) return;
    state.detail = null;
    state.detailError = humanError(err);
  }
  state.loadingDetail = false;
  renderChrome();
  renderPatientList();
  renderMain();
}

async function loadPatients() {
  state.loadingList = true;
  renderMain();
  try {
    const data = await api("/api/patients");
    state.patients = data.patients || [];
    const saved = sessionStorage.getItem(SELECT_KEY) || "";
    const pick = state.patients.some((patient) => patient.id === saved)
      ? saved
      : (state.patients[0] && state.patients[0].id) || "";
    state.loadingList = false;
    renderChrome();
    renderPatientList();
    if (pick) await selectPatient(pick);
    else {
      state.selectedId = "";
      state.detail = null;
      renderMain();
    }
  } catch (err) {
    state.patients = [];
    state.selectedId = "";
    state.detail = null;
    state.loadingDetail = false;
    state.loadingList = false;
    renderChrome();
    renderPatientList();
    const main = $("main");
    main.replaceChildren();
    main.append(emptyPanel(humanError(err)));
  }
}

async function fetchFile(patientId, file) {
  const key = file.id;
  const cached = state.fileCache.get(key);
  if (cached) return cached;
  const data = await api(\`/api/file?patient_id=\${encodeURIComponent(patientId)}&file_id=\${encodeURIComponent(key)}\`);
  const record = {
    filename: data.filename || file.filename,
    mime: data.mime || file.mime || "application/octet-stream",
    content_base64: data.content_base64 || "",
  };
  state.fileCache.set(key, record);
  if (state.fileCache.size > 40) {
    const oldest = state.fileCache.keys().next().value;
    state.fileCache.delete(oldest);
  }
  return record;
}

function bytesFromBase64(b64) {
  const clean = String(b64 || "").replace(/\\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function downloadFile(patientId, file, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "准备中…";
  try {
    const record = await fetchFile(patientId, file);
    const blob = new Blob([bytesFromBase64(record.content_base64)], { type: record.mime });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: safeName(record.filename) });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (err) {
    button.textContent = humanError(err);
    return;
  } finally {
    button.disabled = false;
    if (button.isConnected && button.textContent === "准备中…") button.textContent = original;
  }
  button.textContent = original;
}

async function loadThumbs(gen) {
  const nodes = [...document.querySelectorAll("[data-thumb]")];
  const queue = nodes.map((node) => ({
    node,
    file: (state.detail && state.detail.files || []).find((item) => item.id === node.getAttribute("data-thumb")),
  })).filter((item) => item.file);
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length && gen === state.generation) {
      const { node, file } = queue.shift();
      if (!node.isConnected) continue;
      try {
        const record = await fetchFile(state.detail.patientId, file);
        if (gen !== state.generation || !node.isConnected) continue;
        const img = el("img", {
          alt: record.filename || "检查图片",
          src: \`data:\${record.mime};base64,\${record.content_base64}\`,
        });
        node.replaceChildren(img);
      } catch {
        if (node.isConnected) {
          const wait = node.querySelector(".thumb-wait");
          if (wait) wait.textContent = "无法预览";
        }
      }
    }
  });
  await Promise.all(workers);
}

async function openLightbox(patientId, file) {
  try {
    const cached = state.fileCache.get(file.id) || await fetchFile(patientId, file);
    state.lightboxFile = { patientId, file };
    $("lightbox-img").src = \`data:\${cached.mime};base64,\${cached.content_base64}\`;
    $("lightbox-img").alt = cached.filename || "检查图片";
    $("lightbox-name").textContent = cached.filename || "检查图片";
    $("lightbox").hidden = false;
  } catch (err) {
    const node = document.querySelector(\`[data-thumb="\${CSS.escape(file.id)}"] .thumb-wait\`);
    if (node) node.textContent = humanError(err);
  }
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightbox-img").removeAttribute("src");
  state.lightboxFile = null;
}

function init() {
  $("search").addEventListener("input", renderPatientList);
  $("lightbox-close").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) closeLightbox();
  });
  $("lightbox-download").addEventListener("click", (event) => {
    if (!state.lightboxFile) return;
    downloadFile(state.lightboxFile.patientId, state.lightboxFile.file, event.currentTarget);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeLightbox();
  });
  renderChrome();
  renderPatientList();
  renderMain();
  loadPatients();
}

init();
`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

async function getPatients(env) {
  const r = await env.DB.prepare(
    "SELECT id, name, relationship, dob, notes, created_at FROM patients ORDER BY created_at DESC"
  ).all();
  return { patients: r.results || [] };
}

async function getPatient(env, id) {
  if (!id) return null;
  const patient = await env.DB.prepare(
    "SELECT id, name, relationship, dob, notes, created_at FROM patients WHERE id=?"
  ).bind(id).first();
  if (!patient) return null;
  const q = (sql) => env.DB.prepare(sql).bind(id).all().then((r) => r.results || []);
  const [visits, prescriptions, reports, files, vaccinations, allergies, chronic_conditions, surgeries, emergency_contacts] =
    await Promise.all([
      q("SELECT * FROM visits WHERE patient_id=? ORDER BY visit_date DESC"),
      q("SELECT * FROM prescriptions WHERE patient_id=? ORDER BY created_at DESC"),
      q("SELECT id, patient_id, report_date, report_type, summary, file_url, created_at FROM lab_reports WHERE patient_id=? ORDER BY report_date DESC"),
      q("SELECT id, patient_id, lab_report_id, filename, mime, size, created_at FROM lab_report_files WHERE patient_id=? ORDER BY created_at DESC"),
      q("SELECT * FROM vaccinations WHERE patient_id=? ORDER BY vaccinated_at DESC"),
      q("SELECT * FROM allergies WHERE patient_id=? ORDER BY created_at DESC"),
      q("SELECT * FROM chronic_conditions WHERE patient_id=? ORDER BY created_at DESC"),
      q("SELECT * FROM surgeries WHERE patient_id=? ORDER BY surgery_date DESC"),
      q("SELECT * FROM emergency_contacts WHERE patient_id=? ORDER BY is_primary DESC, created_at DESC"),
    ]);
  return { patient, visits, prescriptions, reports, files, vaccinations, allergies, chronic_conditions, surgeries, emergency_contacts };
}

function bytesToBase64(bytes) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

async function getFile(env, patientId, fileId) {
  if (!patientId || !fileId) return null;
  const row = await env.DB.prepare(
    "SELECT id, patient_id, lab_report_id, filename, mime, size, r2_key FROM lab_report_files WHERE id=? AND patient_id=?"
  ).bind(fileId, patientId).first();
  const prefix = `patients/${patientId}/`;
  if (!row || typeof row.r2_key !== "string" || !row.r2_key.startsWith(prefix)) return null;
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return null;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API
    if (path === "/api/patients") {
      try {
        return json(await getPatients(env));
      } catch (e) {
        return json({ error: "internal error" }, 500);
      }
    }
    if (path === "/api/patient") {
      const id = url.searchParams.get("id");
      if (!id) return badRequest("id_required");
      try {
        const data = await getPatient(env, id);
        if (!data) return json({ error: "patient_not_found" }, 404);
        return json(data);
      } catch (e) {
        return json({ error: "internal error" }, 500);
      }
    }
    if (path === "/api/file") {
      const patientId = url.searchParams.get("patient_id");
      const fileId = url.searchParams.get("file_id");
      if (!patientId || !fileId) return badRequest("patient_id and file_id required");
      try {
        const data = await getFile(env, patientId, fileId);
        if (!data) return json({ error: "file_not_found" }, 404);
        return json(data);
      } catch (e) {
        return json({ error: "internal error" }, 500);
      }
    }

    // Static
    if (path === "/" || path === "/index.html") {
      return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/style.css") {
      return new Response(STYLE_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/app.js") {
      return new Response(APP_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
