const API_URL = "https://health.abot.run/mcp";
const TOKEN_KEY = "abot-health-token";
const EMAIL_KEY = "abot-health-owner-email";
const SELECT_KEY = "abot-health-selected";

const TABS = [
  { id: "visits", label: "就诊记录" },
  { id: "prescriptions", label: "处方" },
  { id: "labs", label: "检查报告" },
  { id: "vaccines", label: "疫苗" },
];

const RX_LABEL = {
  active: "在用",
  finished: "已吃完",
  stopped: "已停",
  paused: "暂停",
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

let rpcId = 0;

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

function persistAuth() {
  localStorage.setItem(TOKEN_KEY, $("token").value.trim());
  localStorage.setItem(EMAIL_KEY, $("email").value.trim());
}

function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
function email() { return localStorage.getItem(EMAIL_KEY) || ""; }

function setAuth(text, isError) {
  const node = $("auth-status");
  node.textContent = text;
  node.classList.toggle("is-error", !!isError);
}

function humanError(err) {
  const msg = String((err && err.message) || err || "");
  if (msg === "unauthorized") return "鉴权失败，请检查访问令牌和账号邮箱";
  if (msg === "owner email required") return "请填写账号邮箱";
  if (msg === "patient_not_found") return "找不到这位病人";
  if (msg.startsWith("unknown tool")) return "服务暂时没有这个接口";
  return msg || "请求失败";
}

async function mcp(name, args) {
  const headers = {
    "content-type": "application/json",
    "X-Internal-Token": token(),
    "X-Abot-Owner-Email": email(),
  };
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args || {} },
      }),
    });
  } catch {
    throw new Error("无法连接 health.abot.run");
  }
  let body;
  try { body = await res.json(); }
  catch { throw new Error("服务返回了无法识别的内容"); }
  if (!res.ok) {
    const err = body && body.error;
    const msg = typeof err === "string" ? err : (err && err.message) || "";
    throw new Error(msg || "请求失败");
  }
  if (body.error) throw new Error(body.error.message || "请求失败");
  const text = body.result && body.result.content && body.result.content[0] && body.result.content[0].text;
  if (typeof text !== "string") throw new Error("服务返回了空结果");
  try { return JSON.parse(text); }
  catch { throw new Error("服务返回了无法识别的内容"); }
}

