/**
 * 回链检查的纯逻辑部分 —— 不依赖 Playwright，可本地单测。
 *
 * 设计：Playwright 只负责「把页面拿到手」（渲染 JS、绕开部分反爬），
 * 本模块只负责「在拿到的 HTML 里找链接」。职责分离，便于测试。
 */
const path = require("path");

// 复用构建脚本里的字段校验，保证「构建」与「PR 检查」用同一套规则，不会分叉
const build = require(path.join(__dirname, "..", "..", "scripts", "build.js"));

/** 内网/本机地址 —— 不允许 CI 去抓，避免 SSRF */
// 注意：这里只做主机名层面的拦截。严格做法还应解析 DNS 后校验真实 IP，
// 但对于「检查公开博客是否有回链」这一用途，主机名拦截已能挡住常见误配，
// 且待抓取地址来自 PR 提交者填写的公开站点。
const PRIVATE_HOST =
	/^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[?::1\]?|(?:.+)\.local)$/i;

function isSafeHttpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return false;
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (PRIVATE_HOST.test(u.hostname)) return false;
  return true;
}

/** 归一化：去 fragment、去尾斜杠、主机与小写化，便于比较 */
function normalizeUrl(raw) {
  if (typeof raw !== "string") return "";
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    const p = u.pathname.replace(/\/+$/, "");
    return (u.protocol + "//" + u.host + p + (u.search || "")).toLowerCase();
  } catch (e) {
    return String(raw).trim().toLowerCase().replace(/\/+$/, "");
  }
}

/** 取出 HTML 里所有 href（两种写法：带引号 / 不带引号） */
function extractHrefs(html) {
  const out = [];
  if (typeof html !== "string") return out;
  const patterns = [/href\s*=\s*["']([^"']+)["']/gi, /href\s*=\s*([^\s>]+)/gi];
  for (const re of patterns) {
    let m;
    const rx = new RegExp(re.source, re.flags);
    while ((m = rx.exec(html)) !== null) {
      const href = (m[1] || "").trim();
      if (href) out.push(href);
    }
  }
  return out;
}

/**
 * 判断 HTML 里是否已经放了指向本站的链接。
 * aliases 中的任一条命中即算通过（本站有多个域名）。
 */
function verifyBacklink(html, aliases) {
  const accepted = new Set((aliases || []).map(normalizeUrl).filter(Boolean));
  const hrefs = extractHrefs(html);
  const external = [];
  for (const h of hrefs) {
    if (!/^https?:/i.test(h)) continue;
    external.push(h);
    if (accepted.has(normalizeUrl(h))) {
      return { found: true, matchedHref: h, total: hrefs.length };
    }
  }
  return { found: false, matchedHref: null, total: hrefs.length, sample: external.slice(0, 20) };
}

/** 生成给申请人看的调试信息 */
function formatDebug(result) {
  if (result.found) return "- 已找到指向本站的链接：`" + result.matchedHref + "`";
  const lines = ["- 在页面里**没有找到**指向本站的链接。"];
  if (result.error) lines.push("- 抓取情况：" + result.error);
  if (result.sample && result.sample.length) {
    lines.push("- 抓到的前 " + result.sample.length + " 个外部链接（供你自查）：");
    for (const s of result.sample) lines.push("  - `" + s + "`");
  }
  return lines.join("\n");
}

module.exports = { isSafeHttpUrl, normalizeUrl, extractHrefs, verifyBacklink, formatDebug, validateEntry: build.validateEntry };
