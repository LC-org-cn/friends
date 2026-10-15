const assert = require("assert");
const { isSafeHttpUrl, normalizeUrl, extractHrefs, verifyBacklink, detectChallenge, classifyCheck, validateEntry, computeLabels, isFriendDataPath, filenameIssue } = require("./backlink.js");

const ALIASES = ["https://blog.legspcpd.top/", "https://www.legspcpd.top/", "https://legspcpd.top/"];
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log("  ✓ " + name); }

ok("命中带引号的 href", function () {
  const r = verifyBacklink('<a href="https://blog.legspcpd.top/">友链</a>', ALIASES);
  assert.strictEqual(r.found, true);
});
ok("尾斜杠差异不影响判定", function () {
  assert.strictEqual(verifyBacklink('<a href="https://blog.legspcpd.top">x</a>', ALIASES).found, true);
});
ok("大小写差异不影响判定", function () {
  assert.strictEqual(verifyBacklink('<a href="https://BLOG.LEGSPCPD.TOP/">x</a>', ALIASES).found, true);
});
ok("命中 www 或裸域也算通过", function () {
  assert.strictEqual(verifyBacklink('<a href="https://www.legspcpd.top/">x</a>', ALIASES).found, true);
  assert.strictEqual(verifyBacklink('<a href="https://legspcpd.top/">x</a>', ALIASES).found, true);
});
ok("未命中时回吐外部链接样本", function () {
  const r = verifyBacklink('<a href="https://other.site/">y</a><a href="/local">z</a>', ALIASES);
  assert.strictEqual(r.found, false);
  assert.ok(r.sample.includes("https://other.site/"));
  assert.ok(!r.sample.includes("/local"), "相对链接不应出现在样本里");
});
ok("无引号的 href 也能抓到", function () {
  assert.strictEqual(verifyBacklink("<a href=https://blog.legspcpd.top/>x</a>", ALIASES).found, true);
});
ok("extractHrefs 同时支持两种写法", function () {
  const h = extractHrefs('<a href="a">1</a><a href=b>2</a>');
  assert.ok(h.includes("a") && h.includes("b"));
});
ok("拒绝内网地址（SSRF 防护）", function () {
  assert.strictEqual(isSafeHttpUrl("http://127.0.0.1/"), false);
  assert.strictEqual(isSafeHttpUrl("http://192.168.1.1/"), false);
  assert.strictEqual(isSafeHttpUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.strictEqual(isSafeHttpUrl("http://localhost/"), false);
});
ok("拒绝非 http(s) 协议", function () {
  assert.strictEqual(isSafeHttpUrl("javascript:alert(1)"), false);
  assert.strictEqual(isSafeHttpUrl("ftp://x.com"), false);
});
ok("放行正常站点", function () {
  assert.strictEqual(isSafeHttpUrl("https://baiblog.vip/"), true);
});
ok("validateEntry 与构建脚本同源（avatar 为必填，可为 null）", function () {
  assert.ok(validateEntry({ name: "A" }).length > 0, "缺 url/avatar 应被拒");
  assert.ok(validateEntry({ name: "A", url: "https://a.com/" }).length > 0, "缺 avatar 应被拒");
  assert.deepStrictEqual(validateEntry({ name: "A", avatar: null, url: "https://a.com/" }), []);
  assert.ok(validateEntry({ name: "A", avatar: null, url: "javascript:alert(1)" }).length > 0);
});

ok("classifyCheck：字段不合法 -> invalid", function () {
  assert.strictEqual(classifyCheck({ errors: ["x"] }), "invalid");
});
ok("classifyCheck：降级抓取 -> degraded（不算确认没有）", function () {
  assert.strictEqual(classifyCheck({ check: { found: false, degraded: true } }), "degraded");
});
ok("classifyCheck：确认找到 -> passed", function () {
  assert.strictEqual(classifyCheck({ check: { found: true } }), "passed");
});
ok("classifyCheck：真实页面确实没有 -> notFound", function () {
  assert.strictEqual(classifyCheck({ check: { found: false } }), "notFound");
});
ok("classifyCheck：完全抓不到 -> fetchFailed", function () {
  assert.strictEqual(classifyCheck({ check: { found: false, error: "boom" } }), "fetchFailed");
  assert.strictEqual(classifyCheck({}), "fetchFailed");
});
ok("classifyCheck：地址不安全 -> unsafe", function () {
  assert.strictEqual(classifyCheck({ unsafe: true }), "unsafe");
});

ok("detectChallenge：识别 Anubis 挑战页", function () {
  assert.strictEqual(detectChallenge("<title>Making sure you are not a bot!</title>").name, "Anubis");
  assert.strictEqual(detectChallenge('<a href="https://anubis.legspcpd.top/cdn-cgi/content?id=x">').name, "Anubis");
  assert.strictEqual(detectChallenge('<script src="https://github.com/TecharoHQ/anubis">').name, "Anubis");
});
ok("detectChallenge：识别 Cloudflare 盾", function () {
  assert.strictEqual(detectChallenge("<title>Just a moment...</title>").name, "Cloudflare");
  assert.strictEqual(detectChallenge('<script src="https://challenges.cloudflare.com/turnstile">').name, "Cloudflare");
});
ok("detectChallenge：正常页面不误判", function () {
  const normal = '<html><head><title>某人的博客</title></head><body><a href="https://example.com/">友链</a></body></html>';
  assert.strictEqual(detectChallenge(normal).detected, false);
  assert.strictEqual(detectChallenge("").detected, false);
  assert.strictEqual(detectChallenge(null).detected, false);
});
ok("classifyCheck：抓到的其实是挑战页 -> degraded", function () {
  assert.strictEqual(classifyCheck({ check: { found: false, challenge: "Anubis" } }), "degraded");
  assert.strictEqual(classifyCheck({ check: { found: true, challenge: "Anubis" } }), "degraded");
});



ok("isFriendDataPath / filenameIssue：只看目录，且能指出缺 .json", function () {
	assert.strictEqual(isFriendDataPath("data/friends/abc"), true);
	assert.strictEqual(isFriendDataPath("data/friends/abc.json"), true);
	assert.strictEqual(isFriendDataPath("data/friends/sub/abc.json"), false);
	assert.strictEqual(isFriendDataPath("data/other/abc.json"), false);
	assert.strictEqual(filenameIssue("data/friends/abc.json"), null);
	assert.ok(filenameIssue("data/friends/abc").indexOf(".json") >= 0, "应提示补 .json");
});
ok("computeLabels：条目无效的提交带上「条目无效」标签", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/" }, errors: ["name 过长"], siteOk: { ok: true, status: 200 }, check: { found: true } }]);
	assert.ok(labels.indexOf("条目无效") >= 0);
});
ok("computeLabels：全部通过时给出正向标签", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/", avatar: "https://a.example/avatar.png" }, siteOk: { ok: true, status: 200 }, avatarOk: { ok: true, status: 200 }, check: { found: true } }]);
	["友链", "网站可达", "头像可达", "双向链接验证", "URL 全部可达"].forEach(function (n) { assert.ok(labels.indexOf(n) >= 0, "缺少 " + n); });
	assert.ok(labels.indexOf("网站不可达") < 0);
	assert.ok(labels.indexOf("未找到回链") < 0);
});
ok("computeLabels：站点不可达 -> 负向标签", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/" }, siteOk: { ok: false, reason: "HTTP 500" }, check: { found: true } }]);
	assert.ok(labels.indexOf("网站不可达") >= 0);
	assert.ok(labels.indexOf("URL 有不可达") >= 0);
	assert.ok(labels.indexOf("网站可达") < 0);
});
ok("computeLabels：未找到回链", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/" }, siteOk: { ok: true, status: 200 }, check: { found: false } }]);
	assert.ok(labels.indexOf("未找到回链") >= 0);
	assert.ok(labels.indexOf("双向链接验证") < 0);
});
ok("computeLabels：未填头像时不出现头像标签", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/" }, siteOk: { ok: true, status: 200 }, check: { found: true } }]);
	assert.ok(labels.indexOf("头像可达") < 0);
	assert.ok(labels.indexOf("头像不可达") < 0);
	assert.ok(labels.indexOf("URL 全部可达") >= 0);
});
ok("computeLabels：抓取受限标为回链检查受限", function () {
	const labels = computeLabels([{ data: { url: "https://a.example/" }, siteOk: { ok: true, status: 200 }, check: { found: false, challenge: "Anubis" } }]);
	assert.ok(labels.indexOf("回链检查受限") >= 0);
});
console.log("\n✅ 全部通过：" + pass + " 项\n");