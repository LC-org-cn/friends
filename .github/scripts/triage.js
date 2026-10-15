/**
 * PR 检查：校验友链条目 + 检测对方站点是否放了回链，并把结果贴成评论、打上标签。
 *
 * 安全模型（照搬参考实现的关键点）：
 *  - 运行在 pull_request_target 下（需要写权限来评论），因此 **绝不 checkout / 执行 PR 代码**
 *  - PR 里的文件内容全部通过 GitHub API 读取，只当数据解析
 *  - 抓取前做协议与内网地址拦截（见 backlink.js 的 isSafeHttpUrl）
 *  - 结果只提示，不自动合并、不自动关闭
 *
 * 结论分档（见 backlink.js 的 classifyCheck）：
 *  passed / notFound / degraded / fetchFailed / unsafe / invalid
  *  其中 degraded 表示「抓取方式降级，或抓到的其实是人机验证页」，结论不可信，
   *  绝不与 notFound（抓到了真实页面、确实没有链接）混为一谈。
 *  绝不与 notFound（抓到了真实页面、确实没有链接）混为一谈。
 */
const {
	validateEntry,
	verifyBacklink,
	formatDebug,
	classifyCheck,
	detectChallenge,
	isSafeHttpUrl,
	computeLabels,
	isFriendDataPath,
	filenameIssue,
	checkReachable,
} = require("./backlink.js");
const { fetchHtml } = require("./fetch-page.js");

const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const PR = process.env.PR_NUMBER || "";
const API = "https://api.github.com";

const LABEL_COLOR = {
	"友链": "0e8a16",
	"网站可达": "0e8a16",
	"头像可达": "0e8a16",
	"双向链接验证": "0e8a16",
	"URL 全部可达": "0e8a16",
	"网站不可达": "d73a4a",
	"头像不可达": "d73a4a",
	"未找到回链": "d73a4a",
	"URL 有不可达": "d73a4a",
	"回链检查受限": "fbca04",
};

const LABEL_BY_KIND = {
	invalid: "link-check: 条目无效",
	unsafe: "link-check: 地址不安全",
	passed: "link-check: 已确认回链",
	notFound: "link-check: 未找到回链",
	degraded: "link-check: 抓取受限",
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
			isFriendDataPath(f.filename) &&
			["added", "modified", "renamed"].indexOf(f.status) !== -1
		);
	});
}

/**
 * 文件名漏写 .json 时自动改名并推回 PR 分支；改名会产生 synchronize 事件，
 * 工作流随即可重新跑一遍完整检查（这就是「自动补上再重新检测」）。
 * 只处理本仓库分支的 PR —— fork 来的 PR 机器人没有写权限。
 */
async function tryFixFilename(f, pull) {
	if (!f.filename || f.filename.slice(-5) === ".json") return { ok: false, reason: "" };
	const head = pull && pull.head;
	if (!head || !head.repo || head.repo.full_name !== REPO) {
	return { ok: false, reason: "该 PR 来自 fork，机器人无法代为改名，请把文件重命名为 " + f.filename + ".json" };
	}
	const newPath = f.filename + ".json";
	let text;
	try {
	text = await readFileAt(head.sha, f.filename);
	} catch (e) {
	return { ok: false, reason: "读取文件失败：" + (e.message || String(e)) };
	}
	try {
	JSON.parse(text);
	} catch (e) {
	return { ok: false, reason: "内容不是合法 JSON，未自动改名（" + (e.message || String(e)) + "）" };
	}
	try {
	await readFileAt(head.sha, newPath);
	return { ok: false, reason: "已存在同名文件 " + newPath + "，请手动确认" };
	} catch (e) {
	// 目标不存在，正是我们要的
	}
	const created = await api("/repos/" + REPO + "/contents/" + newPath, {
	method: "PUT",
	body: JSON.stringify({
	message: "chore(friends): 文件名补上 .json 后缀",
	content: Buffer.from(text, "utf8").toString("base64"),
	branch: head.ref,
	}),
	});
	if (!created.ok) return { ok: false, reason: "自动改名失败（新建文件）：" + (await created.text()).slice(0, 200) };
	const removed = await api("/repos/" + REPO + "/contents/" + f.filename, {
	method: "DELETE",
	body: JSON.stringify({
	message: "chore(friends): 删除缺少后缀的旧文件名",
	sha: f.sha,
	branch: head.ref,
	}),
	});
	if (!removed.ok) return { ok: false, reason: "已建好 " + newPath + "，但旧文件删除失败：" + (await removed.text()).slice(0, 200) };
	let newSha = head.sha;
	try {
	const removedJson = await removed.json();
	if (removedJson && removedJson.commit && removedJson.commit.sha) newSha = removedJson.commit.sha;
	} catch (e) {
	// 拿不到就用原 sha，下面读文件会失败并被 catch 记录
	}
	return { ok: true, newPath: newPath, newSha: newSha };
}

