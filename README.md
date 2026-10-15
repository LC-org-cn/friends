# LegspCpd 友链数据源

本站（[blog.legspcpd.top](https://blog.legspcpd.top/)）的友链列表数据源。

- **每条友链一个文件**，放在 `data/friends/` 下
- 合并后由 Action 自动聚合为仓库根目录的 `friends.json`，站点构建时读取它
- 提交 PR 后，Action 会校验格式并**尝试检测你站点上是否已添加本站链接**，把结果贴在评论里

## 怎么提交友链

1. Fork 本仓库
2. 在 `data/friends/` 下新建一个文件，文件名用你站点的短名，例如 `your-blog.json`
3. 内容按下面的格式填，然后提 PR

```json
{
  "name": "你的站点名",
  "avatar": "https://你的头像地址.png",
  "description": "一句话简介（可选，最多 200 字）",
  "url": "https://你的站点/",
  "vip": false,
  "backlink": "https://你的站点/friends/",
  "tags": ["Blog"]
}
```

## 字段说明

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 站点名，非空，最多 60 字 |
| `avatar` | ✅ | 头像 URL；没有就填 `null`，页面会用占位图 |
| `description` | ➖ | 简介，最多 200 字 |
| `url` | ✅ | 你的站点地址，必须是 `http://` 或 `https://` 开头 |
| `vip` | ➖ | `true` 会被置顶，默认 `false` |
| `backlink` | ➖ | **你放置本站链接的那个页面**。填了它，检查器会直接去看这一页，成功率更高 |
| `tags` | ➖ | 标签数组，最多 5 个、每个最多 20 字 |

## 常见校验失败原因

- `url` / `avatar` / `backlink` 不是 `http(s)://` 开头（例如写成了 `javascript:` 或漏了协议头）
- 文件名或内容里带了不在上表中的字段 —— 多余字段会被拒绝，防止意外注入
- `url` 与已有友链重复
- JSON 语法错误（最常见的：末尾多了一个逗号、引号没配对）

**任何一个文件不合格都会让构建整体失败** —— 这是刻意的：宁可让构建红掉，也不产出一份悄悄少了人的友链列表。

## 关于回链检查

合并前后，Action 会尝试打开你的站点，检查里面有没有指向本站的链接。判定时会接受本站的任一域名：

- `https://blog.legspcpd.top/`
- `https://www.legspcpd.top/`
- `https://legspcpd.top/`

**检测结果只作为参考，不会自动拒绝或自动移除你的友链。** 如果你的站点有反爬（例如人机验证）导致抓取不到，评论里会附上抓到的链接列表，方便你自查；必要时可以直接联系站主。

## 撤销友链

把你的 JSON 文件移到 `data/rejected/`，或直接提 PR 删除该文件。
