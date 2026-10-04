// Maps the free-form tags in blogs-original.csv onto a small fixed set of
// categories for the website's filters. A blog can belong to several.
// Order here is the order of the filter chips.
export const CATEGORIES = [
  ['dev', '编程开发', /编程|技术|前端|后端|开发|代码|程序|linux|python|java|golang|^go$|rust|android|ios|算法|架构|运维|数据库|devops|web|全栈|软件|开源|docker|k8s|kubernetes|服务器|网络|cloudflare|数据|计算机/i],
  ['ai', 'AI', /^ai$|人工智能|llm|大模型|gpt|claude|机器学习|深度学习|prompt|提示词/i],
  ['life', '生活随笔', /生活|随笔|日常|记录|日记|随想|感悟|杂谈|碎碎念|心情|情感|家庭|育儿|个人/],
  ['think', '思考观点', /思考|观点|认知|成长|哲学|社会|评论|心理|反思/],
  ['read', '读书写作', /读书|阅读|书评|写作|文学|小说|诗|历史|人文|笔记/],
  ['travel', '摄影旅行', /摄影|旅行|旅游|游记|徒步|骑行|户外|城市|风景/],
  ['product', '产品商业', /产品|设计|ui|ux|交互|创业|商业|运营|管理|职场|营销|投资|理财|经济|金融/i],
  ['tools', '效率工具', /效率|工具|生产力|软件推荐|mac|apple|数码|折腾|nas|homelab|智能家居|分享|资源|教程/i],
  ['security', '安全', /安全|渗透|ctf|逆向|漏洞|hack/i],
  ['culture', '影音游戏', /游戏|电影|影视|音乐|动漫|二次元|acg|追剧|影评|美食|体育|运动/i],
];

export function categorize(tags) {
  const ids = new Set();
  for (const tag of tags) for (const [id, , re] of CATEGORIES) if (re.test(tag)) ids.add(id);
  return [...ids];
}