async function readFileAt(ref, path) {
	const res = await api(
		"/repos/" + REPO + "/contents/" + encodeURIComponent(path).replace(/%2F/g, "/") + "?ref=" + ref,
		{ headers: headers({ Accept: "application/vnd.github.raw" }) },
	);
	return res.text();
}

function renderResult(r, defaultBranch) {
	const out = [];
	const kind = classifyCheck(r);
	out.push("### `" + r.file + "`" + (r.status === "added" ? "（新增）" : ""));
	out.push("");

	if (kind === "invalid") {
		out.push("❌ **条目校验未通过**：");
		for (const e of r.errors) out.push("- " + e);
		out.push("");
		out.push("请参考 [README](../blob/" + defaultBranch + "/README.md) 里的字段说明修改。");
	} else if (kind === "unsafe") {
		out.push("⚠️ **地址不安全**：`" + r.target + "` 不是 http(s) 公网地址，已跳过抓取。");
	} else if (kind === "passed") {
		out.push("✅ **已确认回链**：在 `" + r.target + "` 找到了指向本站的链接。");
		out.push("> 抓取方式：" + (r.check.via || "?") + (r.check.status ? "，HTTP " + r.check.status : ""));
	} else if (kind === "degraded") {
		out.push("⚠️ **无法确认回链**（既不算通过，也不算没加）：");
		if (r.check.challenge) {
			out.push("- 抓到的其实是站点的人机验证页（检测到：**" + r.check.challenge + "**），不是真实页面。");
			out.push("- 因此**无法据此判断你是否添加了本站链接**，请不要认为是自己的问题。");
		} else {
			out.push("- 真浏览器没能打开该页面，已降级为普通抓取，拿到的很可能不是真实页面。");
			out.push("- 降级原因：" + (r.check.playwrightError || "未知"));
		}
		out.push("- 常见原因：站点有人机验证（如 Anubis/Cloudflare 盾）、阻止无头浏览器、或加载超时。");
		out.push(formatDebug(r.check));
		out.push("");
		out.push("> 这类情况**需要维护者人工确认**，请勿据此认定对方没有添加友链。");
	} else if (kind === "fetchFailed") {
		out.push("❌ **抓取失败**：" + ((r.check && r.check.error) || "未知错误"));
		out.push("");
		out.push("> 目标站可能临时不可达、拒绝外部访问或域名解析失败，可稍后重试或人工确认。");
	} else {
		out.push("⚠️ **未检测到回链**：" );
		out.push(formatDebug(r.check || { found: false }));
		out.push("");
		out.push("> 抓取目标：`" + r.target + "`，方式：" + ((r.check && r.check.via) || "-") + "（已抓到真实页面内容）");
	}
	out.push("");
	return out;
}

