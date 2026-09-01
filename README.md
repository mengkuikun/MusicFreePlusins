# 🎵 MusicFree 智能多源聚合插件 (纯净框架版 - GitHub 节点)

<p align="center">
  <img src="https://github.com/mengkuikun.png" width="100" height="100" style="border-radius: 50%" alt="Logo" />
</p>

<p align="center">
  <strong>0 内置源 · 极致轻量 · 6路并发竞速 · LRU 10ms秒开记忆 · 动态热加载 · 歌单智能换源</strong>
</p>

---

## 📥 在线安装直链（复制到 MusicFree 即可）

### 1. 🌟 一键订阅纯净版（推荐）
在 MusicFree 中点击 **「插件管理」 -> 「从网络 URL 安装」**，粘贴以下【GitHub 专属订阅链接】：
```text
https://raw.githubusercontent.com/mengkuikun/MusicFreePlusins/main/plugins.json
```

---

### 2. 独立文件直链

| 文件 | 说明 | 直链 |
| :--- | :--- | :--- |
| 💻 **桌面端纯净版插件** | Windows / macOS / Linux | `https://raw.githubusercontent.com/mengkuikun/MusicFreePlusins/main/musicfree-auto-fallback-pure.js` |
| 🔄 **歌单换源升级工具** | 网页离线工具 | `https://raw.githubusercontent.com/mengkuikun/MusicFreePlusins/main/backup-migrator.html` |
| 📝 **版本更新日志** | 版本记录 | [查看 CHANGELOG.md](CHANGELOG.md) |

---

## 💡 使用说明

1. 纯净版不预置任何第三方音频流，安装后请在 **插件设置（userVariables）** 中填入你的音源合集订阅（如 `https://music.nairocy.com/plugins.json`）或单插件 `.js` 链接；
2. 支持在「导入歌单」中输入 **`status`** 查看当前已加载的活跃音源看板；
3. 支持在「导入歌单」中输入 **`cache`** 查看换源秒开记忆看板；
4. 支持在「导入歌单」中输入 **`clearcache`** 清空换源秒开记忆；
5. 支持在「导入歌单」中输入 **`update`** 一键全网体检并检查音源更新；
6. 支持在「导入歌单」中输入 **`clear`** 一键清空重置所有数据；
7. 支持将备份文件拖入 **`backup-migrator.html`** 精细化勾选指定歌单单独换源。
