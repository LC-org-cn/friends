/**
 * PR 检查：校验友链条目 + 检测对方站点是否放了回链，并把结果贴成评论、打上标签。
 *
 * 安全模型（照搬参考实现的关键点）：
 *  - 运行在 pull_request_target 下（需要写权限来评论），因此 **绝不 checkout / 执行 PR 代码**
 *  - PR 里的文件内容全部通过 GitHub API 读取，只当数据解析
 *  - 抓取前做协议与内网地址拦截（见 backlink.js 的 isSafeHttpUrl）
 *  - 结果只提示，不自动合并、不自动关闭
 */
const { validateEntry, verifyBacklink, formatDebug, isSafeHttpUrl } = require("./backlink.js");
const { fetchHtml } = require("./fetch-page.js");

const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const PR = process.env.PR_NUMBER || "";
const API = "https://api.github.com";

const LABELS = {
	invalid: "link-check: 条目无效",
	unsafe: "link-check: 地址不安全",
	passed: "link-check: 已确认回链",
	notFound: "link-check: 未找到回链",
	fetchFailed: "link-check: 抓取失败",
};

function headers(extra) {
	return Object.assign(
		{
			Authorization: "Bearer " + TOKEN,
			Accept: "application/vnd.github+json",
			"User-Agent": "legspcpd-friends-bot",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		extra || {},
	);
}

async function api(pathname, init) {
	const res = await fetch(API + pathname, Object.assign({ headers: headers() }, init || {}));
	if (!res.ok) {
		const body = await res.text().catch(function () { return ""; });
		throw new Error("GitHub API " + pathname + " 失败：HTTP " + res.status + " " + body.slice(0, 200));
	}
	return res;
}

async function getChangedFriendFiles() {
	const res = await api("/repos/" + REPO + "/pulls/" + PR + "/files?per_page=100");
	const files = await res.json();
	return files.filter(function (f) {
		return (
			/^data\/friends\/.+\.json$/.test(f.filename) &&
			["added", "modified", "renamed"].indexOf(f.status) !== -1
		);
	});
}

async function readFileAt(ref, path) {
	const res = await api(
		"/repos/" + REPO + "/contents/" + encodeURIComponent(path).replace(/%2F/g, "/") + "?ref=" + ref,
		{ headers: headers({ Accept: "application/vnd.github.raw" }) },
	);
	return res.text();
}

async function main() {
	if (!TOKEN || !REPO || !PR) {
		console.error("缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / PR_NUMBER");
		process.exit(1);
	}

	const pull = await (await api("/repos/" + REPO + "/pulls/" + PR)).json();
	const headSha = pull.head.sha;
	const defaultBranch = pull.base.ref;

	let siteCfg;
	try { siteCfg = JSON.parse(await readFileAt(defaultBranch, "config/site.json")); }
	catch (e) { console.error("读取 config/site.json 失败：" + e.message); process.exit(1); }
	const aliases = [siteCfg.url].concat(siteCfg.aliases || [], [siteCfg.friends_page]).filter(Boolean);

	const files = await getChangedFriendFiles();
	if (files.length === 0) {
		console.log("本次 PR 没有改动 data/friends/ 下的文件，跳过。");
		return;
	}

	const results = [];
	for (const f of files) {
		const out = { file: f.filename, status: f.status };
		try {
			const text = await readFileAt(headSha, f.filename);
			out.data = JSON.parse(text);
			out.errors = validateEntry(out.data);
		} catch (e) {
			out.errors = ["无法读取或解析：" + e.message];
		}
		if (!out.errors || out.errors.length === 0) {
			const target = out.data.backlink || out.data.url;
			out.target = target;
			if (!isSafeHttpUrl(target)) {
				out.check = { found: false, error: "地址被安全策略拒绝" };
				out.unsafe = true;
			} else {
				const page = await fetchHtml(target);
				if (!page.ok) out.check = { found: false, error: page.error };
				else Object.assign((out.check = verifyBacklink(page.html, aliases)), { via: page.via, status: page.status });
			}
		}
		results.push(out);
	}

	// ── 组装评论 ──
	const lines = [];
	lines.push("## 友链提交检查结果");
	lines.push("");
	lines.push("> 仅供你自查参考；**不会自动拒绝或自动合并**，最终由维护者判断。");
	lines.push("");
	for (const r of results) {
		lines.push("### `" + r.file + "`" + (r.status === "added" ? "（新增）" : ""));
		if (r.errors && r.errors.length) {
			lines.push("");
			lines.push("❌ **条目校验未通过**：");
			for (const e of r.errors) lines.push("- " + e);
			lines.push("");
			lines.push("请参考 [README](../blob/" + defaultBranch + "/README.md) 里的字段说明修改。");
		} else if (r.unsafe) {
			lines.push("");
			lines.push("⚠️ **地址不安全**：`" + r.target + "` 不是 http(s) 公网地址，已跳过抓取。");
		} else if (r.check && r.check.found) {
			lines.push("");
			lines.push("✅ **已确认回链**：在 `" + r.target + "` 找到了指向本站的链接。");
			lines.push("> 抓取方式：" + (r.check.via || "?") + (r.check.status ? "，HTTP " + r.check.status : ""));
		} else {
			lines.push("");
			lines.push("⚠️ **未检测到回链**（这不代表一定没加）：");
			lines.push(formatDebug(r.check || { found: false }));
			lines.push("");
			lines.push("> 抓取目标：`" + r.target + "`，方式：" + ((r.check && r.check.via) || "-"));
			lines.push("> 如果你的站点有人机验证或纯前端渲染，抓取可能拿不到内容，属正常情况。");
		}
		lines.push("");
	}
	lines.push("---");
	lines.push("由 `pr-check` workflow 自动生成 · [" + (process.env.GITHUB_RUN_ID || "") + "](" + (process.env.GITHUB_SERVER_URL || "https://github.com") + "/" + REPO + "/actions/runs/" + (process.env.GITHUB_RUN_ID || "") + ")");

	await api("/repos/" + REPO + "/issues/" + PR + "/comments", {
		method: "POST",
		body: JSON.stringify({ body: lines.join("\n") }),
	});

	// ── 打标签（先确保标签存在；失败不影响结论） ──
	const want = new Set();
	for (const r of results) {
		if (r.errors && r.errors.length) want.add(LABELS.invalid);
		else if (r.unsafe) want.add(LABELS.unsafe);
		else if (r.check && r.check.found) want.add(LABELS.passed);
		else if (r.check && r.check.error) want.add(LABELS.fetchFailed);
		else want.add(LABELS.notFound);
	}
	for (const name of want) {
		try {
			await api("/repos/" + REPO + "/labels", {
				method: "POST",
				body: JSON.stringify({ name: name, color: "ededed", description: "由 pr-check workflow 自动添加" }),
			});
		} catch (e) { /* 已存在则忽略 */ }
	}
	try {
		await api("/repos/" + REPO + "/issues/" + PR + "/labels", {
			method: "POST",
			body: JSON.stringify({ labels: Array.from(want) }),
		});
	} catch (e) { console.warn("添加标签失败（忽略）：" + e.message); }

	console.log("已处理 " + results.length + " 个文件，标签：" + Array.from(want).join(" / "));
}

main().catch(function (e) { console.error("triage 异常：" + (e && e.stack ? e.stack : String(e))); process.exit(1); });
