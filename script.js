const fs = require('fs');
const fetch = require('node-fetch');
const markdownTable = require('markdown-table');

const data = fs.readFileSync('./blogs-original.csv');
const rows = data.toString().split('\n');

const table = rows
  .map(row => row.split(',').map(column => column.trim()))
  .filter((row, i) => row.length === 4 && i !== 0)
  .map(row => row.push(-1) && row) // row[4] to store count of RSS subscribers

async function getLatestSubstatsRes(feedUrl, cacheFilename) {
  const substatsAPI = `https://api.spencerwoo.com/substats/?source=feedly|inoreader|feedsPub&queryKey=${feedUrl}`;
 
  try {
    const substatsRes = await fetch(substatsAPI, { timeout: 5000 }); // wait for 5s
    let data = await substatsRes.json();
    if (data.status === 200) {
      // Mark lastModified
      data['lastModified'] = new Date().getTime();
      const totalSubs = data.data.totalSubs;
      // Save to cache
      fs.writeFileSync(cacheFilename, JSON.stringify(data));
      return totalSubs;
    } else {
      return -1;
    }
  } catch (err) {
    console.log(`Failed to fetch: ${feedUrl}`);
    throw err;
  }
}

async function getTotalSubs(feedUrl, index) {
  const cacheFilename = `./cache/${encodeURIComponent(feedUrl)}.json`;
  let totalSubs = -1;
  let fromCache = false;

  if (fs.existsSync(cacheFilename)) {
    const cachedRes = JSON.parse(fs.readFileSync(cacheFilename, 'utf8'));
    // cache available within 5 days
    const cacheExpired = 86400 * 1000 * 5 < (new Date().getTime() - parseInt(cachedRes.lastModified)) ? true : false;

    totalSubs = !cacheExpired ?
      cachedRes.data.totalSubs :
      await getLatestSubstatsRes(feedUrl, cacheFilename);
    fromCache = !cacheExpired;
  } else {
    totalSubs = await getLatestSubstatsRes(feedUrl, cacheFilename);
  }

  return { feedUrl, index, totalSubs, fromCache };
}


