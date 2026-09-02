# 📝 MusicFree 智能多源聚合插件 (Android 移动纯净版) 更新日志

All notable changes to this project will be documented in this file.

---

## [1.0.0-mob] - 2026-09-02 (移动端首发独立版)

### 📖 版本背景与来历
* **项目渊源**：本插件由 **MusicFree 智能多源聚合 (桌面端)** 演变与移植而来；
* **适配背景**：桌面端插件基于 Electron 与 Node.js 完整运行环境开发，重度依赖 DOM、`window.indexedDB`、`localStorage` 以及 Node 原生流控制（Stream）。在迁移至 Android 移动端（React Native + Hermes / QuickJS 沙箱）后，直接运行会产生语法无法识别、环境报错崩溃等问题；
* **移植重构**：本版本专门针对移动端沙箱底层机制进行了全面的架构重构与语法降级，既完整继承了桌面端强大的 **多源竞速换源**、**LRU 秒开记忆** 与 **11 大官方协议接口**，又实现了在移动端的 **零依赖、零报错、极致轻量稳定运行**。

---

### 🚀 核心架构与移动沙箱深度适配
* **Android QuickJS / Hermes 引擎 100% 兼容**：
  * 将 `MatchCacheManager` 重构为标准 ES5 原型链构造函数，彻底解决 Hermes 引擎的 `Property doesn't exist` 暂时性死区 (TDZ) 报错；
  * 移除所有 ES8+ 异步箭头函数（`async () =>`），降级为标准 `async function`，避免 QuickJS 语法解析中断；
  * 彻底剥离任何对 DOM、`window`、`document`、`IndexedDB` 的强依赖，存储系统全面采用安全纯内存降级。
* **万能 UMD 闭包封装**：
  * 外层闭包支持 `module.exports`、`exports.default` 与统一 `return plugin` 导出，确保各版本 MusicFree（不管是 `eval` 还是 `new Function` 沙箱）均能 100% 正确接收插件实例；
  * 加固 `customRequire` 内置模块加载器，支持 `axios`、`crypto-js`、`big-integer` 等库的大小写别名与 `.default` 智能解包。
* **规避 Node.js 原生流崩溃**：
  * 简化媒体源规范化探测，剔除 `responseType: "stream"` 与 `destroy()`，防止移动端原生网络桥接崩溃。

---

### ✨ 功能与特性
* **0 内置源纯净架构**：全量依靠用户自定义动态插件或 `.json` 订阅合集，极致轻量纯净；
* **完整的 11 大官方协议接口支持**：
  * 搜索（`search`）：支持 `music`、`album`、`artist`、`sheet` 4 种类型；
  * 换源播放（`getMediaSource`）与歌词解析（`getLyric`）；
  * 官方排行榜（`getTopLists`, `getTopListDetail`）与热门歌单标签（`getRecommendSheetTags`, `getRecommendSheetsByTag`）；
  * 专辑与歌手作品信息（`getAlbumInfo`, `getArtistWorks`, `getMusicSheetInfo`）；
  * 单曲与歌单导入（`importMusicItem`, `importMusicSheet`）。
* **控制台看板指令**：
  * 支持在「导入歌单」输入 `status` 查看当前已加载的活跃音源看板；
  * 支持 `del <名称>` 彻底删除指定音源；
  * 支持 `update` 一键并发体检与更新所有源；
  * 支持 `clear` 一键清空所有本地缓存。
