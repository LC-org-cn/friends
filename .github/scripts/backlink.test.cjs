const assert = require("assert");
const { isSafeHttpUrl, normalizeUrl, extractHrefs, verifyBacklink, classifyCheck, validateEntry } = require("./backlink.js");

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

console.log("\n✅ 全部通过：" + pass + " 项\n");