function parseDay(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
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
  return `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
}

function ageFromDob(dob) {
  const birth = parseDay(dob);
  if (!birth) return "";
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const month = now.getMonth() - birth.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? `${age} 岁` : "";
}

function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(name) {
  const base = String(name || "文件").split(/[/\\]/).pop() || "文件";
  return base.replace(/[\u0000-\u001f"]/g, "").slice(0, 200) || "文件";
}

function fileKind(file) {
  const mime = String(file.mime || "");
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(file.filename || "")) return "pdf";
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
  if (row.total_doses != null) return `第 ${row.dose_number || "?"} / ${row.total_doses} 剂`;
  return `第 ${row.dose_number} 剂`;
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

function closeSidebar() {
  $("sidebar").classList.remove("is-open");
  $("backdrop").hidden = true;
  $("menu-btn").setAttribute("aria-expanded", "false");
}

function openSidebar() {
  $("sidebar").classList.add("is-open");
  $("backdrop").hidden = false;
  $("menu-btn").setAttribute("aria-expanded", "true");
  $("search").focus();
}

function renderChrome() {
  const current = currentBrief();
  $("menu-btn").textContent = current ? current.name : "病人";
  $("patient-count").textContent = state.patients.length ? `${state.patients.length} 人` : "";
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
    const button = el("button", {
      type: "button",
      class: "patient" + (patient.id === state.selectedId ? " is-selected" : ""),
      role: "option",
      "aria-selected": patient.id === state.selectedId ? "true" : "false",
      onclick: () => selectPatient(patient.id),
    }, [
      el("span", { class: "avatar", text: String(patient.name || "?").slice(0, 1) }),
      el("span", { class: "patient-copy" }, [
        el("span", { class: "patient-name", text: patient.name || "未命名" }),
        el("span", {
          class: "patient-sub",
          text: [patient.relationship, formatDate(patient.dob)].filter(Boolean).join(" · ") || "未填写关系",
        }),
      ]),
    ]);
    if (state.dueCounts[patient.id]) button.append(el("span", { class: "due-dot", title: "有待接种疫苗" }));
    list.append(button);
  }
}

function emptyPanel(text) {
  return el("section", { class: "empty", text });
}

function errorBanner(text) {
  return text ? el("div", { class: "error-banner", text }) : null;
}

function meta(label, value) {
  if (!value) return null;
  return el("div", {}, [
    el("span", { class: "meta-label", text: label }),
    el("span", { class: "meta-value", text: value }),
  ]);
}

function renderVisits(detail) {
  if (detail.errors.visits) return errorBanner(detail.errors.visits);
  if (!detail.visits.length) return el("p", { class: "hint", text: "还没有就诊记录" });
  const stack = el("div", { class: "stack" });
  for (const visit of detail.visits) {
    stack.append(el("article", { class: "card visit" }, [
      el("h3", { text: formatDate(visit.visit_date) || "未填日期" }),
      el("div", { class: "meta-grid" }, [
        meta("医院", visit.hospital),
        meta("科室", visit.department),
        meta("主诉", visit.complaint),
        meta("诊断", visit.diagnosis),
        meta("医嘱", visit.advice),
      ]),
    ]));
  }
  return stack;
}

function renderPrescriptions(detail) {
  if (detail.errors.prescriptions) return errorBanner(detail.errors.prescriptions);
  if (!detail.prescriptions.length) return el("p", { class: "hint", text: "还没有处方" });
  const rank = { active: 0, paused: 1, stopped: 2, finished: 3 };
  const rows = detail.prescriptions.map((item, index) => ({ item, index }));
  rows.sort((a, b) => (rank[a.item.status] ?? 9) - (rank[b.item.status] ?? 9) || a.index - b.index);
  const stack = el("div", { class: "stack" });
  for (const { item } of rows) {
    const status = item.status || "";
    const statusClass = Object.prototype.hasOwnProperty.call(RX_LABEL, status) ? status : "muted";
    stack.append(el("article", { class: "card" }, [
      el("div", { class: "rx-head" }, [
        el("h3", { text: item.drug_name || "未命名药品" }),
        el("span", { class: `pill pill-${statusClass}`, text: RX_LABEL[status] || status || "未知" }),
      ]),
      el("div", { class: "meta-grid" }, [
        meta("规格", item.spec),
        meta("用法", item.usage),
        meta("开始", formatDate(item.start_date)),
        meta("结束", formatDate(item.end_date)),
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
      "data-thumb": file.file_id,
      onclick: () => openLightbox(patientId, file),
    }, [
      el("span", { class: "thumb-wait", text: "加载中" }),
      el("span", { text: file.filename || "图片" }),
    ]);
    return button;
  }
  const label = kind === "pdf" ? "下载 PDF" : "下载";
  return el("div", { class: "file-row" }, [
    el("span", { class: "file-name", text: [file.filename || "附件", formatSize(file.size)].filter(Boolean).join(" · ") }),
    el("button", {
      type: "button",
      text: label,
      onclick: (event) => downloadFile(patientId, file, event.currentTarget),
    }),
  ]);
}

function renderReportCard(patientId, report, files) {
  const images = files.filter((file) => fileKind(file) === "image");
  const docs = files.filter((file) => fileKind(file) !== "image");
  const link = /^https?:\/\//i.test(report.file_url || "")
    ? el("a", { class: "linkish", href: report.file_url, target: "_blank", rel: "noopener noreferrer", text: "打开链接" })
    : null;
  return el("article", { class: "card" }, [
    el("div", { class: "lab-head" }, [
      el("h3", { text: report.report_type || "检查报告" }),
      el("span", { class: "hint", text: formatDate(report.report_date) }),
    ]),
    report.summary ? el("p", { text: report.summary }) : null,
    link,
    images.length ? el("div", { class: "thumbs" }, images.map((file) => renderFileBlock(patientId, file))) : null,
    docs.length ? el("div", { class: "files" }, docs.map((file) => renderFileBlock(patientId, file))) : null,
    !files.length && !link ? el("p", { class: "hint", text: "没有附件" }) : null,
  ]);
}

function renderLabs(detail) {
  const parts = [];
  if (detail.errors.reports) parts.push(errorBanner(detail.errors.reports));
  if (detail.errors.files) parts.push(errorBanner(detail.errors.files));
  if (!detail.errors.reports && !detail.reports.length && !detail.files.length) {
    parts.push(el("p", { class: "hint", text: "还没有检查报告" }));
  }
  const known = new Set(detail.reports.map((report) => report.id));
  const stack = el("div", { class: "stack" });
  for (const report of detail.reports) stack.append(renderReportCard(detail.patientId, report, filesFor(detail, report.id)));
  const loose = detail.files.filter((file) => !file.lab_report_id || !known.has(file.lab_report_id));
  if (loose.length) {
    stack.append(renderReportCard(detail.patientId, { report_type: "未关联到报告的附件", report_date: "" }, loose));
  }
  if (stack.childNodes.length) parts.push(stack);
  return el("div", { class: "stack" }, parts);
}

function renderVaccines(detail) {
  if (detail.errors.vaccinations) return errorBanner(detail.errors.vaccinations);
  if (!detail.vaccinations.length) return el("p", { class: "hint", text: "还没有疫苗记录" });
  const due = dueVaccines(detail.vaccinations);
  const banner = due.length
    ? el("div", { class: "due-banner" }, [
      el("h3", { text: due.some((row) => row.overdue) ? `有 ${due.length} 项待接种，含已逾期` : `有 ${due.length} 项待接种` }),
      el("ul", {}, due.map((row) => el("li", {
        text: [row.vaccine_name, doseText(row), formatDate(row.next_due_at), row.overdue ? "已逾期" : "待接种"].filter(Boolean).join(" · "),
      }))),
    ])
    : null;
  const rows = [...detail.vaccinations].sort((a, b) => String(b.vaccinated_at || b.next_due_at || "").localeCompare(String(a.vaccinated_at || a.next_due_at || "")));
  const stack = el("div", { class: "stack" }, [banner]);
  for (const row of rows) {
    const pending = due.find((item) => item.id === row.id);
    stack.append(el("article", { class: "card vax" + (pending ? " is-due" : "") }, [
      el("div", { class: "vax-head" }, [
        el("h3", {}, [
          row.vaccine_name || "未命名疫苗",
          pending ? el("span", { class: "tag", text: pending.overdue ? "已逾期" : "待接种" }) : null,
        ]),
        doseText(row) ? el("span", { class: "hint", text: doseText(row) }) : null,
      ]),
      el("div", { class: "meta-grid" }, [
        meta("接种日期", formatDate(row.vaccinated_at)),
        meta("下次接种", formatDate(row.next_due_at)),
      ]),
    ]));
  }
  return stack;
}

function renderMain() {
  const main = $("main");
  main.replaceChildren();
  if (!token() || !email()) {
    main.append(emptyPanel("填写上方的访问令牌和账号邮箱，连接后即可查看病历。"));
    return;
  }
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
  const headBits = [formatDate(patient.dob), ageFromDob(patient.dob)].filter(Boolean);
  const panel = el("section", { class: "panel" }, [
    el("header", { class: "patient-head" }, [
      el("div", {}, [
        el("h2", { text: patient.name || "未命名" }),
        headBits.length ? el("p", { class: "subline", text: headBits.join(" · ") }) : null,
        patient.notes ? el("p", { class: "notes", text: patient.notes }) : null,
      ]),
      patient.relationship ? el("span", { class: "pill", text: patient.relationship }) : null,
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
  const due = state.detail.errors.vaccinations ? [] : dueVaccines(state.detail.vaccinations);
  panel.append(el("div", { class: "tabs", role: "tablist" }, TABS.map((tab) => {
    const button = el("button", {
      type: "button",
      role: "tab",
      id: `tab-${tab.id}`,
      "aria-selected": state.tab === tab.id ? "true" : "false",
      "aria-controls": "tab-panel",
      onclick: () => setTab(tab.id),
      text: tab.label,
    });
    if (tab.id === "vaccines" && due.length) button.append(el("span", { class: "badge", text: String(due.length) }));
    return button;
  })));
  const body = el("div", { id: "tab-panel", role: "tabpanel", "aria-labelledby": `tab-${state.tab}` });
  if (state.tab === "visits") body.append(renderVisits(state.detail));
  else if (state.tab === "prescriptions") body.append(renderPrescriptions(state.detail));
  else if (state.tab === "labs") body.append(renderLabs(state.detail));
  else body.append(renderVaccines(state.detail));
  panel.append(body);
  main.append(panel);
  if (state.tab === "labs") loadThumbs(state.generation);
}

function setTab(id) {
  state.tab = id;
  renderMain();
}

function unpack(result, pick, fallback) {
  if (result.status === "fulfilled") return { data: pick(result.value) || fallback, error: "" };
  return { data: fallback, error: humanError(result.reason) };
}

async function selectPatient(id) {
  state.selectedId = id;
  sessionStorage.setItem(SELECT_KEY, id);
  state.detail = null;
  state.detailError = "";
  state.loadingDetail = true;
  const gen = ++state.generation;
  closeSidebar();
  renderChrome();
  renderPatientList();
  renderMain();
  if (!token() || !email()) {
    state.loadingDetail = false;
    renderMain();
    return;
  }
  const args = { patient_id: id };
  const [patientR, visitR, rxR, labR, fileR, vaxR] = await Promise.allSettled([
    mcp("get_patient", args),
    mcp("list_visits", args),
    mcp("list_prescriptions", args),
    mcp("list_lab_reports", args),
    mcp("list_lab_report_files", args),
    mcp("list_vaccinations", args),
  ]);
  if (gen !== state.generation) return;
  const patient = unpack(patientR, (value) => value.patient, null);
  const visits = unpack(visitR, (value) => value.visits, []);
  const prescriptions = unpack(rxR, (value) => value.prescriptions, []);
  const reports = unpack(labR, (value) => value.lab_reports, []);
  const files = unpack(fileR, (value) => value.files, []);
  const vaccinations = unpack(vaxR, (value) => value.vaccinations, []);
  const errors = [patient.error, visits.error, prescriptions.error, reports.error, files.error, vaccinations.error].filter(Boolean);
  if (!vaccinations.error) state.dueCounts[id] = dueVaccines(vaccinations.data).length;
  if (errors.length === 6) {
    state.detail = null;
    state.detailError = errors[0];
  } else {
    state.detail = {
      patientId: id,
      patient: patient.data || currentBrief(),
      visits: visits.data,
      prescriptions: prescriptions.data,
      reports: reports.data,
      files: files.data,
      vaccinations: vaccinations.data,
      errors: {
        patient: patient.error,
        visits: visits.error,
        prescriptions: prescriptions.error,
        reports: reports.error,
        files: files.error,
        vaccinations: vaccinations.error,
      },
    };
    state.detailError = patient.error || "";
  }
  state.loadingDetail = false;
  renderChrome();
  renderPatientList();
  renderMain();
}

async function loadPatients() {
  persistAuth();
  if (!token()) { setAuth("请填写访问令牌", true); return; }
  if (!email()) { setAuth("请填写账号邮箱", true); return; }
  state.loadingList = true;
  setAuth("正在连接…", false);
  $("connect").disabled = true;
  renderMain();
  try {
    const data = await mcp("list_patients", {});
    state.patients = data.patients || [];
    setAuth(`已连接，${state.patients.length} 位病人`, false);
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
    state.loadingList = false;
    setAuth(humanError(err), true);
    renderChrome();
    renderPatientList();
    renderMain();
  } finally {
    $("connect").disabled = false;
  }
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
  sessionStorage.removeItem(SELECT_KEY);
  $("token").value = "";
  $("email").value = "";
  state.patients = [];
  state.selectedId = "";
  state.detail = null;
  state.dueCounts = {};
  state.fileCache.clear();
  state.generation += 1;
  setAuth("已清除本机保存的令牌和邮箱。", false);
  renderChrome();
  renderPatientList();
  renderMain();
}

async function fetchFile(patientId, file) {
  const cached = state.fileCache.get(file.file_id);
  if (cached) return cached;
  const data = await mcp("get_lab_report_file", { patient_id: patientId, file_id: file.file_id });
  const record = {
    filename: data.filename || file.filename,
    mime: data.mime || file.mime || "application/octet-stream",
    content_base64: data.content_base64 || "",
  };
  state.fileCache.set(file.file_id, record);
  if (state.fileCache.size > 40) {
    const oldest = state.fileCache.keys().next().value;
    state.fileCache.delete(oldest);
  }
  return record;
}

function bytesFromBase64(b64) {
  const clean = String(b64 || "").replace(/\s/g, "");
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
    file: (state.detail && state.detail.files || []).find((item) => item.file_id === node.getAttribute("data-thumb")),
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
          src: `data:${record.mime};base64,${record.content_base64}`,
        });
        const caption = node.querySelector("span:last-child");
        node.replaceChildren(img);
        if (caption) node.append(caption);
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
    const cached = state.fileCache.get(file.file_id) || await fetchFile(patientId, file);
    state.lightboxFile = { patientId, file };
    $("lightbox-img").src = `data:${cached.mime};base64,${cached.content_base64}`;
    $("lightbox-img").alt = cached.filename || "检查图片";
    $("lightbox-name").textContent = cached.filename || "检查图片";
    $("lightbox").hidden = false;
  } catch (err) {
    const node = document.querySelector(`[data-thumb="${CSS.escape(file.file_id)}"] .thumb-wait`);
    if (node) node.textContent = humanError(err);
  }
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightbox-img").removeAttribute("src");
  state.lightboxFile = null;
}

function init() {
  $("token").value = token();
  $("email").value = email();
  $("auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadPatients();
  });
  $("token").addEventListener("input", persistAuth);
  $("email").addEventListener("input", persistAuth);
  $("reveal").addEventListener("click", () => {
    const input = $("token");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("reveal").textContent = show ? "隐藏" : "显示";
  });
  $("clear-auth").addEventListener("click", clearAuth);
  $("search").addEventListener("input", renderPatientList);
  $("menu-btn").addEventListener("click", () => {
    if ($("sidebar").classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  $("backdrop").addEventListener("click", closeSidebar);
  $("lightbox-close").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) closeLightbox();
  });
  $("lightbox-download").addEventListener("click", (event) => {
    if (!state.lightboxFile) return;
    downloadFile(state.lightboxFile.patientId, state.lightboxFile.file, event.currentTarget);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLightbox();
      closeSidebar();
    }
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) closeSidebar();
  });
  renderChrome();
  renderPatientList();
  renderMain();
  if (token() && email()) loadPatients();
}

init();
