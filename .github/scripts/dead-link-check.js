/**
 * 每周死链巡检。
 *
 * 判定刻意保守：只有「连不上 / 超时 / 404 / 410」才算死链。
 * 403、429、5xx 这类多半是对方反爬或临时故障，一律保留。
 * 网络类失败会再试一次，避免偶发抖动误杀正常站点。
 *
 * 命中的条目：从 data/friends/ 删除，追加到 data/removed.json
 * （保留名字、地址、头像、简介、移除时间与原因），再由 build.js 重新聚合。
 */
const fs = require("fs");
const path = require("path");
const { checkReachable } = require("./backlink.js");

const DIR = "data/friends";
const REMOVED = "data/removed.json";

function readRemoved() {
	if (!fs.existsSync(REMOVED)) return [];
	try {
		return JSON.parse(fs.readFileSync(REMOVED, "utf8"));
	} catch (e) {
		return [];
	}
}

async function main() {
	const files = fs
		.readdirSync(DIR)
		.filter(function (f) {
			return f.endsWith(".json");
		})
		.sort();

	const removed = readRemoved();
	const dead = [];

	for (const file of files) {
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
		} catch (e) {
			console.log("  跳过（无法解析）：" + file);
			continue;
		}
		if (!data || !data.url) continue;

		let verdict = await checkReachable(data.url);
		if (!verdict.ok && !verdict.status) {
			// 连不上再试一次，避免偶发抖动
			verdict = await checkReachable(data.url, { timeoutMs: 15000 });
		}

		const isDead = !verdict.ok && (verdict.status === 404 || verdict.status === 410 || !verdict.status);
		const why = verdict.status ? "HTTP " + verdict.status : verdict.reason || "不可达";
		console.log("  " + (isDead ? "✗" : "✓") + " " + (data.name || file) + "  " + data.url + "  → " + (verdict.ok ? "正常" : why));
		if (isDead) dead.push({ file: file, data: data, reason: why });
	}

	if (dead.length === 0) {
		console.log("本次没有发现死链。");
		return;
	}

	const now = new Date().toISOString();
	for (const d of dead) {
		fs.unlinkSync(path.join(DIR, d.file));
		removed.push({
			name: d.data.name || d.file.replace(/\.json$/, ""),
			url: d.data.url,
			avatar: d.data.avatar || null,
			description: d.data.description || "",
			removedAt: now,
			reason: d.reason,
		});
	}
	fs.writeFileSync(REMOVED, JSON.stringify(removed, null, "\t") + "\n");
	console.log("已移除 " + dead.length + " 条死链，并写入 " + REMOVED);
}

main().catch(function (e) {
	console.error("巡检失败：" + (e && e.stack ? e.stack : String(e)));
	process.exit(1);
});
