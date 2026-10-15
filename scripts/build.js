/**
 * LegspCpd/friends 构建脚本
 *
 * 扫描 data/friends/*.json → 校验 → 排序 → 输出仓库根目录的 friends.json
 *
 * 设计要点：
 *  - 任何一个文件校验失败都会让整体构建失败，绝不静默跳过（宁可失败也不产出缺人的列表）
 *  - 输出写到仓库根目录并被提交，供站点通过 GitHub API 取用
 *  - 校验函数通过 module.exports 暴露，便于单测
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_FRIENDS = path.join(ROOT, "data", "friends");
const OUT_FILE = path.join(ROOT, "friends.json");

const LIMITS = { name: 60, description: 100, tag: 20, tags: 5 };

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function isNullOrString(v) { return v === null || typeof v === "string"; }

/** 只接受 http/https 绝对 URL —— 防止 javascript: / data: 之类注入 */
function isHttpUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) { return false; }
}

function validateEntry(d) {
  const errs = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["内容必须是一个 JSON 对象"];
  if (!isNonEmptyString(d.name)) errs.push("name 必需且非空");
  else if (d.name.length > LIMITS.name) errs.push("name 过长（上限 " + LIMITS.name + "）");
  if (!isNullOrString(d.avatar)) errs.push("avatar 必须是字符串或 null");
  else if (typeof d.avatar === "string" && !isHttpUrl(d.avatar)) errs.push("avatar 必须是 http(s) 绝对 URL");
  if (d.description !== undefined) {
    if (typeof d.description !== "string") errs.push("description 必须是字符串");
    else if (d.description.length > LIMITS.description) errs.push("description 过长（上限 " + LIMITS.description + "）");
  }
  if (!isHttpUrl(d.url)) errs.push("url 必需且必须是 http(s) 绝对 URL");
  if (d.backlink !== undefined && !isHttpUrl(d.backlink)) errs.push("backlink 必须是 http(s) 绝对 URL");
  if (d.tags !== undefined) {
    if (!Array.isArray(d.tags)) errs.push("tags 必须是数组");
    else if (d.tags.length > LIMITS.tags) errs.push("tags 最多 " + LIMITS.tags + " 项");
    else for (const t of d.tags) {
      if (!isNonEmptyString(t)) errs.push("tags 每一项都必须是非空字符串");
      else if (t.length > LIMITS.tag) errs.push("tags 项过长（上限 " + LIMITS.tag + "）：" + t);
    }
  }
  for (const k of Object.keys(d)) {
    if (["name","avatar","description","url","backlink","tags"].indexOf(k) === -1) {
      errs.push("存在未知字段：" + k);
    }
  }
  return errs;
}

/** 归一化 URL 用于去重：去尾斜杠、主机小写 */
function dedupeKey(url) {
  try {
    const u = new URL(url);
    return (u.protocol + "//" + u.host.toLowerCase() + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch (e) { return String(url).toLowerCase(); }
}

function loadFriends(dir) {
  if (!fs.existsSync(dir)) throw new Error("目录不存在: " + dir);
  const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json"); }).sort();
  const entries = [];
  const problems = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch (e) { problems.push(f + "：JSON 解析失败 —— " + e.message); continue; }
    const errs = validateEntry(data);
    if (errs.length) { problems.push(f + "：" + errs.join("；")); continue; }
    entries.push({ file: f, data: data });
  }
  if (problems.length) {
    console.error("\n校验失败，本次不产出新的 friends.json：");
    for (const p of problems) console.error("  ✗ " + p);
    throw new Error(problems.length + " 个文件未通过校验");
  }
  const seen = new Map();
  for (const e of entries) {
    const k = dedupeKey(e.data.url);
    if (seen.has(k)) {
      console.error("\n站点重复：" + e.file + " 与 " + seen.get(k) + " 的 url 相同（" + e.data.url + "）");
      throw new Error("存在重复站点");
    }
    seen.set(k, e.file);
  }
  return entries.map(function (e) { return e.data; });
}

/** 按名称排序（中文按拼音） */
function sortFriends(list) {
  return list.slice().sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name), "zh-CN");
  });
}

function build() {
  console.log("\n📦 读取 data/friends ...");
  const list = sortFriends(loadFriends(DATA_FRIENDS));
  fs.writeFileSync(OUT_FILE, JSON.stringify(list, null, 2) + "\n", "utf8");
  console.log("   ✓ 共 " + list.length + " 条");
  console.log("   → " + path.relative(ROOT, OUT_FILE));
  return list;
}

module.exports = { validateEntry, dedupeKey, sortFriends, loadFriends, build, LIMITS };

if (require.main === module) {
  try { build(); } catch (e) { console.error("\n❌ 构建失败：" + e.message + "\n"); process.exit(1); }
}
