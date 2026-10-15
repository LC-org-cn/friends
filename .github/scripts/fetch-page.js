/**
 * 抓取层：优先用 Playwright 真浏览器（能渲染 JS、绕过部分反爬），
 * 没装 Playwright 时回退到普通 fetch（本地开发/测试用）。
 *
 * 抓到的一切内容都只当作数据，绝不执行。
 */
const { isSafeHttpUrl } = require("./backlink.js");

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function withPlaywright(url, timeoutMs) {
	const { chromium } = require("playwright");
	const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	try {
		const context = await browser.newContext({ userAgent: UA, ignoreHTTPSErrors: true });
		const page = await context.newPage();
		const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
		// 给前端框架一点渲染时间，很多友链页是 JS 渲染的
		await page.waitForTimeout(2500);
		// 有些站点（例如人机验证页）会持续自我导航，page.content() 会瞬时失败；
		// 重试几次比直接放弃更稳 —— 这正是用真浏览器而不是普通抓取的意义。
		let html = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				html = await page.content();
				break;
			} catch (contentError) {
				if (attempt === 2) throw contentError;
				await page.waitForTimeout(1500);
			}
		}
		return { ok: true, html: html, status: resp ? resp.status() : 0, via: "playwright" };
	} finally {
		await browser.close().catch(function () {});
	}
}

async function withFetch(url, timeoutMs) {
	const res = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
	});
	return { ok: true, html: await res.text(), status: res.status, via: "fetch" };
}

async function fetchHtml(url, options) {
	const timeoutMs = (options && options.timeoutMs) || 20000;
	if (!isSafeHttpUrl(url)) return { ok: false, error: "地址被安全策略拒绝（非 http(s) 或指向内网）" };

	let playwrightError = "";
	try {
		return await withPlaywright(url, timeoutMs);
	} catch (e) {
		playwrightError = e && e.message ? e.message : String(e);
	}

	try {
		const result = await withFetch(url, timeoutMs);
		// 降级标记：真浏览器没打开成功，退回了普通抓取。
		// 此时拿到的很可能不是真实页面（人机验证挑战页、被拦页面等），
		// 因此结论只能算「无法确认」，不能算「确认没有」。
		result.degraded = true;
		result.playwrightError = playwrightError;
		return result;
	} catch (e) {
		return { ok: false, error: "浏览器抓取失败：" + playwrightError + "；普通抓取也失败：" + (e && e.message ? e.message : String(e)) };
	}
}

module.exports = { fetchHtml, UA };