async function main() {
	if (!TOKEN || !REPO || !PR) {
		console.error("缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / PR_NUMBER");
		process.exit(1);
	}

	const pull = await (await api("/repos/" + REPO + "/pulls/" + PR)).json();
	let headSha = pull.head.sha;
	const defaultBranch = pull.base.ref;

	let siteCfg;
	try { siteCfg = JSON.parse(await readFileAt(defaultBranch, "config/site.json")); }
	catch (e) { console.error("读取 config/site.json 失败：" + e.message); process.exit(1); }
	const aliases = [siteCfg.url, siteCfg.friends_page].concat(siteCfg.aliases || []).filter(Boolean);

	const files = await getChangedFriendFiles();
	if (files.length === 0) {
		console.log("本次 PR 没有改动 data/friends/ 下的文件，跳过。");
		return;
	}

	const results = [];
	for (const f of files) {
		const out = { file: f.filename, status: f.status };
		try {
			const nameIssue = filenameIssue(f.filename);
			if (nameIssue) {
				const fixed = await tryFixFilename(f, pull);
				if (fixed.ok) {
					// 改名后本次运行直接接着检查：用改名提交读新文件（GITHUB_TOKEN 推的提交不会触发新工作流）
					out.fixed = fixed.newPath;
					out.file = fixed.newPath;
					f.filename = fixed.newPath;
					if (fixed.newSha) headSha = fixed.newSha;
				} else {
					out.errors = [nameIssue, fixed.reason].filter(Boolean);
					results.push(out);
					continue;
				}
				out.errors = [nameIssue, fixed.reason].filter(Boolean);
				results.push(out);
				continue;
			}
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
				else {
					const challenge = detectChallenge(page.html);
					Object.assign(
						(out.check = verifyBacklink(page.html, aliases)),
						{
							via: page.via,
							status: page.status,
							degraded: page.degraded === true,
							playwrightError: page.playwrightError,
							challenge: challenge.detected ? challenge.name : null,
						},
					);
					// 挑战页里的链接都是验证系统自己的，不能当作「对方没加友链」的证据
					if (challenge.detected) out.check.found = false;
				}
			}
		}
		// 网站与头像的独立可达性（对应「网站可达」「头像可达」标签）
		if (out.data && out.data.url) out.siteOk = await checkReachable(out.data.url);
		if (out.data && out.data.avatar) out.avatarOk = await checkReachable(out.data.avatar);
		results.push(out);
	}

	const lines = [];
	lines.push("## 友链提交检查结果");
	lines.push("");
	lines.push("> 仅供你自查参考；**不会自动拒绝或自动合并**，最终由维护者判断。");
	lines.push("");
	for (const r of results) {
		lines.push.apply(lines, renderResult(r, defaultBranch));
		if (r.fixed) {
			lines.push("");
			lines.push("> 检测到文件名缺少 " + String.fromCharCode(96) + ".json" + String.fromCharCode(96) + " 后缀，**已自动重命名为 " + String.fromCharCode(96) + r.fixed + String.fromCharCode(96) + "**，正在重新检查，稍等片刻。");
		}
		if (r.data) {
			lines.push("");
			lines.push("- 网站可达：" + (r.siteOk && r.siteOk.ok ? "✅ HTTP " + r.siteOk.status : "❌ " + ((r.siteOk && r.siteOk.reason) || "不可达")));
			lines.push("- 头像可达：" + (!r.data.avatar ? "—（未填头像）" : r.avatarOk && r.avatarOk.ok ? "✅ HTTP " + r.avatarOk.status : "❌ " + ((r.avatarOk && r.avatarOk.reason) || "不可达")));
		}
	}
	lines.push("---");
	lines.push(
		"由 `pr-check` workflow 自动生成 · [" +
			(process.env.GITHUB_RUN_ID || "") +
			"](" +
			(process.env.GITHUB_SERVER_URL || "https://github.com") +
			"/" +
			REPO +
			"/actions/runs/" +
			(process.env.GITHUB_RUN_ID || "") +
			")",
	);

	await api("/repos/" + REPO + "/issues/" + PR + "/comments", {
		method: "POST",
		body: JSON.stringify({ body: lines.join("\n") }),
	});

	// 一项检查一个标签，成对出现（通过 / 不通过），便于一眼看出卡在哪一项
	const want = new Set(computeLabels(results));
	for (const name of want) {
		try {
			await api("/repos/" + REPO + "/labels", {
				method: "POST",
				body: JSON.stringify({ name: name, color: LABEL_COLOR[name] || "ededed", description: "由 pr-check workflow 自动添加" }),
			});
		} catch (e) { /* 已存在则忽略 */ }
	}
	try {
	// 托管标签先清掉本次不需要的（POST 是追加语义，不清理会攒出一堆过期标签）
	const MANAGED_LABELS = [
		"友链", "网站可达", "网站不可达", "头像可达", "头像不可达",
		"双向链接验证", "未找到回链", "回链检查受限", "URL 全部可达", "URL 有不可达", "条目无效",
	].concat(Object.keys(LABEL_BY_KIND).map(function (k) { return LABEL_BY_KIND[k]; }));
	for (const name of MANAGED_LABELS) {
	if (want.has(name)) continue;
	try {
	await api("/repos/" + REPO + "/issues/" + PR + "/labels/" + encodeURIComponent(name), { method: "DELETE" });
	} catch (e) {
	// 没有这个标签就忽略
	}
	}
		await api("/repos/" + REPO + "/issues/" + PR + "/labels", {
			method: "POST",
			body: JSON.stringify({ labels: Array.from(want) }),
		});
	} catch (e) { console.warn("添加标签失败（忽略）：" + e.message); }

	console.log("已处理 " + results.length + " 个文件，标签：" + Array.from(want).join(" / "));
}

main().catch(function (e) { console.error("triage 异常：" + (e && e.stack ? e.stack : String(e))); process.exit(1); });