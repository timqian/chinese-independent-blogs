const fs = require('fs');
const axios = require('axios');
const markdownTable = require('markdown-table');

const data = fs.readFileSync('./blogs-original.csv');

const rows = data.toString().split('\n');

const table = rows
  .map(row => row.split(',').map(column => column.trim()))
  .filter((row, i) => row.length === 4 && i !== 0)
  .map(row => row.push(-1) && row) // row[4] = count of RSS subscribers (feedly)

async function getResultAndUpdateREADME() {
  for (const row of table) {
    if (row[2]) { // Have RSS
      const feedId = 'feed/' +  row[2];
      const feedlyAPI = `http://cloud.feedly.com/v3/feeds/${encodeURIComponent(feedId)}`;
      
      const cacheFilename = `./blogs/${encodeURIComponent(row[1])}.json`;
      let isOld = false;
      
      if (fs.existsSync(cacheFilename)) {
        // Have Cache
        const jsonStr = fs.readFileSync(cacheFilename, 'utf8');
        const jsonObj = JSON.parse(jsonStr);

        if (jsonObj.feedId === feedId && jsonObj.subscribers !== undefined) {
            row[4] = jsonObj.subscribers;
            isOld = true;
        }
      }

      if (!isOld) {
        let res;
        
        if (false) {
          // Use Cloud Query (github.com/t9tio/cloudquery)
          const cloudqueryAPI = `https://cloudquery.t9t.io/query?url=${encodeURIComponent(feedlyAPI)}&selectors=*:nth-child(2)%20>%20*`;
          const cloudqueryRes = await axios.get(cloudqueryAPI);
          res = { data: JSON.parse(cloudqueryRes.data.contents[0].innerText) };
        } else {
          // Direct feedly
          res = await axios.get(feedlyAPI);
        }

        let subscribers;
        if (res.data && res.data.feedId === feedId) {
          subscribers = res.data.subscribers;
          fs.writeFileSync(cacheFilename, JSON.stringify(res.data));
        } else {
          subscribers = 0; // feedly can not handle this feed
          fs.writeFileSync(cacheFilename, JSON.stringify({
            feedId,
            subscribers: 0,
            flag: 1
          }));
        }

        row[4] = subscribers;

        console.log(row[1], row[4], 'FETCHED');
        // await new Promise(res => setTimeout(res, 1000));
      } else {
        // console.log(row[1], row[4], 'CACHED');
      }
    }
  }

  table.sort((a, b) => b[4] - a[4]);

  const newTable = table.map(row => {
    const subscribeCount = row[4] >= 1000 ? row[4] : (row[4] + '').replace(/\d/g, '*');
    return [row[4] >= 0 ? `[![](https://badgen.net/badge/icon/${subscribeCount}?icon=rss&label)](${row[2]})` : '', row[0].replace(/\|/g, '&#124;'), `${row[1]}`, row[3]]
  });

  // update README
  const tableContentInMD = markdownTable([['RSS 订阅数', '简介', '链接', '标签'], ...newTable]);

  const readmeContent = `

> Update: 社会化的 RSS 阅读器上线了, 欢迎试用- [Feeds Pub](https://feeds.pub)

# 中文独立博客列表

  [![](https://badgen.net/badge/icon/Website?icon=chrome&label)](https://mailchi.mp/7585311373a3/indieblogs)  [![](https://badgen.net/badge/icon/Telegram?icon=telegram&label)](https://t.me/indieBlogs) [![](https://badgen.net/badge/icon/Patrons/orange?icon=patreon&label)](https://www.patreon.com/timqian) [![](https://badgen.net/badge/icon/Blog?icon=chrome&label)](https://blog.t9t.io/cn-indie-blogs-2019-10-29/)

## 目录

- [博客列表](#博客列表)
- [什么是独立博客](#什么是独立博客)
  - [如何提交](#如何提交)
- [为什么要收集这张列表](#为什么要收集这张列表)

## 博客列表

> 暂时粗暴得按照 feedly 上的订阅数据排了个先后顺序. 正在构思一个更好得组织博客和推荐内容的[工具](https://mailchi.mp/7585311373a3/indieblogs), 欢迎通过 email [订阅更新](https://mailchi.mp/7585311373a3/indieblogs) 或加入 [Telegram 群](https://t.me/indieBlogs) 讨论

${tableContentInMD}

## 什么是独立博客

- 拥有自己的域名
- 作者本人原创内容

### 如何提交

1. 在 [./blogs-original.csv](./blogs-original.csv) 中填入博客 URL, RSS 及简介
2. 提交 PR
3. PR 被 merge 之后 README 通过 [./script.js](./script.js) 生成

## 为什么要收集这张列表

不止一次听到有人说: “在中国, 独立博客的时代已经过去了”. 确实, 很多博主都转到了公众号, 知乎专栏, 小密圈, 微博... 因为读者比较多; 平台的推荐算法让内容可以被更多人看到; 因为大厂更专业的 SEO (甚至直接与搜索引擎合作😅), 你的内容更容易被搜索到.

但我还是更喜欢独立博客, 因为属于自己的域名, 因为可以自由的排版, 自由的说话.

不得不说, 独立博客在获取新读者方面确实存在问题. 即使你内容再好, 总是需要自己发到各个论坛才能让没有订阅你博客的读者看到你的内容.

是否可以做一个工具, 可以连接这些独立博主, 在保持独立博客的自由的同时, 组织一个独立博客的创作和读者群体, 让独立博客们也有一个稳定的被发现的渠道. 这个工具可能是一个带个性化推荐系统的 RSS 客户端, 可能是一个类似微博, twitter 但是主要内容是独立博客的新东西, 读者可以点赞, 评论. 可以知道我们 follow 的博主 follow 了谁...

这个列表是一个开始, 先把独立博客们收集起来, 欢迎加入 [Telegram 群](https://t.me/indieBlogs)一起思考和讨论如何构建这样一个工具. 或者你也可以通过 email [订阅更新](https://mailchi.mp/7585311373a3/indieblogs)

## Thanks

- https://feedly.com
- t9t.io community: https://wewe.t9t.io/chat/t9t.io%20community%202 https://wewe.t9t.io/chat/t9t.io%20community
- https://github.com/DIYgod/RSSHub
- https://ohmyrss.com/
- https://github.com/tangqiaoboy/iOSBlogCN
- https://www.zhihu.com/question/19928148

## 博客构建工具推荐

  - [Saber](https://saber.land/)
  - [Hexo](https://hexo.io)
  - [vue-press](https://vuepress.vuejs.org/)
  - [Gatsby](https://www.gatsbyjs.org/)
  - [Ghost](https://ghost.org/)
  - [Wordpress](https://wordpress.com/)
`

  fs.writeFileSync('./README.md', readmeContent, 'utf8');
 
}

getResultAndUpdateREADME()
