const assert = require("assert");
const { validateEntry, dedupeKey, sortFriends, LIMITS } = require("./build.js");

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log("  ✓ " + name); }

ok("合法条目通过", function () {
  assert.deepStrictEqual(validateEntry({ name: "A", avatar: "https://a.com/x.png", url: "https://a.com/" }), []);
});
ok("缺少 name 被拒", function () {
  assert.ok(validateEntry({ url: "https://a.com/" }).length > 0);
});
ok("缺少 url 被拒", function () {
  assert.ok(validateEntry({ name: "A" }).length > 0);
});
ok("javascript: 协议被拒（注入防护）", function () {
  assert.ok(validateEntry({ name: "A", url: "javascript:alert(1)" }).length > 0);
});
ok("data: 协议被拒", function () {
  assert.ok(validateEntry({ name: "A", url: "https://a.com/", avatar: "data:text/html,x" }).length > 0);
});
ok("avatar 允许 null", function () {
  assert.deepStrictEqual(validateEntry({ name: "A", avatar: null, url: "https://a.com/" }), []);
});
ok("未知字段被拒", function () {
  assert.ok(validateEntry({ name: "A", url: "https://a.com/", hax: 1 }).length > 0);
});
ok("tags 超限被拒", function () {
  assert.ok(validateEntry({ name: "A", url: "https://a.com/", tags: ["1","2","3","4","5","6"] }).length > 0);
});
ok("name 超长被拒", function () {
  assert.ok(validateEntry({ name: "x".repeat(LIMITS.name + 1), url: "https://a.com/" }).length > 0);
});
ok("dedupeKey 忽略尾斜杠与大小写", function () {
  assert.strictEqual(dedupeKey("https://A.com/x/"), dedupeKey("https://a.com/x"));
});
ok("vip 置顶排序", function () {
  const r = sortFriends([{ name: "b" }, { name: "a", vip: true }]);
  assert.strictEqual(r[0].name, "a");
});

console.log("\n✅ 全部通过：" + pass + " 项\n");
