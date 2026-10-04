#!/usr/bin/env node
// abot-health 唯一的构建/部署入口，由 Cloudflare 控制台（Workers Builds）调用。
//
//   node scripts/cf-build.mjs <abot-health|abot-health-viewer|all>            测试 + 打包校验（dry-run，不上传）
//   node scripts/cf-build.mjs <abot-health|abot-health-viewer> --deploy       测试 + 部署，仅限 Workers Builds 的生产分支
//
// 部署前依次：校验查看页嵌入内容与源文件一致 → 跑全部测试 → 生成 .build/<worker>/worker.js
// → wrangler dry-run 校验配置 → wrangler deploy。任何一步失败都不会上传。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_BRANCH = "main";
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const WORKERS = {
  "abot-health": { entry: "src/worker.js" },
  "abot-health-viewer": { entry: "pages/worker.js" },
};

function fail(msg) {
  console.error(`\n[cf-build] ${msg}`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n[cf-build] ${msg}`);
}

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

function parseArgs(argv) {
  const deploy = argv.includes("--deploy");
  const names = argv.filter((a) => !a.startsWith("--"));
  if (names.length !== 1) fail(`用法：cf-build.mjs <${Object.keys(WORKERS).join("|")}|all> [--deploy]`);
  const target = names[0];
  if (target === "all") {
    if (deploy) fail("--deploy 一次只能部署一个 Worker");
    return { deploy, targets: Object.keys(WORKERS) };
  }
  if (!WORKERS[target]) fail(`未知 Worker：${target}`);
  return { deploy, targets: [target] };
}

// 部署只在 Cloudflare Workers Builds 的生产分支构建里放行，本地和其他分支一律拒绝。
function assertDeployContext() {
  if (process.env.WORKERS_CI !== "1") {
    fail("拒绝部署：只能由 Cloudflare 控制台的 Workers Builds 触发（WORKERS_CI 未设置）。本地请用 npm run build 做校验。");
  }
  const branch = process.env.WORKERS_CI_BRANCH || "";
  if (branch !== PRODUCTION_BRANCH) {
    fail(`拒绝部署：当前分支 ${branch || "(未知)"} 不是生产分支 ${PRODUCTION_BRANCH}。`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(process.env.WORKERS_CI_COMMIT_SHA || "")) {
    fail("拒绝部署：缺少 WORKERS_CI_COMMIT_SHA。");
  }
}

function checkPagesBundle() {
  const bundled = readFileSync(join(ROOT, "pages", "worker.js"), "utf8");
  for (const [name, file] of [["INDEX_HTML", "index.html"], ["STYLE_CSS", "style.css"]]) {
    const src = readFileSync(join(ROOT, "pages", file), "utf8").replace(/\n$/, "");
    if (!bundled.includes(`const ${name} = \`${src}\n\`;`)) {
      fail(`pages/worker.js 里的 ${name} 与 pages/${file} 不一致，请先运行 python3 sync-pages.py 并提交。`);
    }
  }
}

function main() {
  const { deploy, targets } = parseArgs(process.argv.slice(2));
  if (deploy) assertDeployContext();

  step("校验查看页嵌入内容");
  checkPagesBundle();

  step("运行测试");
  for (const t of ["test/basic.js", "test/viewer.js", "test/e2e.js"]) {
    run(process.execPath, [t]);
  }

  for (const name of targets) {
    const config = join("deploy", name, "wrangler.jsonc");
    const outDir = join(ROOT, ".build", name);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(join(ROOT, WORKERS[name].entry), join(outDir, "worker.js"));

    step(`${name}：wrangler dry-run 校验`);
    run(process.execPath, [WRANGLER, "deploy", "-c", config, "--dry-run", "--outdir", join(outDir, "dist")]);

    if (deploy) {
      const sha = process.env.WORKERS_CI_COMMIT_SHA;
      step(`${name}：部署 ${sha.slice(0, 7)}`);
      run(process.execPath, [WRANGLER, "deploy", "-c", config,
        "--tag", sha.slice(0, 12), "--message", `Workers Builds ${process.env.WORKERS_CI_BUILD_UUID || ""} ${sha}`.trim()]);
    }
  }
  step(deploy ? "部署完成" : "校验通过（未部署）");
}

main();