async function getResultAndUpdateREADME() {
  const feedTable = table
    .map((row, index) => row.push(index) && row) // row[5]: original table index
    .filter(row => row[2]) // Have RSS

  while(feedTable.length) {
    const resPromise = [];

    feedTable.splice(-20, 20).forEach(row => {
      resPromise.push(getTotalSubs(row[2], row[5]));
    })

    await Promise.allSettled(resPromise).then(responses => {
      responses.forEach(res => {
        if (res.status === 'fulfilled') { // succeeded
          // console.debug(`INFO: ${JSON.stringify(res.value)}`);
          table[res.value.index][4] = res.value.totalSubs;
        }
        if (res.status === 'rejected') { // failed
          // no-op
        }
      })
    })
  }

  // Sort by RSS subscribers count first, then by alphanumeric
  table.sort((a, b) => (b[4] - a[4]) || (a[0] - b[0]));

  const newTable = table.map(row => {
    const subscribeCount = row[4] >= 1000 ? row[4] : (row[4] + '').replace(/\d/g, '*');
    return [
      row[4] >= 0 ? `[![](https://badgen.net/badge/icon/${subscribeCount}?icon=rss&label)](${row[2]})` : '',
      row[0].replace(/\|/g, '&#124;'),
      row[1],
      row[3]
    ]
  });

  // update README
  const tableContentInMD = markdownTable([['RSS 订阅数', '简介', '链接', '标签'], ...newTable]);

  const readmeContent = `

> Update: 社会化的 RSS 阅读器上线了，欢迎试用—— [Feeds Pub](https://feeds.pub)

# 中文独立博客列表

  [![](https://badgen.net/badge/icon/Website?icon=chrome&label)](https://feeds.pub/cn-indie)  [![](https://badgen.net/badge/icon/Telegram?icon=telegram&label)](https://t.me/indieBlogs)  [![](https://badgen.net/badge/icon/Blog?icon=chrome&label)](https://blog.t9t.io/cn-indie-blogs-2019-10-29/)

## Sponsors

[琚致远](https://github.com/juzhiyuan) | [Bytebase](https://bytebase.com/) | [Madao](https://madao.me/) | [SecondState](https://bit.ly/3gfWwps)

[Become a sponsor](https://github.com/sponsors/timqian)

## 目录

- [博客列表](#博客列表)
- [什么是独立博客](#什么是独立博客)
  - [如何提交](#如何提交)
- [为什么要收集这张列表](#为什么要收集这张列表)

## 博客列表

> 暂时根据各 RSS 服务订阅数据排了个先后顺序。 欢迎加入 [Telegram 群](https://t.me/indieBlogs) 讨论如何更好地组织和利用这个列表

${tableContentInMD}

## 什么是独立博客

- 拥有自己的域名
- 作者本人原创内容

### 如何提交

1. 在 [./blogs-original.csv](./blogs-original.csv) 中填入博客的 名称、URL、RSS以及标签
2. 提交 PR
3. (自动) PR 被 merge 之后 README 通过 [./script.js](./script.js) 生成

## 为什么要收集这张列表

不止一次听到有人说：“在中国, 独立博客的时代已经过去了”。确实，很多博主都转到了公众号，知乎专栏，小密圈，微博……  
这些平台读者比较多、他们的推荐算法可以让你的内容被更多人看到。  
  
但我还是更喜欢独立博客，因为有属于自己的域名，因为可以自由地排版，自由地说话。

不得不承认，独立博客在如何获取新读者方面确实存在问题。“酒香也怕巷子深”，同样的内容放在自己的博客和上述的“自媒体平台”上，哪怕有自己的主动宣传，读者的增长速度看起来也远不及自媒体平台上的增粉速度，对吧？

是否可以做一个工具，可以连接这些独立博主，在保持独立博客的自由的同时，组织一个独立博客的创作和读者群体，让独立博客们也有一个稳定的被发现的渠道。这个工具可能是一个带个性化推荐系统的 RSS 客户端，可能是一个类似微博、twitter 但是主要内容是独立博客的新东西，读者可以点赞，评论。可以知道我们 follow 的博主 follow 了谁……

这个列表是一个开始，先把独立博客们收集起来。欢迎加入 [Telegram 群](https://t.me/indieBlogs)一起思考和讨论如何构建这样一个工具。或者你也可以通过 email [订阅更新](https://mailchi.mp/7585311373a3/indieblogs)

## Thanks

- https://feedly.com
- t9t.io community: https://wewe.t9t.io/chat/t9t.io%20community%202 https://wewe.t9t.io/chat/t9t.io%20community
- https://github.com/DIYgod/RSSHub
- https://ohmyrss.com/
- https://github.com/tangqiaoboy/iOSBlogCN
- https://www.zhihu.com/question/19928148

## 博客构建工具推荐

  - [Blogdown](https://github.com/rstudio/blogdown)
  - [Docusaurus](https://docusaurus.io/)
  - [Gatsby](https://gatsbyjs.org/)
  - [Ghost](https://ghost.org/)
  - [Gride](https://gridea.dev/)
  - [Halo](https://github.com/halo-dev/halo)
  - [Hexo](https://hexo.io/)
  - [Hugo](https://gohugo.io/)
  - [Jekyll](https://jekyllrb.com/)
  - [Pelican](https://blog.getpelican.com/)
  - [Saber](https://saber.land/)
  - [Typecho](https://typecho.org)
  - [Vuepress](https://vuepress.vuejs.org/)
  - [Wordpress](https://wordpress.com/)
  - [Wowchemy](https://wowchemy.com)


## 博客部署工具推荐

  - [Netlify](https://www.netlify.com/)
  - [Vercel](https://vercel.com/)
`

  fs.writeFileSync('./README.md', readmeContent, 'utf8');
 
}

getResultAndUpdateREADME()
