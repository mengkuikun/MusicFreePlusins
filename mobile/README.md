# 📱 MusicFree 智能多源聚合插件 (Android 移动纯净版)

<p align="center">
  <img src="https://github.com/mengkuikun.png" width="100" height="100" style="border-radius: 50%" alt="Logo" />
</p>

<p align="center">
  <strong>专为 MusicFree Android (React Native / Hermes / QuickJS) 移动沙箱深度优化的多源聚合与自动容灾换源插件</strong>
</p>

<p align="center">
  <code>0 内置源</code> · <code>极致轻量</code> · <code>Hermes 零崩溃</code> · <code>LRU 秒开记忆</code> · <code>多源分发</code>
</p>

---

## 📥 在线安装直链（复制到 MusicFree 即可）

在手机端 MusicFree 中点击 **「侧边栏」->「插件设置」->「从网络 URL 安装」**，粘贴以下 Gitee 直链即可：

```text
https://gitee.com/mengkuikun/music-free-plusins/raw/master/mobile/musicfree-auto-fallback-mobile-pure.js
```

---

## 🌟 移动端专属特性优化

1. **QuickJS / Hermes 零依赖沙箱兼容**：
   - 彻底剥离任何对 `window` / `document` / `localStorage` / `IndexedDB` 的隐式依赖；
   - 采用标准 ES5 原型链重构，杜绝 Hermes 引擎的 `Property doesn't exist` 报错；
   - 外层 Universal 闭包支持 `module.exports`、`exports.default` 与统一 `return plugin` 导出。
2. **强类型分类支持 `supportedSearchType`**：
   - 完整声明 `["music", "album", "artist", "sheet"]`，完美唤醒安卓端搜索栏分类标签。
3. **移动端持久化适配**：
   - 深度兼容安卓端 `env.getUserVariables()` 宿主持久化数据库，重启 0ms 恢复配置。
4. **单线程超时熔断保护**：
   - 1600ms 快速熔断超时慢源，杜绝移动端 JS 单线程卡死或发热。

---

## 💡 使用说明

1. **纯净框架版特性**：本插件不预置任何第三方音频流，安装后请在 **插件设置（userVariables）** 中填入你的音源合集订阅（如 `https://music.nairocy.com/plugins.json`）或单个 `.js` 插件直链；
2. **控制台指令**：在「导入歌单」搜索框输入以下指令即可呼出交互看板：
   - 输入 **`status`**：查看当前已加载的活跃音源与版本；
   - 输入 **`del <名称>`**：精准删除指定名称的动态音源；
   - 输入 **`update`**：一键并发体检与更新所有远程音源；
   - 输入 **`clear`**：一键清空重置所有本地缓存。

---

## 📝 更新日志

详情请参见 [CHANGELOG.md](CHANGELOG.md)。
