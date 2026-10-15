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

/**
 * 从页面内容本身识别「这是人机验证/拦截页，不是真实内容」。
 *
 * 为什么必须看内容而不能只看抓取方式：实测中 Playwright 能正常打开被 Anubis
 * 保护的站点，但返回的仍是挑战页 HTML —— 「浏览器成功」并不等于「拿到了真实页面」。
 */
const CHALLENGE_SIGNATURES = [
	{ name: "Anubis", re: /making sure you.{0,3}re not a bot/i },
	{ name: "Anubis", re: /\/cdn-cgi\/content\?id=/i },
	{ name: "Anubis", re: /TecharoHQ/i },
	{ name: "Cloudflare", re: /just a moment/i },
	{ name: "Cloudflare", re: /challenges\.cloudflare\.com/i },
	{ name: "Cloudflare", re: /cf[-_]chl[-_]|__cf_chl/i },
	{ name: "Cloudflare", re: /enable javascript and cookies to continue/i },
	{ name: "DDoS-Guard", re: /ddos-guard|__ddg/i },
];

function detectChallenge(html) {
	if (typeof html !== "string" || !html) return { detected: false, name: null };
	// 只看前 20KB：挑战页很短，避免正文里的偶发词造成误判
	const head = html.slice(0, 20000);
	for (const sig of CHALLENGE_SIGNATURES) {
		if (sig.re.test(head)) return { detected: true, name: sig.name };
	}
	return { detected: false, name: null };
}

/**
 * 把一个条目的检查结果归类。抽成纯函数是为了可单测，也保证评论措辞与标签一致。
 *
 * 分类：
 *   invalid      条目字段不合法
 *   unsafe       填的地址不是公网 http(s)
 *   fetchFailed  页面完全抓不到
 *   degraded     抓取方式降级，或抓到的其实是挑战页 —— 结论不可信，不能算「确认没有」
 *   passed       确认已放回链
 *   notFound     抓到了真实页面，但里面确实没有本站链接
 */
/**
 * 判断地址是否可达（用于「网站可达」「头像可达」两项标签）。
 * 先 HEAD，很多站点不支持 HEAD 时退回 GET；只关心通/不通与状态码。
 */
async function checkReachable(url, opts) {
	const o = opts || {};
	if (!isSafeHttpUrl(url)) return { ok: false, reason: "地址被安全策略拒绝" };
	const timeoutMs = o.timeoutMs || 12000;
	let lastReason = "不可达";
	for (const method of ["HEAD", "GET"]) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: method,
				redirect: "follow",
				signal: ctrl.signal,
				headers: {
					"user-agent": "FireflyFriendsCheck/1.0 (+https://github.com/LegspCpd/friends)",
					accept: "*/*",
				},
			});
			clearTimeout(timer);
			if (res.status >= 200 && res.status < 400) return { ok: true, status: res.status };
			lastReason = "HTTP " + res.status;
			if (method === "GET") return { ok: false, status: res.status, reason: lastReason };
		} catch (e) {
			clearTimeout(timer);
			lastReason = e && e.message ? e.message : String(e);
			if (method === "GET") return { ok: false, reason: lastReason };
		}
	}
	return { ok: false, reason: lastReason };
}

/**
 * 由各条检查结果汇总 PR 标签：一项检查一个标签，成对出现（通过 / 不通过）。
 * 纯函数，便于测试。
 */
function computeLabels(results) {
	const want = new Set(["友链"]);
	let siteAll = true;
	let avatarAll = true;
	let hasAvatar = false;
	let backlinkOk = true;
	let backlinkUnknown = false;
	for (const r of results) {
		if (!(r.siteOk && r.siteOk.ok)) siteAll = false;
		if (r.data && r.data.avatar) {
			hasAvatar = true;
			if (!(r.avatarOk && r.avatarOk.ok)) avatarAll = false;
		}
		const kind = classifyCheck(r);
		if (kind === "notFound") backlinkOk = false;
		else if (kind !== "passed") backlinkUnknown = true;
	}
	want.add(siteAll ? "网站可达" : "网站不可达");
	if (hasAvatar) want.add(avatarAll ? "头像可达" : "头像不可达");
	if (backlinkOk && backlinkUnknown) want.add("回链检查受限");
	else if (backlinkOk) want.add("双向链接验证");
	else want.add("未找到回链");
	want.add(siteAll && avatarAll ? "URL 全部可达" : "URL 有不可达");
	return Array.from(want);
}

function classifyCheck(r) {
	if (!r) return "fetchFailed";
	if (r.errors && r.errors.length) return "invalid";
	if (r.unsafe) return "unsafe";
	if (!r.check) return "fetchFailed";
	if (r.check.degraded || r.check.challenge) return "degraded";
	if (r.check.found) return "passed";
	if (r.check.error) return "fetchFailed";
	return "notFound";
}

module.exports = {
	isSafeHttpUrl,
	normalizeUrl,
	extractHrefs,
	verifyBacklink,
	formatDebug,
	detectChallenge,
	classifyCheck,
	computeLabels,
	checkReachable,
	validateEntry: build.validateEntry,
};