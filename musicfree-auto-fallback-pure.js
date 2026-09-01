/**
 * MusicFree 智能多源聚合与自动容灾换源插件 (纯净版 - 0内置源)
 * 
 * 版本: 1.4.5-pure
 * 作者: 夢酷 (mengkuikun)
 * 协议: MIT
 * 
 * 特性:
 *  - 纯净无预置第三方音源，全量依靠用户自定义配置
 *  - 支持单插件 .js 与合集 .json 订阅直链
 *  - 内置 Levenshtein 模糊匹配与歌名噪点清洗
 *  - 内置 LRU 换源记忆秒开加速引擎 (10ms 秒开与自愈)
 *  - 支持 'status' 看板与 'update' 一键体检指令
 */
(function() {
  var modules = {
  "./utils/format": function(module, exports, require) {
"use strict";

/**
 * 格式化音频时长 (秒/毫秒/数值字符串 -> mm:ss 或 hh:mm:ss)
 * 解决 MusicFree 桌面端与移动端曲目时长直接显示原始数字 (如 294) 的问题
 */
function formatDuration(duration) {
  if (duration === undefined || duration === null || duration === "" || duration === 0) {
    return "";
  }
  if (typeof duration === "string" && duration.includes(":")) {
    return duration;
  }
  let sec = Number(duration);
  if (isNaN(sec) || sec <= 0) return "";

  // 兼容毫秒
  if (sec > 10000) {
    sec = Math.floor(sec / 1000);
  }

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  const mStr = String(m).padStart(2, "0");
  const sStr = String(s).padStart(2, "0");

  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}

module.exports = {
  formatDuration,
};

  },
  "./config-pure": function(module, exports, require) {
"use strict";

const config = {
  platform: "智能多源聚合",
  version: "1.4.5-pure",
  author: "夢酷 (mengkuikun)",
  srcUrl: "https://raw.githubusercontent.com/mengkuikun/MusicFreePlusins/main/musicfree-auto-fallback-pure.js",
  description: "纯净框架版 0 内置源多源聚合与自动容灾换源插件 (支持自定义单插件及合集订阅)",
  cacheControl: "no-cache",
  defaultArtwork: "https://github.com/mengkuikun.png",
  supportedSearchType: ["music", "album", "artist", "sheet"],
  hints: {
    importMusicSheet: [
      "输入 status 查看活跃音源看板",
      "输入 cache 查看换源秒开记忆看板",
      "输入 clearcache 清空秒开记忆",
      "输入 del <名称> 彻底删除指定音源",
      "输入 update 一键体检并更新所有源",
      "输入 clear 一键清空重置所有数据",
    ],
  },

  defaultHeaders: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
  },

  // 纯净版用户变量：0 内置源，全量依靠用户自定义动态插件或订阅合集
  userVariables: [
    {
      key: "tier0PluginUrls",
      name: "优先音源",
      hint: "填入 .js 插件链接或 .json 插件合集链接（如: https://music.nairocy.com/plugins.json）",
    },
    {
      key: "tier3PluginUrls",
      name: "兜底音源",
      hint: "填入仅在全网失效时触发兜底的备用 .js / .json 链接",
    },
    {
      key: "tierBlacklist",
      name: "屏蔽音源",
      hint: "填入要禁用的源名称（如: webdav, 5sing，多个用逗号隔开）",
    },
    {
      key: "autoQualityDowngrade",
      name: "音质降级",
      hint: "无损失效时自动降级标准音质（填 true 或 false，默认 true）",
    },
    {
      key: "enableMatchCache",
      name: "秒开记忆",
      hint: "记住可用音源实现 10ms 秒开与失效自愈（填 true 或 false，默认 true）",
    },
  ],
};

module.exports = config;

  },
  "./core/matcher": function(module, exports, require) {
"use strict";

/**
 * 清洗歌名噪点
 */
function cleanTitle(title) {
  if (!title || typeof title !== "string") return "";
  let t = title.trim();

  // 移除常见音频扩展名与括号标记
  t = t
    .replace(/\s*\.(mp3|flac|wav|aac|m4a|ogg|ape)$/i, "")
    .replace(
      /\s*[（(][\s\S]*?(mp3|lrc|无损|高品质|高清|正式版|原版|伴奏|动态歌词|live|现场版|完整版|片段|重置版|remix)[\s\S]*?[）)]/gi,
      ""
    )
    .replace(
      /\s*[\[【][\s\S]*?(mp3|lrc|无损|高品质|高清|正式版|原版|伴奏|动态歌词|官方版|live|现场版|完整版|片段|重置版|remix)[\s\S]*?[\]】]/gi,
      ""
    )
    .replace(/\s*-\s*(单曲|remix|翻唱|Live|现场版)$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}

/**
 * 清洗歌手名
 */
function cleanArtist(artist) {
  if (!artist || typeof artist !== "string") return "";
  return artist
    .replace(/[,，/、&|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 字符串 Levenshtein 编辑距离相似度 (0 ~ 1)
 */
function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const str1 = s1.trim().toLowerCase();
  const str2 = s2.trim().toLowerCase();
  if (str1 === str2) return 1.0;
  if (str1.includes(str2) || str2.includes(str1)) return 0.85;

  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array.from({ length: len1 + 1 }, () =>
    new Array(len2 + 1).fill(0)
  );

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const maxLen = Math.max(len1, len2);
  return maxLen === 0 ? 1.0 : 1.0 - matrix[len1][len2] / maxLen;
}

/**
 * 解析时长为秒数
 */
function parseDurationToSeconds(val) {
  if (typeof val === "number") {
    if (val > 10000) return Math.floor(val / 1000);
    return val;
  }
  if (typeof val === "string") {
    if (val.includes(":")) {
      const parts = val.split(":").map(Number);
      if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
      if (parts.length === 3)
        return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    }
    const num = Number(val);
    if (!isNaN(num)) {
      if (num > 10000) return Math.floor(num / 1000);
      return num;
    }
  }
  return 0;
}

/**
 * 计算时长匹配度 (0 ~ 1)
 */
/**
 * 计算时长匹配度 (0 ~ 1) 与惩罚
 */
function matchDuration(targetSec, candidateSec) {
  const t = parseDurationToSeconds(targetSec);
  const c = parseDurationToSeconds(candidateSec);
  if (!t || !c || t <= 0 || c <= 0) {
    return 0.7; // 没有时长信息时给予中性分
  }
  const diff = Math.abs(t - c);
  if (diff <= 4) return 1.0;
  if (diff <= 10) return 0.9;
  if (diff <= 20) return 0.7;
  if (diff <= 35) return 0.3;
  return 0.0;
}

/**
 * 综合相似度评分 (0 ~ 100) - 具备严格防试听源、时长比例熔断与歌手识别机制
 */
function computeScore(target, candidate) {
  if (!target || !candidate || !candidate.title) return 0;

  const tRawTitle = (target.title || "").toLowerCase();
  const cRawTitle = (candidate.title || "").toLowerCase();

  const tTitle = cleanTitle(target.title);
  const cTitle = cleanTitle(candidate.title);
  const tArtist = cleanArtist(target.artist);
  const cArtist = cleanArtist(candidate.artist);

  const tSec = parseDurationToSeconds(target.duration);
  const cSec = parseDurationToSeconds(candidate.duration);

  // -------------------------------------------------------------
  // 1. 试听源 / 片段 / 铃声 / 时长偏差过大 一票否决机制 (Disqualification)
  // -------------------------------------------------------------
  // (1) 目标是正常完整歌曲 (>= 90秒)
  if (tSec >= 90) {
    // 候选时长 < 60 秒 (如 24s/30s 试听片段或铃声)，直接淘汰！
    if (cSec > 0 && cSec < 60) {
      return 0;
    }
    // 候选时长与目标时长相差超过 25 秒或相对差异超过 12% (如 04:24 与 03:05 差 79秒)，直接淘汰！
    if (cSec > 0) {
      const diff = Math.abs(tSec - cSec);
      const diffRatio = diff / Math.max(tSec, cSec);
      if (diff > 25 || diffRatio > 0.12) {
        return 0;
      }
    }
  }

  // (2) 候选标题明确包含试听、片段、铃声、高潮版，而目标歌曲不是
  const isSnippetCandidate =
    cRawTitle.includes("片段") ||
    cRawTitle.includes("试听") ||
    cRawTitle.includes("铃声") ||
    cRawTitle.includes("高潮版") ||
    cRawTitle.includes("副歌") ||
    cRawTitle.includes("秒版") ||
    cRawTitle.includes("preview") ||
    cRawTitle.includes("snippet") ||
    cRawTitle.includes("ringtone");

  const targetWantsSnippet =
    tRawTitle.includes("片段") ||
    tRawTitle.includes("试听") ||
    tRawTitle.includes("铃声");

  if (isSnippetCandidate && !targetWantsSnippet) {
    return 0;
  }

  // (3) 营销号假冒歌手与 Phonk / 混音词拦截 (如 "周杰伦-, Montagem" 或 "周杰伦., 哭泣灰太狼")
  const cRawArtistLower = (candidate.artist || "").toLowerCase();
  const isFakeArtistPhonk =
    cRawArtistLower.includes("montagem") ||
    cRawArtistLower.includes("phonk") ||
    cRawArtistLower.includes("灰太狼") ||
    cRawArtistLower.includes("总被欺") ||
    cRawArtistLower.includes("降调版") ||
    cRawArtistLower.includes("升调版");

  if (isFakeArtistPhonk && !tRawTitle.includes("montagem")) {
    return 0;
  }

  // -------------------------------------------------------------
  // 2. 标题与歌手相似度计算 (支持第三方源标题内嵌歌手识别与翻唱识别)
  // -------------------------------------------------------------
  const titleScore = stringSimilarity(tTitle, cTitle);
  let artistScore = 0.5;
  let isDifferentArtist = false;

  const isCoverWord =
    cRawTitle.includes("cover") ||
    cRawTitle.includes("翻唱") ||
    cRawTitle.includes("翻自") ||
    cRawTitle.includes("翻奏") ||
    cRawTitle.includes("翻弹") ||
    cRawTitle.includes("原唱");

  let isDifferentArtistCover = false;

  if (tArtist && cArtist) {
    const rawArtistSim = stringSimilarity(tArtist, cArtist);
    if (rawArtistSim >= 0.6) {
      artistScore = rawArtistSim;
    } else {
      // 歌手完全不同 (例如 甄熙 / 中孝介 vs 周杰伦)
      if (
        cRawTitle.includes(tArtist.toLowerCase()) ||
        cRawTitle.includes(cleanArtist(tArtist).toLowerCase())
      ) {
        // 标题中带有目标歌手，但歌手字段是别人 (如 甄熙 唱 花海(周杰伦))
        // 判断是否为 Bilibili/第三方 UP 主
        const isUpOrUploader =
          candidate._source === "bilibili" ||
          candidate._source === "gdstudio" ||
          cArtist.includes("up") ||
          cArtist.includes("台") ||
          cArtist.includes("馆") ||
          cArtist.includes("音乐") ||
          cArtist.includes("社");

        if (isUpOrUploader && !isCoverWord) {
          artistScore = 0.95;
        } else {
          // 普通第三方歌手在翻唱/翻奏
          isDifferentArtistCover = true;
          isDifferentArtist = true;
          artistScore = 0.3;
        }
      } else {
        artistScore = rawArtistSim;
        isDifferentArtist = true;
      }
    }
  } else if (tArtist && !cArtist) {
    if (cRawTitle.includes(tArtist.toLowerCase())) {
      artistScore = 0.9;
    }
  }

  // -------------------------------------------------------------
  // 3. 时长精细评分
  // -------------------------------------------------------------
  let durationScore = 0.8;
  if (tSec > 0 && cSec > 0) {
    const diff = Math.abs(tSec - cSec);
    if (diff <= 3) durationScore = 1.0;
    else if (diff <= 8) durationScore = 0.9;
    else if (diff <= 15) durationScore = 0.7;
    else durationScore = 0.4;
  }

  // 权重分配：标题 50%，歌手 30%，时长 20%
  let total = (titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2) * 100;

  // 原始标题完全一致加分
  if (target.title && candidate.title && target.title.trim() === candidate.title.trim()) {
    total += 5;
  }

  // 歌手完全不同严重扣分 (例如 花海-中孝介 vs 花海-周杰伦)
  if (isDifferentArtist && tArtist) {
    total -= 35;
  }

  // 翻唱 / 伴奏 / 纯音乐 / DJ / 变速变调 降权 (目标不包含对应标记时)
  if (
    (isCoverWord || isDifferentArtistCover) &&
    !tRawTitle.includes("cover") &&
    !tRawTitle.includes("翻唱") &&
    !tRawTitle.includes("翻奏")
  ) {
    total -= 30;
  }
  if (
    (cRawTitle.includes("伴奏") ||
      cRawTitle.includes("instrumental") ||
      cRawTitle.includes("伴奏版") ||
      cRawTitle.includes("无声") ||
      cRawTitle.includes("钢琴") ||
      cRawTitle.includes("吉他") ||
      cRawTitle.includes("古筝") ||
      cRawTitle.includes("纯音乐") ||
      cRawTitle.includes("八音盒")) &&
    !tRawTitle.includes("伴奏") &&
    !tRawTitle.includes("钢琴") &&
    !tRawTitle.includes("纯音乐")
  ) {
    total -= 35;
  }
  if (
    (cRawTitle.includes("dj") ||
      cRawTitle.includes("remix") ||
      cRawTitle.includes("慢摇") ||
      cRawTitle.includes("电音") ||
      cRawTitle.includes("降调") ||
      cRawTitle.includes("升调") ||
      cRawTitle.includes("变速") ||
      cRawTitle.includes("倍速") ||
      cRawTitle.includes("0.") ||
      cRawTitle.includes("1.")) &&
    !tRawTitle.includes("dj") &&
    !tRawTitle.includes("remix")
  ) {
    total -= 35;
  }

  return Math.max(0, Math.round(total));
}

/**
 * 从候选列表中找出最佳匹配歌曲 (默认及格线 50 分)
 */
function findBestMatch(target, candidateList, minThreshold = 50) {
  if (!Array.isArray(candidateList) || candidateList.length === 0) {
    return null;
  }

  let bestItem = null;
  let highestScore = -1;

  for (const item of candidateList) {
    if (!item || !item.title) continue;
    const score = computeScore(target, item);
    if (score > highestScore && score >= minThreshold) {
      highestScore = score;
      bestItem = { ...item, _matchScore: score };
    }
  }

  return bestItem;
}

module.exports = {
  cleanTitle,
  cleanArtist,
  stringSimilarity,
  parseDurationToSeconds,
  matchDuration,
  computeScore,
  findBestMatch,
};

  },
  "./core/version": function(module, exports, require) {
"use strict";

/**
 * 规范化版本号字符串 (如 "v1.2.0" -> [1, 2, 0])
 */
function parseVersion(v) {
  if (!v || typeof v !== "string") return [1, 0, 0];
  const clean = v.trim().replace(/^v/i, "");
  const parts = clean.split(".").map((p) => {
    const num = parseInt(p, 10);
    return isNaN(num) ? 0 : num;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * 比较两个版本号
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
function compareVersions(v1, v2) {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);

  for (let i = 0; i < 3; i++) {
    if (p1[i] > p2[i]) return 1;
    if (p1[i] < p2[i]) return -1;
  }
  return 0;
}

module.exports = {
  parseVersion,
  compareVersions,
};

  },
  "./core/cache": function(module, exports, require) {
"use strict";

const { cleanTitle, cleanArtist } = require("./matcher");

const CACHE_STORAGE_KEY = "mf_match_memory_cache_v1";

function getLocalStorageSafe() {
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage &&
      typeof localStorage.getItem === "function"
    ) {
      return localStorage;
    }
  } catch (e) {}
  try {
    if (
      typeof globalThis !== "undefined" &&
      globalThis.localStorage &&
      typeof globalThis.localStorage.getItem === "function"
    ) {
      return globalThis.localStorage;
    }
  } catch (e) {}
  return null;
}

/**
 * LRU 智能换源秒开记忆缓存 (支持本地持久化秒存秒读，重启软件依然 10ms 秒开)
 * 存储结构: key -> { sourceKey, item, time }
 */
class MatchCacheManager {
  constructor(maxSize = 500, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs; // 默认记忆有效期 7 天
    this.cache = new Map();
    this._loadFromDisk();
  }

  _getKey(title, artist) {
    return `${cleanTitle(title)}___${cleanArtist(artist)}`.toLowerCase().trim();
  }

  _loadFromDisk() {
    try {
      const ls = getLocalStorageSafe();
      if (!ls) return;
      const raw = ls.getItem(CACHE_STORAGE_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          const now = Date.now();
          for (const entry of list) {
            if (
              entry &&
              entry.key &&
              entry.sourceKey &&
              entry.item &&
              now - (entry.time || 0) <= this.ttlMs
            ) {
              this.cache.set(entry.key, {
                sourceKey: entry.sourceKey,
                item: entry.item,
                time: entry.time || now,
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  _saveToDisk() {
    try {
      const ls = getLocalStorageSafe();
      if (!ls) return;
      const list = [];
      for (const [key, entry] of this.cache.entries()) {
        list.push({
          key,
          sourceKey: entry.sourceKey,
          item: entry.item,
          time: entry.time,
        });
      }
      ls.setItem(CACHE_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  /**
   * 获取某首歌的换源记忆
   */
  get(title, artist) {
    const key = this._getKey(title, artist);
    if (!key || !this.cache.has(key)) return null;

    const entry = this.cache.get(key);
    // 检查是否过期
    if (Date.now() - entry.time > this.ttlMs) {
      this.cache.delete(key);
      this._saveToDisk();
      return null;
    }

    // 刷新 LRU 活跃顺序
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  /**
   * 记录成功的换源记忆
   * 注意：我们记忆的是【目标源与目标曲目元数据/ID】，而不是具有临时 Token 的音频 URL
   */
  set(title, artist, sourceKey, matchedItem) {
    const key = this._getKey(title, artist);
    if (!key) return;

    if (this.cache.size >= this.maxSize) {
      // 淘汰最久未使用的首个元素
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      sourceKey,
      item: matchedItem,
      time: Date.now(),
    });

    this._saveToDisk();
  }

  /**
   * 清除特定歌曲的记忆（当记忆源失效时触发自愈）
   */
  invalidate(title, artist) {
    const key = this._getKey(title, artist);
    if (key && this.cache.has(key)) {
      this.cache.delete(key);
      this._saveToDisk();
    }
  }

  /**
   * 清空所有换源记忆
   */
  clear() {
    this.cache.clear();
    const ls = getLocalStorageSafe();
    if (ls) {
      try {
        ls.removeItem(CACHE_STORAGE_KEY);
      } catch (e) {}
    }
  }

  /**
   * 获取记忆看板统计数据
   */
  getStats() {
    const ls = getLocalStorageSafe();
    let rawSize = 0;
    if (ls) {
      try {
        const raw = ls.getItem(CACHE_STORAGE_KEY);
        if (raw) rawSize = raw.length;
      } catch (e) {}
    }
    return {
      count: this.cache.size,
      storageKey: CACHE_STORAGE_KEY,
      sizeBytes: rawSize,
      sizeKb: (rawSize / 1024).toFixed(2),
    };
  }

  size() {
    return this.cache.size;
  }
}

const matchCache = new MatchCacheManager();

module.exports = {
  matchCache,
  MatchCacheManager,
  CACHE_STORAGE_KEY,
};

  },
  "./core/storage": function(module, exports, require) {
"use strict";

/**
 * MusicFree 自适应持久化存储引擎 (双轨融合：localStorage 0ms 同步秒存秒读 + IndexedDB 超大容量后台备份)
 */

const DB_NAME = "MusicFreePluginDB";
const STORE_NAME = "dynamic_plugins";
const DB_VERSION = 1;
const STORAGE_KEY = "mf_dynamic_plugins_cache_v2";

let idbInstance = null;
let inMemoryStore = [];

function isIndexedDBAvailable() {
  try {
    const root =
      typeof window !== "undefined"
        ? window
        : typeof globalThis !== "undefined"
        ? globalThis
        : null;
    return !!(
      root &&
      (root.indexedDB ||
        root.mozIndexedDB ||
        root.webkitIndexedDB ||
        root.msIndexedDB)
    );
  } catch (e) {
    return false;
  }
}

function getIndexedDBRoot() {
  const root =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
      ? globalThis
      : null;
  return root
    ? root.indexedDB ||
        root.mozIndexedDB ||
        root.webkitIndexedDB ||
        root.msIndexedDB
    : null;
}

function openIndexedDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  if (!isIndexedDBAvailable()) return Promise.resolve(null);

  const idb = getIndexedDBRoot();
  return new Promise((resolve) => {
    try {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "url" });
        }
      };
      req.onsuccess = (e) => {
        idbInstance = e.target.result;
        resolve(idbInstance);
      };
      req.onerror = () => {
        resolve(null);
      };
    } catch (err) {
      resolve(null);
    }
  });
}

function getLocalStorageSafe() {
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage &&
      typeof localStorage.getItem === "function"
    ) {
      return localStorage;
    }
  } catch (e) {}
  try {
    if (
      typeof globalThis !== "undefined" &&
      globalThis.localStorage &&
      typeof globalThis.localStorage.getItem === "function"
    ) {
      return globalThis.localStorage;
    }
  } catch (e) {}
  return null;
}

/**
 * ⚡ 第一步：同步优先写入 localStorage (0ms 极速写入，保证开机瞬间秒读)
 */
function savePluginsSync(list) {
  if (!Array.isArray(list)) return false;
  inMemoryStore = list.slice();

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      // 若单次体积超过 5MB 触发 Quota 报错，由后台 IndexedDB 完整接管
      return false;
    }
  }
  return false;
}

/**
 * 📦 第二步：后台异步写入 IndexedDB (支持 GB 级超大容量插件持久化)
 */
async function savePluginsAsync(list) {
  if (!Array.isArray(list)) return;
  try {
    const db = await openIndexedDB();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          for (const item of list) {
            if (item && item.url) {
              store.put(item);
            }
          }
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }
  } catch (err) {}
}

/**
 * 综合保存：同步立即写入 localStorage + 后台静默写入 IndexedDB
 */
function savePlugins(list) {
  savePluginsSync(list);
  savePluginsAsync(list).catch(() => {});
}

/**
 * ⚡ 开机 0ms 同步秒读 (纯同步从 localStorage 恢复已存插件)
 */
function loadPluginsSync() {
  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          inMemoryStore = parsed.slice();
          return parsed;
        }
      }
    } catch (e) {}
  }
  return inMemoryStore.slice();
}

/**
 * 📦 异步完整读取 (从 IndexedDB 检索超大插件，并与 localStorage 合并)
 */
async function loadPlugins() {
  const syncList = loadPluginsSync();
  const resultMap = new Map();
  if (Array.isArray(syncList)) {
    syncList.forEach((item) => {
      if (item && item.url) resultMap.set(item.url, item);
    });
  }

  try {
    const db = await openIndexedDB();
    if (db) {
      const records = await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readonly");
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });

      if (Array.isArray(records)) {
        records.forEach((item) => {
          if (item && item.url) resultMap.set(item.url, item);
        });
      }
    }
  } catch (err) {}

  const merged = Array.from(resultMap.values());
  inMemoryStore = merged.slice();
  return merged;
}

/**
 * 删除指定 URL 的插件数据
 */
async function removePlugin(url) {
  if (!url) return;
  inMemoryStore = inMemoryStore.filter((x) => x.url !== url);

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(inMemoryStore));
    } catch (e) {}
  }

  try {
    const db = await openIndexedDB();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          store.delete(url);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    }
  } catch (err) {}
}

/**
 * 清空所有存储
 */
async function clearAll() {
  inMemoryStore = [];
  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
    } catch (e) {}
  }
  try {
    const db = await openIndexedDB();
    if (db) {
      const tx = db.transaction([STORE_NAME], "readwrite");
      tx.objectStore(STORE_NAME).clear();
    }
  } catch (e) {}
}

module.exports = {
  isIndexedDBAvailable,
  savePlugins,
  savePluginsSync,
  savePluginsAsync,
  loadPlugins,
  loadPluginsSync,
  removePlugin,
  clearAll,
  STORAGE_KEY,
};

  },
  "./core/dynamic-loader": function(module, exports, require) {
"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const CryptoJS = require("crypto-js");
const dayjs = require("dayjs");
const qs = require("qs");
const he = require("he");
const bigInt = require("big-integer");
const { compareVersions } = require("./version");
const storage = require("./storage");

// 动态插件内存注册表: url -> { plugin, url, tier, code, time }
const dynamicRegistry = new Map();

// 记忆上次同步的配置指纹，杜绝重复网络请求
let lastSyncedFingerprint = "";

// 全局后台初始化就绪 Promise
let bgInitPromise = null;

// 需要被过滤的非通用音频/本地备份插件黑名单关键词
const EXCLUDED_KEYWORDS = [
  "webdav",
  "navidrome",
  "emby",
  "jellyfin",
  "subsonic",
  "alist",
  "local",
  "本地",
  "备份",
];

/**
 * 将当前内存中的所有动态插件持久化写入本地存储 (localStorage 优先同步写入 + IndexedDB 后台异步备份)
 */
function persistDynamicPluginsToStorage() {
  try {
    const list = [];
    for (const [url, reg] of dynamicRegistry.entries()) {
      if (reg.code && typeof reg.code === "string") {
        list.push({
          url,
          tier: reg.tier,
          name: reg.plugin.platform || reg.plugin.name || "未命名",
          version: reg.plugin.version || "1.0.0",
          code: reg.code,
          time: reg.time,
        });
      }
    }
    storage.savePlugins(list);
  } catch (e) {}
}

/**
 * 软件启动时，直接从本地存储极速秒读已缓存的插件代码 (0ms 纯同步从 localStorage 灌入内存)
 */
function restoreDynamicPluginsFromStorage(builtInSourcesMap = {}) {
  try {
    const syncList = storage.loadPluginsSync();
    let restoredCount = 0;
    if (Array.isArray(syncList)) {
      for (const item of syncList) {
        if (item.code && item.url && !dynamicRegistry.has(item.url)) {
          const plugin = evaluatePluginCode(item.code);
          if (plugin) {
            plugin._sourceUrl = item.url;
            plugin._isDynamic = true;
            plugin._tier = item.tier || "tier0";
            dynamicRegistry.set(item.url, {
              plugin,
              url: item.url,
              tier: item.tier || "tier0",
              code: item.code,
              time: item.time || Date.now(),
            });
            restoredCount++;
          }
        }
      }
    }
    return restoredCount;
  } catch (e) {
    return 0;
  }
}

/**
 * 🚀 顶层后台自动初始化任务 (同步 0ms 秒载 + 异步补充 IndexedDB)
 */
function triggerBackgroundInit() {
  if (bgInitPromise) return bgInitPromise;
  bgInitPromise = (async () => {
    try {
      // 1. 同步 0ms 从 localStorage 恢复
      restoreDynamicPluginsFromStorage();

      // 2. 异步补充 IndexedDB 中超出 5MB 的大体积插件
      const asyncList = await storage.loadPlugins();
      if (Array.isArray(asyncList)) {
        for (const item of asyncList) {
          if (item && item.code && item.url && !dynamicRegistry.has(item.url)) {
            const plugin = evaluatePluginCode(item.code);
            if (plugin) {
              plugin._sourceUrl = item.url;
              plugin._isDynamic = true;
              plugin._tier = item.tier || "tier0";
              dynamicRegistry.set(item.url, {
                plugin,
                url: item.url,
                tier: item.tier || "tier0",
                code: item.code,
                time: item.time || Date.now(),
              });
            }
          }
        }
      }
    } catch (e) {}
  })();
  return bgInitPromise;
}

// 模块加载顶层立即自执行！(开机 0ms 瞬间把已存插件拉满内存)
triggerBackgroundInit();

/**
 * 全局就绪等待锁：冷启动若遇大体积异步插件，自动等待就绪，绝不报空
 */
async function ensureDynamicPluginsReady(timeoutMs = 2500) {
  if (dynamicRegistry.size > 0) return true;
  if (!bgInitPromise) triggerBackgroundInit();
  try {
    await Promise.race([
      bgInitPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (e) {}
  return dynamicRegistry.size > 0;
}

/**
 * 精准删除某个指定的动态插件 (从运行内存 + localStorage + IndexedDB 中彻底移除)
 */
function deleteDynamicPlugin(query) {
  if (!query || typeof query !== "string") {
    return { success: false, message: "请指定要删除的音源名称（如: del 5sing 或 删除 酷我）" };
  }

  const target = query.trim().toLowerCase();
  let deletedCount = 0;
  let deletedName = "";

  for (const [url, reg] of dynamicRegistry.entries()) {
    const pName = (reg.plugin.platform || reg.plugin.name || "").toLowerCase();
    if (pName === target || pName.includes(target) || url.toLowerCase().includes(target)) {
      deletedName = reg.plugin.platform || reg.plugin.name || url;
      dynamicRegistry.delete(url);
      storage.removePlugin(url);
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    persistDynamicPluginsToStorage();
    return {
      success: true,
      name: deletedName,
      count: deletedCount,
      message: `成功删除音源 [${deletedName}]！当前剩余活跃音源: ${dynamicRegistry.size} 个`,
    };
  }

  return {
    success: false,
    message: `未找到名称包含 "${query}" 的音源插件，可输入 status 查看看板`,
  };
}

/**
 * 一键清空所有本地缓存的动态音源
 */
function clearAllDynamicPlugins() {
  const count = dynamicRegistry.size;
  dynamicRegistry.clear();
  storage.clearAll();
  return {
    success: true,
    count,
    message: `成功清空本地所有缓存音源（已移除 ${count} 个插件）`,
  };
}

function createSandboxRequire() {
  return function (modName) {
    const name = String(modName).toLowerCase();
    if (name === "axios") return axios;
    if (name === "cheerio") return cheerio;
    if (name === "crypto-js" || name === "cryptojs") return CryptoJS;
    if (name === "dayjs") return dayjs;
    if (name === "qs") return qs;
    if (name === "he") return he;
    if (name === "big-integer" || name === "biginteger") return bigInt;
    try {
      return require(modName);
    } catch (e) {
      return {};
    }
  };
}

/**
 * 安全且通用的插件沙箱执行器 (完全符合 MusicFree 跨平台环境规范)
 */
function evaluatePluginCode(code) {
  if (!code || typeof code !== "string") return null;

  try {
    const sandboxModule = { exports: {} };
    const sandboxExports = sandboxModule.exports;
    const sandboxWindow = {};
    const sandboxRequire = createSandboxRequire();

    const runner = new Function(
      "module",
      "exports",
      "require",
      "window",
      "document",
      "globalThis",
      code
    );

    runner(
      sandboxModule,
      sandboxExports,
      sandboxRequire,
      sandboxWindow,
      { createElement: () => ({}) },
      sandboxWindow
    );

    let plugin = sandboxModule.exports.default || sandboxModule.exports;
    if (
      !plugin ||
      typeof plugin !== "object" ||
      (!plugin.search && !plugin.getMediaSource)
    ) {
      if (sandboxWindow.$carbonatePlugin) plugin = sandboxWindow.$carbonatePlugin;
      else if (sandboxWindow.plugin) plugin = sandboxWindow.plugin;
      else if (sandboxWindow.default) plugin = sandboxWindow.default;
    }

    if (
      plugin &&
      (typeof plugin.search === "function" ||
        typeof plugin.getMediaSource === "function")
    ) {
      return plugin;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 注册单个已下载并实例化的 JS 插件对象
 */
function registerSingleEvaluatedPlugin(plugin, cleanUrl, tier, builtInSourcesMap, rawCode = "") {
  const remoteName = plugin.platform || plugin.name || "未命名插件";
  const remoteVersion = plugin.version || "1.0.0";
  plugin._sourceUrl = cleanUrl;
  plugin._isDynamic = true;
  plugin._tier = tier;

  // 1. 查找是否存在已有的同名插件
  let existingEntry = null;
  for (const [u, reg] of dynamicRegistry.entries()) {
    if (reg.plugin.platform === remoteName || u === cleanUrl) {
      existingEntry = { type: "dynamic", url: u, reg };
      break;
    }
  }

  let existingBuiltin = null;
  if (!existingEntry) {
    for (const [k, bSource] of Object.entries(builtInSourcesMap)) {
      if (
        bSource.name === remoteName ||
        bSource.platform === remoteName ||
        k.toLowerCase() === remoteName.toLowerCase()
      ) {
        existingBuiltin = bSource;
        break;
      }
    }
  }

  // 2. 版本对比
  if (existingEntry) {
    const currentVer = existingEntry.reg.plugin.version || "1.0.0";
    const comp = compareVersions(remoteVersion, currentVer);
    if (comp > 0) {
      dynamicRegistry.set(cleanUrl, {
        plugin,
        url: cleanUrl,
        tier,
        code: rawCode || existingEntry.reg.code,
        time: Date.now(),
      });
      persistDynamicPluginsToStorage();
      return {
        status: "updated",
        name: remoteName,
        oldVersion: currentVer,
        version: remoteVersion,
        message: `[${remoteName}] 插件更新成功为 ${remoteVersion}`,
        plugin,
      };
    } else {
      return {
        status: "exists",
        name: remoteName,
        version: currentVer,
        message: `该音乐源早就有了 (已是最新版本 v${currentVer})`,
        plugin: existingEntry.reg.plugin,
      };
    }
  }

  if (existingBuiltin) {
    const currentVer = existingBuiltin.version || "1.0.0";
    const comp = compareVersions(remoteVersion, currentVer);
    if (comp > 0) {
      dynamicRegistry.set(cleanUrl, {
        plugin,
        url: cleanUrl,
        tier,
        code: rawCode,
        time: Date.now(),
      });
      persistDynamicPluginsToStorage();
      return {
        status: "updated",
        name: remoteName,
        oldVersion: currentVer,
        version: remoteVersion,
        message: `[${remoteName}] 插件更新成功为 ${remoteVersion} (覆盖内置版本)`,
        plugin,
      };
    } else {
      return {
        status: "exists",
        name: remoteName,
        version: currentVer,
        message: `该音乐源早就有了 (已是最新版本 v${currentVer})`,
        plugin: existingBuiltin,
      };
    }
  }

  // 3. 全新源添加
  dynamicRegistry.set(cleanUrl, {
    plugin,
    url: cleanUrl,
    tier,
    code: rawCode,
    time: Date.now(),
  });
  persistDynamicPluginsToStorage();

  return {
    status: "added",
    name: remoteName,
    version: remoteVersion,
    message: `添加音乐源 [${remoteName}] 成功，版本号为 ${remoteVersion}`,
    plugin,
  };
}

/**
 * 注册或更新单个或批量插件 (支持 .js 脚本 与 .json 订阅合集)
 */
async function registerOrUpdatePlugin(url, tier = "tier0", builtInSourcesMap = {}) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return {
      status: "error",
      name: "未知",
      version: "0.0.0",
      message: "无效的插件 URL 链接",
    };
  }

  const cleanUrl = url.trim();

  try {
    const res = await axios.get(cleanUrl, {
      timeout: 5000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
      },
    });

    const rawData = res.data;

    // A. 处理 JSON 插件合集订阅链接 (如 https://music.nairocy.com/plugins.json)
    let pluginList = null;
    if (typeof rawData === "object" && rawData !== null) {
      if (Array.isArray(rawData.plugins)) pluginList = rawData.plugins;
      else if (Array.isArray(rawData)) pluginList = rawData;
    } else if (
      typeof rawData === "string" &&
      (rawData.trim().startsWith("{") || rawData.trim().startsWith("["))
    ) {
      try {
        const parsed = JSON.parse(rawData.trim());
        if (Array.isArray(parsed.plugins)) pluginList = parsed.plugins;
        else if (Array.isArray(parsed)) pluginList = parsed;
      } catch (e) {}
    }

    if (pluginList && Array.isArray(pluginList)) {
      const validItems = pluginList.filter((item) => {
        const itemUrl = item.url || item.srcUrl;
        const itemName = (item.name || "").toLowerCase();
        if (!itemUrl || !itemUrl.startsWith("http")) return false;
        if (EXCLUDED_KEYWORDS.some((kw) => itemName.includes(kw))) return false;
        return true;
      });

      // 8 路并发高速拉取子插件
      const tasks = validItems.map(async (item) => {
        const itemUrl = item.url || item.srcUrl;
        try {
          const subRes = await axios.get(itemUrl, {
            timeout: 3500,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            },
          });
          const rawSubCode = typeof subRes.data === "string" ? subRes.data : JSON.stringify(subRes.data);
          const plugin = evaluatePluginCode(rawSubCode);
          if (plugin) {
            return registerSingleEvaluatedPlugin(
              plugin,
              itemUrl,
              tier,
              builtInSourcesMap,
              rawSubCode
            );
          }
        } catch (subErr) {}
        return null;
      });

      const subResults = await Promise.allSettled(tasks);
      let addedCount = 0;
      let updatedCount = 0;
      let existsCount = 0;
      const subReports = [];

      subResults.forEach((r) => {
        if (r.status === "fulfilled" && r.value) {
          const singleRes = r.value;
          if (singleRes.status === "added") addedCount++;
          if (singleRes.status === "updated") updatedCount++;
          if (singleRes.status === "exists") existsCount++;
          subReports.push(singleRes);
        }
      });

      return {
        status: addedCount > 0 || updatedCount > 0 ? "added" : "exists",
        name: "插件合集订阅",
        version: `${validItems.length}个源`,
        message: `成功解析插件合集! 新增: ${addedCount} 个, 更新: ${updatedCount} 个, 已有: ${existsCount} 个`,
        subReports,
      };
    }

    // B. 处理单个 JS 插件
    const codeStr =
      typeof rawData === "string" ? rawData : JSON.stringify(rawData);
    const plugin = evaluatePluginCode(codeStr);
    if (!plugin) {
      return {
        status: "error",
        name: cleanUrl,
        version: "0.0.0",
        message: "代码格式不符合 MusicFree 插件协议",
      };
    }

    return registerSingleEvaluatedPlugin(
      plugin,
      cleanUrl,
      tier,
      builtInSourcesMap,
      codeStr
    );
  } catch (err) {
    return {
      status: "error",
      name: cleanUrl,
      version: "0.0.0",
      message: `网络连接失败: ${err.message}`,
    };
  }
}

/**
 * 智能同步用户变量中的插件链接（具备 0ms 指纹记忆与本地缓存秒读拦截）
 */
async function syncCustomPlugins(
  tier0UrlsStr = "",
  tier3UrlsStr = "",
  builtInSourcesMap = {}
) {
  const currentFingerprint = `${tier0UrlsStr || ""}###${tier3UrlsStr || ""}`;

  // 1. 检查内存常驻：若配置指纹未变且内存中已有插件，0ms 瞬间返回！
  if (
    currentFingerprint === lastSyncedFingerprint &&
    dynamicRegistry.size > 0
  ) {
    return [];
  }

  // 2. 检查本地硬盘数据库：若内存为空但本地有缓存，直接秒读恢复，无需联网！
  if (dynamicRegistry.size === 0) {
    const restored = restoreDynamicPluginsFromStorage(builtInSourcesMap);
    if (restored > 0 && currentFingerprint === lastSyncedFingerprint) {
      return [];
    }
  }

  // 3. 仅在首次启动或用户修改了 URL 时，才真正向网络请求
  lastSyncedFingerprint = currentFingerprint;
  const allUrls = [];

  if (tier0UrlsStr && typeof tier0UrlsStr === "string") {
    const urls0 = Array.from(
      new Set(
        tier0UrlsStr
          .split(/[\n,;]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"))
      )
    );
    urls0.forEach((u) => allUrls.push({ url: u, tier: "tier0" }));
  }

  if (tier3UrlsStr && typeof tier3UrlsStr === "string") {
    const urls3 = Array.from(
      new Set(
        tier3UrlsStr
          .split(/[\n,;]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"))
      )
    );
    urls3.forEach((u) => allUrls.push({ url: u, tier: "tier3" }));
  }

  if (allUrls.length === 0) return [];

  const tasks = allUrls.map((item) =>
    registerOrUpdatePlugin(item.url, item.tier, builtInSourcesMap)
  );
  return await Promise.allSettled(tasks);
}

/**
 * 一键检查并更新所有当前注册的动态插件
 */
async function updateAllRegisteredPlugins(builtInSourcesMap = {}) {
  const entries = Array.from(dynamicRegistry.entries());
  const tasks = entries.map(([url, reg]) =>
    registerOrUpdatePlugin(url, reg.tier, builtInSourcesMap)
  );
  const results = await Promise.allSettled(tasks);
  persistDynamicPluginsToStorage();
  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { status: "error", message: "更新失败" }
  );
}

/**
 * 获取指定梯队的动态插件列表
 */
function getActiveDynamicPlugins(tier = null) {
  const list = [];
  for (const reg of dynamicRegistry.values()) {
    if (!tier || reg.tier === tier) {
      list.push(reg.plugin);
    }
  }
  return list;
}

module.exports = {
  dynamicRegistry,
  registerOrUpdatePlugin,
  syncCustomPlugins,
  updateAllRegisteredPlugins,
  getActiveDynamicPlugins,
  evaluatePluginCode,
  persistDynamicPluginsToStorage,
  restoreDynamicPluginsFromStorage,
  ensureDynamicPluginsReady,
  deleteDynamicPlugin,
  clearAllDynamicPlugins,
};

  },
  "./core/fallback-pure": function(module, exports, require) {
"use strict";

const axios = require("axios");
const { findBestMatch, cleanTitle, cleanArtist } = require("./matcher");
const { formatDuration } = require("../utils/format");
const {
  syncCustomPlugins,
  getActiveDynamicPlugins,
  dynamicRegistry,
  ensureDynamicPluginsReady,
} = require("./dynamic-loader");
const { matchCache } = require("./cache");

// 纯净版：0 内置源
const builtInSources = {};

/**
 * 包装带有严格超时熔断的搜索任务 (1800ms 超时自动丢弃慢源，绝不卡死界面)
 */
function searchWithTimeout(source, query, page, type, timeoutMs = 1800) {
  return new Promise((resolve) => {
    let timer = null;
    let isSettled = false;

    timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        resolve({ isEnd: true, data: [] });
      }
    }, timeoutMs);

    try {
      source
        .search(query, page, type)
        .then((res) => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            resolve(res || { isEnd: true, data: [] });
          }
        })
        .catch(() => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            resolve({ isEnd: true, data: [] });
          }
        });
    } catch (err) {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({ isEnd: true, data: [] });
      }
    }
  });
}

/**
 * 解析用户黑名单
 */
function getBlacklistSet(env = {}) {
  const blStr = env.tierBlacklist || "";
  if (!blStr || typeof blStr !== "string") return new Set();
  const tokens = blStr
    .toLowerCase()
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(tokens);
}

/**
 * 判断音源是否被黑名单屏蔽
 */
function isSourceBlacklisted(sourceKey, sourceName, blacklistSet) {
  if (blacklistSet.size === 0) return false;
  const k = (sourceKey || "").toLowerCase();
  const n = (sourceName || "").toLowerCase();
  for (const bl of blacklistSet) {
    if (k.includes(bl) || n.includes(bl)) return true;
  }
  return false;
}

/**
 * 获取完整排好序的动态音源列表 (支持 0ms 同步秒读与就绪锁保障)
 */
async function getOrderedSources(env = {}) {
  const sources = [];
  const blacklist = getBlacklistSet(env);

  // 1. 同步加载用户配置的动态插件 (全容错变量名解析 + 0ms 指纹拦截)
  const tier0Urls =
    env.tier0PluginUrls ||
    env.customPluginUrls ||
    env.pluginUrls ||
    env.urls ||
    env.tier0 ||
    "";
  const tier3Urls =
    env.tier3PluginUrls || env.tier3 || env.fallbackUrls || "";

  if (tier0Urls || tier3Urls) {
    try {
      await syncCustomPlugins(
        tier0Urls,
        tier3Urls,
        builtInSources
      );
    } catch (e) {
      console.warn("[FallbackPure] 同步动态插件失败:", e.message);
    }
  }

  // 2. 内存若为空，启动就绪等待锁 (避免冷启动异步读取竞态)
  if (dynamicRegistry.size === 0) {
    await ensureDynamicPluginsReady(2000);
  }

  // 3. 注入 Tier 0 (动态优先源)
  const tier0Plugins = getActiveDynamicPlugins("tier0");
  for (const dp of tier0Plugins) {
    if (!isSourceBlacklisted(dp.key, dp.platform || dp.name, blacklist)) {
      sources.push(dp);
    }
  }

  // 4. 注入 Tier 3 (动态兜底源)
  const tier3Plugins = getActiveDynamicPlugins("tier3");
  for (const dp of tier3Plugins) {
    if (!isSourceBlacklisted(dp.key, dp.platform || dp.name, blacklist)) {
      sources.push(dp);
    }
  }

  return sources;
}

/**
 * 智能搜索结果质量评分（保障原唱/正版优先置顶）
 */
function scoreSearchResult(item, query) {
  let score = 50;
  const rawTitle = item.title || "";
  const cleanT = cleanTitle(rawTitle);
  const cleanA = cleanArtist(item.artist);
  const qClean = cleanTitle(query);
  const lowerTitle = rawTitle.toLowerCase();

  // 1. 标题完全一致加分
  if (cleanT.toLowerCase() === qClean.toLowerCase()) {
    score += 30;
  } else if (cleanT.toLowerCase().includes(qClean.toLowerCase())) {
    score += 15;
  }

  // 2. 搜索词包含歌手名时，精准匹配歌手加分
  const qLower = query.toLowerCase();
  if (cleanA && qLower.includes(cleanA)) {
    score += 25;
  }

  // 3. 流行歌曲正常时长加分 (150s ~ 360s)
  const dur = item.duration || 0;
  if (dur >= 150 && dur <= 360) {
    score += 15;
  } else if (dur > 0 && dur < 100) {
    score -= 30;
  }

  // 4. 噪点标记降权
  if (
    lowerTitle.includes("dj") ||
    lowerTitle.includes("remix") ||
    lowerTitle.includes("慢摇") ||
    lowerTitle.includes("重低音")
  ) {
    score -= 25;
  }
  if (lowerTitle.includes("cover") || lowerTitle.includes("翻唱")) {
    score -= 20;
  }
  if (
    lowerTitle.includes("伴奏") ||
    lowerTitle.includes("instrumental") ||
    lowerTitle.includes("bz") ||
    lowerTitle.includes("无声")
  ) {
    score -= 30;
  }
  if (
    lowerTitle.includes("片段") ||
    lowerTitle.includes("剪辑") ||
    lowerTitle.includes("秒") ||
    lowerTitle.includes("铃声") ||
    lowerTitle.includes("快版") ||
    lowerTitle.includes("降速")
  ) {
    score -= 35;
  }
  if (lowerTitle.includes("live") || lowerTitle.includes("现场")) {
    score -= 5;
  }

  // 5. 有封面图加分
  if (item.artwork && item.artwork.startsWith("http")) {
    score += 5;
  }

  return score;
}

/**
 * 统一多源搜索调度 (极速并发 + 1800ms 慢源熔断)
 */
async function unifiedSearch(query, page = 1, type = "music", env = {}) {
  const orderedSources = await getOrderedSources(env);

  if (orderedSources.length === 0) {
    return {
      isEnd: true,
      data: [
        {
          id: "no_source_notice",
          title: "当前纯净版未配置音源插件",
          artist: "请在插件设置中填入 .js 插件或 .json 订阅链接",
          album: "提示信息",
          duration: 0,
          platform: "智能多源聚合",
        },
      ],
    };
  }

  // 1. 专辑、歌手、歌单类型搜索
  if (type === "album" || type === "artist" || type === "sheet") {
    const validSources = orderedSources.filter(
      (s) => typeof s.search === "function"
    );
    const tasks = validSources.map((s) =>
      searchWithTimeout(s, query, page, type, 2500)
    );
    const results = await Promise.allSettled(tasks);
    const combined = [];

    results.forEach((r, idx) => {
      if (r.status === "fulfilled" && r.value && Array.isArray(r.value.data)) {
        const srcKey = validSources[idx]?.key || validSources[idx]?.name || "";
        r.value.data.forEach((item) => {
          if (type === "artist") {
            const name = item.name || item.artist || item.title || "";
            if (!name) return;
            combined.push({
              ...item,
              name,
              _source: item._source || srcKey,
              platform: "智能多源聚合",
            });
          } else if (type === "album") {
            const title = item.title || item.name || item.album || "";
            if (!title) return;
            combined.push({
              ...item,
              title,
              _source: item._source || srcKey,
              platform: "智能多源聚合",
            });
          } else if (type === "sheet") {
            const title = item.title || item.name || "";
            if (!title) return;
            combined.push({
              ...item,
              title,
              _source: item._source || srcKey,
              platform: "智能多源聚合",
            });
          }
        });
      }
    });

    // 智能排序：完全匹配查询词的项目优先置顶
    const qLower = query.toLowerCase().trim();
    combined.sort((a, b) => {
      const nameA = ((type === "artist" ? a.name : a.title) || "").toLowerCase();
      const nameB = ((type === "artist" ? b.name : b.title) || "").toLowerCase();
      const matchA = nameA === qLower ? 2 : nameA.includes(qLower) ? 1 : 0;
      const matchB = nameB === qLower ? 2 : nameB.includes(qLower) ? 1 : 0;
      return matchB - matchA;
    });

    return {
      isEnd: combined.length < 20,
      data: combined,
    };
  }

  // 2. 歌曲单曲搜索：限制前 10 个最核心源并行检索，单源 1800ms 熔断
  const validMusicSources = orderedSources.filter(
    (s) => typeof s.search === "function"
  );
  const searchTargets = validMusicSources.slice(0, 12);
  const tasks = searchTargets.map((s) =>
    searchWithTimeout(s, query, page, type, 1800)
  );
  const results = await Promise.allSettled(tasks);
  const combined = [];

  results.forEach((r, idx) => {
    if (r.status === "fulfilled" && r.value && Array.isArray(r.value.data)) {
      const sourceName =
        searchTargets[idx].name ||
        searchTargets[idx].platform ||
        "动态源";
      const sourceKey =
        searchTargets[idx].key ||
        searchTargets[idx].platform ||
        sourceName;
      r.value.data.forEach((item) => {
        combined.push({
          ...item,
          duration: formatDuration(item.duration),
          _source: item._source || sourceKey,
          _sourceName: sourceName,
          platform: "智能多源聚合",
        });
      });
    }
  });

  // 去重并计分
  const map = new Map();
  for (const item of combined) {
    const key = `${cleanTitle(item.title)}___${cleanArtist(item.artist)}`;
    if (!map.has(key)) {
      item._rankScore = scoreSearchResult(item, query);
      map.set(key, item);
    } else {
      const exist = map.get(key);
      const curScore = scoreSearchResult(item, query);
      if (curScore > (exist._rankScore || 0)) {
        item._rankScore = curScore;
        map.set(key, item);
      }
    }
  }

  const sorted = Array.from(map.values()).sort(
    (a, b) => b._rankScore - a._rankScore
  );

  return {
    isEnd: sorted.length < 20,
    data: sorted,
  };
}

function isInvalid404Url(url) {
  if (!url || typeof url !== "string") return true;
  return (
    url.includes("/404.html") ||
    url.includes("/404/") ||
    url.endsWith("/404") ||
    url.includes("music.163.com/404")
  );
}

const AUDIO_EXTS = new Set([
  "mp3", "flac", "m4a", "m4s", "aac", "ogg", "wav", "ape", "wma", "opus", "webm"
]);
const SCRIPT_EXTS = new Set([
  "php", "jsp", "asp", "aspx", "do", "action", "cgi"
]);

/**
 * 智能规范化音频媒体源：修复 .php 脚本后缀、追踪 302 真实 CDN 跳转与补全音频后缀
 */
async function normalizeMediaSource(mediaRes) {
  if (!mediaRes || !mediaRes.url || typeof mediaRes.url !== "string") {
    return mediaRes;
  }

  try {
    const rawUrl = mediaRes.url.trim();
    // 提取 pathname 中的后缀
    const cleanPath = rawUrl.split("?")[0].split("#")[0];
    const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
    const ext = match ? match[1].toLowerCase() : "";

    // 1. 若已经是标准音频扩展名，0 延迟直接返回
    if (AUDIO_EXTS.has(ext)) {
      return mediaRes;
    }

    // 2. 若命中脚本后缀（如 .php）或无扩展名，启动轻量 302 追踪与探测
    if (SCRIPT_EXTS.has(ext) || !ext) {
      let finalUrl = rawUrl;
      let contentType = "";

      try {
        const probeRes = await axios.get(rawUrl, {
          headers: mediaRes.headers || {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          maxRedirects: 5,
          timeout: 1500,
          responseType: "stream",
        });

        // 提取 302 重定向后的真实 responseUrl
        if (
          probeRes.request &&
          probeRes.request.res &&
          probeRes.request.res.responseUrl
        ) {
          finalUrl = probeRes.request.res.responseUrl;
        } else if (probeRes.config && probeRes.config.url) {
          finalUrl = probeRes.config.url;
        }

        if (probeRes.headers) {
          contentType = (
            probeRes.headers["content-type"] || ""
          ).toLowerCase();
        }

        if (probeRes.data && typeof probeRes.data.destroy === "function") {
          probeRes.data.destroy();
        }
      } catch (probeErr) {
        // 探测失败时保持 rawUrl
      }

      // 检查追踪后的 URL 是否带有标准音频后缀
      const finalCleanPath = finalUrl.split("?")[0].split("#")[0];
      const finalMatch = finalCleanPath.match(/\.([a-zA-Z0-9]+)$/);
      const finalExt = finalMatch ? finalMatch[1].toLowerCase() : "";

      if (AUDIO_EXTS.has(finalExt)) {
        return {
          ...mediaRes,
          url: finalUrl,
        };
      }

      // 若追踪后仍无音频后缀或仍为脚本路径，根据 Content-Type 或默认 mp3 修正
      let targetExt = "mp3";
      if (contentType.includes("flac")) targetExt = "flac";
      else if (
        contentType.includes("mp4") ||
        contentType.includes("m4a") ||
        contentType.includes("aac")
      )
        targetExt = "m4a";
      else if (contentType.includes("ogg")) targetExt = "ogg";
      else if (contentType.includes("wav")) targetExt = "wav";

      const fixedUrl = finalUrl.includes("?")
        ? `${finalUrl}&_ext=.${targetExt}`
        : `${finalUrl}?_ext=.${targetExt}`;

      return {
        ...mediaRes,
        url: fixedUrl,
        _inferredExt: targetExt,
      };
    }
  } catch (err) {
    // 异常安全兜底
  }

  return mediaRes;
}

/**
 * 纯净版自动换源调度 (全量 30+ 源完整容灾)
 */
async function resolveMediaSourceWithFallback(
  musicItem,
  quality = "standard",
  env = {}
) {
  const allowDowngrade =
    env.autoQualityDowngrade !== "false" && env.autoQualityDowngrade !== false;
  const enableCache =
    env.enableMatchCache !== "false" && env.enableMatchCache !== false;

  const target = {
    title: musicItem.title || "",
    artist: musicItem.artist || "",
    duration: musicItem.duration || 0,
  };

  const titleClean = cleanTitle(target.title);
  const artistClean = cleanArtist(target.artist);

  if (!titleClean) {
    throw new Error("歌曲元数据不足，无法进行自动换源检索");
  }

  // Step 0: 检查换源记忆表 (10ms 秒开)
  if (enableCache) {
    const cachedMatch = matchCache.get(target.title, target.artist);
    if (cachedMatch && cachedMatch.sourceKey) {
      let cachedSource = null;
      for (const reg of dynamicRegistry.values()) {
        if (
          reg.plugin.key === cachedMatch.sourceKey ||
          reg.plugin.platform === cachedMatch.sourceKey
        ) {
          cachedSource = reg.plugin;
          break;
        }
      }

      if (cachedSource && typeof cachedSource.getMediaSource === "function") {
        try {
          const cachedRes = await cachedSource.getMediaSource(
            cachedMatch.item,
            quality
          );
          if (
            cachedRes &&
            cachedRes.url &&
            cachedRes.url.startsWith("http") &&
            !isInvalid404Url(cachedRes.url)
          ) {
            const normRes = await normalizeMediaSource(cachedRes);
            return {
              ...normRes,
              platform: "智能多源聚合",
              _sourceUsed: cachedSource.name || cachedMatch.sourceKey,
              _fromMemoryCache: true,
              _matchedSong: `${cachedMatch.item.title} - ${cachedMatch.item.artist}`,
            };
          } else {
            matchCache.invalidate(target.title, target.artist);
          }
        } catch (err) {
          matchCache.invalidate(target.title, target.artist);
        }
      }
    }
  }

  // -------------------------------------------------------------
  // Step 0: 原生源优先直连 (若曲目自带有效 _source 且已加载，优先尝试)
  // -------------------------------------------------------------
  const orderedSources = await getOrderedSources(env);
  if (orderedSources.length === 0) {
    throw new Error("当前纯净版未加载任何可用音源，请先在设置中填入音源插件链接");
  }

  const origSourceKey = (musicItem._source || "").toLowerCase();
  let primaryTriedAndFailed = false;

  if (origSourceKey) {
    const origSource = orderedSources.find(
      (s) => (s.key && s.key.toLowerCase() === origSourceKey) ||
             (s.platform && s.platform.toLowerCase() === origSourceKey) ||
             (s.name && s.name.toLowerCase() === origSourceKey)
    );

    if (origSource && typeof origSource.getMediaSource === "function") {
      try {
        const res = await origSource.getMediaSource(musicItem, quality);
        if (
          res &&
          res.url &&
          res.url.startsWith("http") &&
          !isInvalid404Url(res.url)
        ) {
          const normRes = await normalizeMediaSource(res);
          return {
            ...normRes,
            platform: "智能多源聚合",
            _sourceUsed: origSource.name || origSource.platform || origSourceKey,
          };
        } else {
          primaryTriedAndFailed = true;
        }
      } catch (err) {
        primaryTriedAndFailed = true;
      }
    }
  }

  // -------------------------------------------------------------
  // Step 1: 分梯队高速并发竞速换源 (第一梯队 Top 6 源并行搜索，0.8s 极速出声)
  // -------------------------------------------------------------
  const queryStr = artistClean ? `${titleClean} ${artistClean}` : titleClean;
  const CHUNK_SIZE = 6; // 每批并发 6 个优质音源
  const chunks = [];
  for (let i = 0; i < orderedSources.length; i += CHUNK_SIZE) {
    chunks.push(orderedSources.slice(i, i + CHUNK_SIZE));
  }

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunkSources = chunks[chunkIdx];

    // 6 路并发并行搜索 (单次 1600ms 快速熔断)
    const searchTasks = chunkSources.map(async (source) => {
      if (
        typeof source.search !== "function" ||
        typeof source.getMediaSource !== "function"
      ) {
        return null;
      }
      try {
        const res = await searchWithTimeout(source, queryStr, 1, "music", 1600);
        let list = res && Array.isArray(res.data) ? res.data : [];
        if (list.length === 0 && artistClean) {
          const fallbackRes = await searchWithTimeout(
            source,
            titleClean,
            1,
            "music",
            1200
          );
          if (fallbackRes && Array.isArray(fallbackRes.data))
            list = fallbackRes.data;
        }

        if (list.length > 0) {
          const match = findBestMatch(target, list, 55);
          if (match) {
            return {
              source,
              bestMatch: match,
              score: match._matchScore || 0,
            };
          }
        }
      } catch (e) {}
      return null;
    });

    const searchResults = await Promise.allSettled(searchTasks);
    const validMatches = [];
    for (const r of searchResults) {
      if (r.status === "fulfilled" && r.value) {
        validMatches.push(r.value);
      }
    }

    if (validMatches.length > 0) {
      // 按照匹配得分从高到低排序，原唱优先
      validMatches.sort((a, b) => b.score - a.score);

      // 依次快速拉取最高分音源的音频直链
      for (const candidate of validMatches.slice(0, 3)) {
        try {
          let mediaRes = await candidate.source.getMediaSource(
            candidate.bestMatch,
            quality
          );

          if (
            (!mediaRes || !mediaRes.url || !mediaRes.url.startsWith("http")) &&
            allowDowngrade &&
            quality !== "standard" &&
            quality !== "low"
          ) {
            mediaRes = await candidate.source.getMediaSource(
              candidate.bestMatch,
              "standard"
            );
          }

          if (
            mediaRes &&
            mediaRes.url &&
            mediaRes.url.startsWith("http") &&
            !isInvalid404Url(mediaRes.url)
          ) {
            if (enableCache) {
              const sKey =
                candidate.source.key ||
                candidate.source.platform ||
                candidate.source.name ||
                "unknown";
              matchCache.set(
                target.title,
                target.artist,
                sKey,
                candidate.bestMatch
              );
            }

            const normRes = await normalizeMediaSource(mediaRes);
            return {
              ...normRes,
              platform: "智能多源聚合",
              _sourceUsed:
                candidate.source.name ||
                candidate.source.platform ||
                "动态源",
              _matchedSong: `${candidate.bestMatch.title} - ${candidate.bestMatch.artist}`,
              _matchScore: candidate.bestMatch._matchScore,
            };
          }
        } catch (mediaErr) {}
      }
    }
  }

  throw new Error(
    `已加载的动态音源均无法播放歌曲: ${target.title} - ${target.artist}`
  );
}

/**
 * 纯净版歌词自动补全
 */
async function resolveLyricWithFallback(musicItem, env = {}) {
  const orderedSources = await getOrderedSources(env);
  const target = {
    title: musicItem.title || "",
    artist: musicItem.artist || "",
    duration: musicItem.duration || 0,
  };
  const titleClean = cleanTitle(target.title);
  const artistClean = cleanArtist(target.artist);

  for (const source of orderedSources) {
    if (typeof source.getLyric !== "function") continue;
    try {
      let candidateList = [];
      if (artistClean) {
        const r1 = await searchWithTimeout(
          source,
          `${titleClean} ${artistClean}`,
          1,
          "music",
          1200
        );
        if (r1 && Array.isArray(r1.data) && r1.data.length > 0)
          candidateList = r1.data;
      }
      if (candidateList.length === 0) {
        const r2 = await searchWithTimeout(
          source,
          titleClean,
          1,
          "music",
          1200
        );
        if (r2 && Array.isArray(r2.data) && r2.data.length > 0)
          candidateList = r2.data;
      }

      if (candidateList.length > 0) {
        const bestMatch = findBestMatch(target, candidateList, 55);
        if (bestMatch) {
          const lrcRes = await source.getLyric(bestMatch);
          if (lrcRes && lrcRes.rawLrc && lrcRes.rawLrc.trim().length > 10) {
            return lrcRes;
          }
        }
      }
    } catch (e) {}
  }

  return { rawLrc: "" };
}

/**
 * 纯净版聚合官方榜单与动态插件榜单 (多源容灾)
 */
async function resolveTopLists(env = {}) {
  const results = [];
  const tasks = [];

  // 1. 优先聚合已加载的动态音源插件榜单
  const orderedSources = await getOrderedSources(env);
  for (const source of orderedSources) {
    if (typeof source.getTopLists === "function") {
      tasks.push(
        source.getTopLists().then((res) => {
          if (Array.isArray(res)) {
            return res.map((group) => ({
              ...group,
              title: `[动态源] ${group.title || source.platform || source.name || "自定义榜单"}`,
            }));
          }
          return [];
        }).catch(() => [])
      );
    }
  }

  // 2. 网易云官方榜单
  tasks.push(
    axios.get("https://music.163.com/api/toplist", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://music.163.com/",
      },
      timeout: 8000,
    }).then((res) => {
      const list = res.data?.list || [];
      return [
        {
          title: "网易云音乐官方榜单",
          data: list.map((item) => ({
            id: `ne_${item.id}`,
            sheetId: item.id,
            title: item.name,
            artwork: item.coverImgUrl,
            description: item.description || "",
            platform: "智能多源聚合",
            _source: "netease",
          })),
        },
      ];
    }).catch(() => [])
  );

  // 3. 酷我音乐官方榜单
  const KUWO_BANGS = [
    { id: "16", title: "酷我热歌榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/16.jpg", description: "酷我音乐全网热播金曲" },
    { id: "17", title: "酷我新歌榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/17.jpg", description: "酷我音乐最新发行优质单曲" },
    { id: "93", title: "抖音热歌榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/93.jpg", description: "短视频爆款流行神曲" },
    { id: "62", title: "酷我飙升榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/62.jpg", description: "当前搜索与播放飙升热单" },
    { id: "158", title: "快手热歌榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/158.jpg", description: "快手平台热门背景音乐" },
    { id: "187", title: "国风热歌榜", artwork: "https://img4.kuwo.cn/star/albumcover/300/187.jpg", description: "全网国风古韵高人气热曲" },
  ];
  tasks.push(
    Promise.resolve([
      {
        title: "酷我音乐官方榜单",
        data: KUWO_BANGS.map((b) => ({
          id: `kw_${b.id}`,
          bangId: b.id,
          title: b.title,
          artwork: b.artwork,
          description: b.description,
          platform: "智能多源聚合",
          _source: "kuwo",
        })),
      },
    ])
  );

  // 4. QQ音乐官方榜单
  tasks.push(
    axios.get("https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg", {
      params: {
        format: "json",
        g_tk: 5381,
        uin: 0,
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: 0,
        platform: "h5",
        needNewCode: 1,
      },
      headers: { Referer: "https://y.qq.com/" },
      timeout: 8000,
    }).then((res) => {
      const list = res.data?.data?.topList || [];
      return [
        {
          title: "QQ音乐官方榜单",
          data: list.map((item) => ({
            id: `qq_${item.id}`,
            topId: item.id,
            title: item.topTitle,
            artwork: item.pic_v12 || item.pic_h5 || item.pic || "",
            description: `收听人数: ${item.listenCount || "热播"}`,
            platform: "智能多源聚合",
            _source: "qq",
          })),
        },
      ];
    }).catch(() => [])
  );

  const allSettled = await Promise.allSettled(tasks);
  for (const item of allSettled) {
    if (item.status === "fulfilled" && Array.isArray(item.value)) {
      for (const group of item.value) {
        if (group && Array.isArray(group.data) && group.data.length > 0) {
          group.data.forEach((t) => {
            t.platform = "智能多源聚合";
          });
          results.push(group);
        }
      }
    }
  }

  return results;
}

/**
 * 获取榜单歌曲详情 (多源容灾)
 */
async function resolveTopListDetail(topListItem, env = {}) {
  // 1. 尝试动态插件获取
  const orderedSources = await getOrderedSources(env);
  for (const source of orderedSources) {
    if (typeof source.getTopListDetail === "function") {
      try {
        const res = await source.getTopListDetail(topListItem);
        if (res && Array.isArray(res.musicList) && res.musicList.length > 0) {
          res.musicList = res.musicList.map((s) => ({
            ...s,
            duration: formatDuration(s.duration),
            platform: "智能多源聚合",
          }));
          return res;
        }
      } catch (e) {}
    }
  }

  const rawId = String(topListItem.sheetId || topListItem.bangId || topListItem.topId || topListItem.id || "");

  // 2. 酷我榜单详情
  if (topListItem._source === "kuwo" || String(topListItem.id).startsWith("kw_")) {
    const cleanId = rawId.replace("kw_", "");
    try {
      const res = await axios.get("http://kbangserver.kuwo.cn/ksong.s", {
        params: {
          from: "pc",
          fmt: "json",
          type: "bang",
          data: "bang",
          id: cleanId,
          pn: 0,
          rn: 50,
        },
        timeout: 8000,
      });
      const musiclist = res.data?.musiclist || [];
      const songs = musiclist.map((item) => {
        const rid = item.musicrid || item.id || item.MUSICRID || "";
        const cId = String(rid).replace("MUSIC_", "");
        return {
          id: cId,
          musicrid: rid,
          title: (item.name || item.songname || item.SONGNAME || "").replace(/&nbsp;/g, " "),
          artist: (item.artist || item.ARTIST || "").replace(/&nbsp;/g, " "),
          album: (item.album || item.ALBUM || "").replace(/&nbsp;/g, " "),
          artwork: item.pic || item.pic120 || item.cover || topListItem.artwork || "",
          duration: formatDuration(item.duration),
          platform: "智能多源聚合",
          _source: "kuwo",
        };
      });
      return {
        ...topListItem,
        musicList: songs,
        description: topListItem.description || res.data?.info || "",
      };
    } catch (e) {}
  }

  // 3. QQ 榜单详情
  if (topListItem._source === "qq" || String(topListItem.id).startsWith("qq_")) {
    const cleanId = rawId.replace("qq_", "");
    try {
      const res = await axios.get("https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg", {
        params: {
          g_tk: 5381,
          uin: 0,
          format: "json",
          inCharset: "utf-8",
          outCharset: "utf-8",
          notice: 0,
          platform: "h5",
          needNewCode: 1,
          tpl: 3,
          page: "detail",
          type: "top",
          topid: cleanId,
          song_begin: 0,
          song_num: 50,
        },
        headers: { Referer: "https://y.qq.com/" },
        timeout: 8000,
      });
      const songlist = res.data?.songlist || [];
      const songs = songlist.map((item) => {
        const s = item.data || item;
        return {
          id: String(s.songmid || s.songid || ""),
          songmid: s.songmid,
          title: s.songname || s.title || "",
          artist: (s.singer || []).map((x) => x.name).join(", ") || "",
          album: s.albumname || "",
          artwork: s.albummid
            ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
            : topListItem.artwork || "",
          duration: formatDuration(s.interval),
          platform: "智能多源聚合",
          _source: "qq",
        };
      });
      return {
        ...topListItem,
        musicList: songs,
        description: topListItem.description || res.data?.topinfo?.info || "",
      };
    } catch (e) {}
  }

  // 4. 网易云榜单详情
  try {
    const cleanId = rawId.replace("ne_", "");
    const res = await axios.get(
      `https://music.163.com/api/v6/playlist/detail?id=${cleanId}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://music.163.com/",
        },
        timeout: 8000,
      }
    );
    const playlist = res.data?.playlist;
    const tracks = (playlist?.tracks || []).map((s) => ({
      id: String(s.id),
      title: s.name,
      artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
      album: s.al?.name || "",
      artwork: s.al?.picUrl || "",
      duration: formatDuration(s.dt ? Math.floor(s.dt / 1000) : 0),
      platform: "智能多源聚合",
      _source: "netease",
    }));

    return {
      ...topListItem,
      musicList: tracks,
      description: playlist?.description || topListItem.description || "",
    };
  } catch (err) {
    return { ...topListItem, musicList: [] };
  }
}

/**
 * 获取推荐歌单标签
 */
async function resolveRecommendSheetTags() {
  return {
    pinned: [
      { id: "华语", title: "华语" },
      { id: "流行", title: "流行" },
      { id: "摇滚", title: "摇滚" },
      { id: "民谣", title: "民谣" },
      { id: "电子", title: "电子" },
      { id: "ACG", title: "二次元" },
      { id: "轻音乐", title: "轻音乐" },
      { id: "古风", title: "古风" },
      { id: "说唱", title: "说唱" },
    ],
    data: [
      {
        title: "语种",
        data: [
          { id: "华语", title: "华语" },
          { id: "欧美", title: "欧美" },
          { id: "日语", title: "日语" },
          { id: "韩语", title: "韩语" },
          { id: "粤语", title: "粤语" },
        ],
      },
      {
        title: "风格",
        data: [
          { id: "流行", title: "流行" },
          { id: "摇滚", title: "摇滚" },
          { id: "民谣", title: "民谣" },
          { id: "电子", title: "电子" },
          { id: "说唱", title: "说唱" },
          { id: "轻音乐", title: "轻音乐" },
          { id: "爵士", title: "爵士" },
          { id: "古典", title: "古典" },
          { id: "古风", title: "古风" },
          { id: "ACG", title: "ACG" },
        ],
      },
      {
        title: "场景",
        data: [
          { id: "清晨", title: "清晨" },
          { id: "夜晚", title: "夜晚" },
          { id: "学习", title: "学习" },
          { id: "工作", title: "工作" },
          { id: "运动", title: "运动" },
          { id: "旅行", title: "旅行" },
          { id: "驾车", title: "驾车" },
        ],
      },
      {
        title: "情感",
        data: [
          { id: "怀旧", title: "怀旧" },
          { id: "清新", title: "清新" },
          { id: "治愈", title: "治愈" },
          { id: "放松", title: "放松" },
          { id: "孤独", title: "孤独" },
          { id: "感动", title: "感动" },
          { id: "快乐", title: "快乐" },
          { id: "安静", title: "安静" },
        ],
      },
    ],
  };
}

/**
 * 按标签获取热门/推荐歌单
 */
async function resolveRecommendSheetsByTag(tag, page = 1) {
  const cat = tag?.id || tag?.title || "全部";
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const res = await axios.get(
      `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(
        cat
      )}&limit=${limit}&offset=${offset}&order=hot`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://music.163.com/",
        },
        timeout: 8000,
      }
    );

    const playlists = res.data?.playlists || [];
    return {
      isEnd: playlists.length < limit,
      data: playlists.map((p) => ({
        id: String(p.id),
        title: p.name,
        artwork: p.coverImgUrl || p.picUrl,
        playCount: p.playCount,
        worksNum: p.trackCount,
        description: p.description || "",
        platform: "智能多源聚合",
      })),
    };
  } catch (err) {
    return { isEnd: true, data: [] };
  }
}

/**
 * 获取歌单内歌曲详情（所有曲目打上聚合标识，100% 支持自动容灾）
 */
async function resolveMusicSheetInfo(sheetItem, page = 1) {
  let res = null;

  // 1. 尝试直接通过 ID 获取网易云歌单
  if (sheetItem.id) {
    try {
      const apiRes = await axios.get(
        `https://music.163.com/api/v6/playlist/detail?id=${sheetItem.id}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://music.163.com/",
          },
          timeout: 8000,
        }
      );

      const playlist = apiRes.data?.playlist;
      if (playlist && Array.isArray(playlist.tracks) && playlist.tracks.length > 0) {
        const tracks = playlist.tracks.map((s) => ({
          id: String(s.id),
          title: s.name,
          artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
          album: s.al?.name || "",
          artwork: s.al?.picUrl || "",
          duration: formatDuration(s.dt || s.duration),
          platform: "智能多源聚合",
        }));

        res = {
          isEnd: true,
          musicList: tracks,
          sheetItem: {
            ...sheetItem,
            description: playlist?.description || sheetItem.description || "",
            worksNum: playlist?.trackCount || tracks.length,
            playCount: playlist?.playCount || sheetItem.playCount,
          },
        };
      }
    } catch (err) {}
  }

  // 2. 安全兜底：通过歌单标题在网易云精确检索
  if ((!res || !Array.isArray(res.musicList) || res.musicList.length === 0) && sheetItem.title) {
    try {
      const searchRes = await axios.get("https://music.163.com/api/search/get/web", {
        params: { s: sheetItem.title, type: 1000, limit: 1 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactSheet = searchRes.data?.result?.playlists?.[0];
      if (exactSheet && exactSheet.id) {
        const detailRes = await axios.get(
          `https://music.163.com/api/v6/playlist/detail?id=${exactSheet.id}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Referer: "https://music.163.com/",
            },
            timeout: 8000,
          }
        );
        const playlist = detailRes.data?.playlist;
        if (playlist && Array.isArray(playlist.tracks)) {
          const tracks = playlist.tracks.map((s) => ({
            id: String(s.id),
            title: s.name,
            artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
            album: s.al?.name || "",
            artwork: s.al?.picUrl || "",
            duration: formatDuration(s.dt || s.duration),
            platform: "智能多源聚合",
          }));

          res = {
            isEnd: true,
            musicList: tracks,
            sheetItem: {
              ...sheetItem,
              description: playlist?.description || sheetItem.description || "",
              worksNum: playlist?.trackCount || tracks.length,
              playCount: playlist?.playCount || sheetItem.playCount,
            },
          };
        }
      }
    } catch (err) {}
  }

  return res || { isEnd: true, musicList: [] };
}

/**
 * 纯净版获取专辑详情
 */
async function resolveAlbumInfo(albumItem, page = 1) {
  let res = null;

  // 1. 尝试直接按 ID 获取
  if (albumItem.id) {
    try {
      const apiRes = await axios.get(
        `https://music.163.com/api/v1/album/${albumItem.id}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: "https://music.163.com/",
          },
          timeout: 8000,
        }
      );
      if (apiRes.data?.songs && apiRes.data.songs.length > 0) {
        const songs = apiRes.data.songs.map((s) => ({
          id: String(s.id),
          title: s.name,
          artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
          album: albumItem.title || apiRes.data?.album?.name || "",
          artwork: s.al?.picUrl || albumItem.artwork || "",
          duration: formatDuration(s.dt || s.duration),
          platform: "智能多源聚合",
        }));
        res = { isEnd: true, musicList: songs };
      }
    } catch (e) {}
  }

  // 2. 安全兜底：通过专辑名称与作者检索真实专辑
  if ((!res || !Array.isArray(res.musicList) || res.musicList.length === 0) && albumItem.title) {
    try {
      const q = `${albumItem.title} ${albumItem.artist || ""}`.trim();
      const searchRes = await axios.get("https://music.163.com/api/search/get/web", {
        params: { s: q, type: 10, limit: 1 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactAlbum = searchRes.data?.result?.albums?.[0];
      if (exactAlbum && exactAlbum.id) {
        const detailRes = await axios.get(
          `https://music.163.com/api/v1/album/${exactAlbum.id}`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://music.163.com/",
            },
            timeout: 8000,
          }
        );
        if (detailRes.data?.songs && detailRes.data.songs.length > 0) {
          const songs = detailRes.data.songs.map((s) => ({
            id: String(s.id),
            title: s.name,
            artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
            album: albumItem.title || exactAlbum.name || "",
            artwork: s.al?.picUrl || albumItem.artwork || "",
            duration: formatDuration(s.dt || s.duration),
            platform: "智能多源聚合",
          }));
          res = { isEnd: true, musicList: songs };
        }
      }
    } catch (e) {}
  }

  return res || { isEnd: true, musicList: [] };
}

/**
 * 纯净版获取歌手作品
 */
async function resolveArtistWorks(artistItem, page = 1, type = "music") {
  let res = null;

  // 1. 如果有合法 ID，尝试按 ID 获取
  if (artistItem.id) {
    try {
      if (type === "music") {
        const apiRes = await axios.get(
          `https://music.163.com/api/v1/artist/${artistItem.id}`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://music.163.com/",
            },
            timeout: 8000,
          }
        );
        if (apiRes.data?.hotSongs && apiRes.data.hotSongs.length > 0) {
          const hotSongs = apiRes.data.hotSongs.map((s) => ({
            id: String(s.id),
            title: s.name,
            artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
            album: s.al?.name || "",
            artwork: s.al?.picUrl || "",
            duration: formatDuration(s.dt || s.duration),
            platform: "智能多源聚合",
          }));
          res = { isEnd: true, data: hotSongs };
        }
      }

      if (type === "album") {
        const limit = 20;
        const offset = (page - 1) * limit;
        const apiRes = await axios.get(
          `https://music.163.com/api/artist/albums/${artistItem.id}`,
          {
            params: { limit, offset },
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://music.163.com/",
            },
            timeout: 8000,
          }
        );
        if (apiRes.data?.hotAlbums && apiRes.data.hotAlbums.length > 0) {
          const hotAlbums = apiRes.data.hotAlbums.map((a) => ({
            id: String(a.id),
            title: a.name,
            artwork: a.picUrl || "",
            artist: artistItem.name || "",
            date: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : "",
            platform: "智能多源聚合",
          }));
          res = {
            isEnd: offset + hotAlbums.length >= (apiRes.data?.total || 0),
            data: hotAlbums,
          };
        }
      }
    } catch (e) {}
  }

  // 2. 安全兜底：通过歌手名称在网易云精确检索真实歌手 ID
  if ((!res || !Array.isArray(res.data) || res.data.length === 0) && artistItem.name) {
    try {
      const searchRes = await axios.get("https://music.163.com/api/search/get/web", {
        params: { s: artistItem.name, type: 100, limit: 5 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactArtist = (searchRes.data?.result?.artists || []).find(
        (a) => (a.name || "").trim().toLowerCase() === artistItem.name.trim().toLowerCase()
      ) || searchRes.data?.result?.artists?.[0];

      if (exactArtist && exactArtist.id) {
        if (type === "music") {
          const detailRes = await axios.get(
            `https://music.163.com/api/v1/artist/${exactArtist.id}`,
            {
              headers: {
                "User-Agent": "Mozilla/5.0",
                Referer: "https://music.163.com/",
              },
              timeout: 8000,
            }
          );
          const hotSongs = (detailRes.data?.hotSongs || []).map((s) => ({
            id: String(s.id),
            title: s.name,
            artist: (s.ar || s.artists || []).map((a) => a.name).join(", "),
            album: s.al?.name || "",
            artwork: s.al?.picUrl || "",
            duration: formatDuration(s.dt || s.duration),
            platform: "智能多源聚合",
          }));
          res = { isEnd: true, data: hotSongs };
        }

        if (type === "album") {
          const limit = 20;
          const offset = (page - 1) * limit;
          const detailRes = await axios.get(
            `https://music.163.com/api/artist/albums/${exactArtist.id}`,
            {
              params: { limit, offset },
              headers: {
                "User-Agent": "Mozilla/5.0",
                Referer: "https://music.163.com/",
              },
              timeout: 8000,
            }
          );
          const hotAlbums = (detailRes.data?.hotAlbums || []).map((a) => ({
            id: String(a.id),
            title: a.name,
            artwork: a.picUrl || "",
            artist: artistItem.name || "",
            date: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : "",
            platform: "智能多源聚合",
          }));
          res = {
            isEnd: offset + hotAlbums.length >= (detailRes.data?.total || 0),
            data: hotAlbums,
          };
        }
      }
    } catch (e) {}
  }

  return res || { isEnd: true, data: [] };
}

module.exports = {
  unifiedSearch,
  resolveMediaSourceWithFallback,
  resolveLyricWithFallback,
  resolveTopLists,
  resolveTopListDetail,
  resolveRecommendSheetTags,
  resolveRecommendSheetsByTag,
  resolveMusicSheetInfo,
  resolveAlbumInfo,
  resolveArtistWorks,
  getOrderedSources,
  builtInSources,
  matchCache,
  getBlacklistSet,
};

  },
  "./index-pure": function(module, exports, require) {
"use strict";

const config = require("./config-pure");
const {
  unifiedSearch,
  resolveMediaSourceWithFallback,
  resolveLyricWithFallback,
  resolveTopLists,
  resolveTopListDetail,
  resolveRecommendSheetTags,
  resolveRecommendSheetsByTag,
  resolveMusicSheetInfo,
  resolveAlbumInfo,
  resolveArtistWorks,
  getOrderedSources,
  builtInSources,
} = require("./core/fallback-pure");
const {
  registerOrUpdatePlugin,
  updateAllRegisteredPlugins,
  deleteDynamicPlugin,
  clearAllDynamicPlugins,
} = require("./core/dynamic-loader");
const { matchCache } = require("./core/cache");

/**
 * 跨平台安全读取 MusicFree 注入的用户变量 (env.getUserVariables)
 */
function getUserEnv() {
  try {
    if (typeof env !== "undefined" && env && typeof env.getUserVariables === "function") {
      return env.getUserVariables() || {};
    }
  } catch (e) {}

  try {
    if (typeof globalThis !== "undefined" && globalThis.env && typeof globalThis.env.getUserVariables === "function") {
      return globalThis.env.getUserVariables() || {};
    }
  } catch (e) {}

  if (typeof userVariables !== "undefined" && userVariables && typeof userVariables === "object") {
    return userVariables;
  }

  return {};
}

/**
 * 递归从备份对象中提取所有歌曲对象
 */
function extractSongsFromBackup(data) {
  const songs = [];

  function traverse(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(traverse);
      return;
    }

    if (obj.title && (obj.id || obj.artist || obj.singer)) {
      songs.push({
        id: String(obj.id || Math.random().toString(36).slice(2)),
        title: obj.title || obj.songname || obj.name,
        artist: obj.artist || obj.singer || obj.author || "",
        album: obj.album || obj.albumname || "",
        artwork: obj.artwork || obj.pic || obj.cover || config.defaultArtwork,
        duration: obj.duration || obj.interval || 0,
        platform: config.platform,
        _source: obj.platform || obj._source || "",
      });
      return;
    }

    if (obj.musicList && Array.isArray(obj.musicList)) {
      obj.musicList.forEach(traverse);
    }
    if (obj.musicSheets && Array.isArray(obj.musicSheets)) {
      obj.musicSheets.forEach(traverse);
    }
    if (obj.sheets && Array.isArray(obj.sheets)) {
      obj.sheets.forEach(traverse);
    }
    if (obj.data && Array.isArray(obj.data)) {
      obj.data.forEach(traverse);
    }
  }

  traverse(data);
  return songs;
}

/**
 * 插件主接口对象 (纯净版: 0 内置源，全量依靠用户自定义动态插件或合集订阅)
 */
const plugin = {
  platform: config.platform,
  version: config.version,
  author: config.author,
  srcUrl: config.srcUrl,
  description: config.description,
  cacheControl: config.cacheControl,
  supportedSearchType: config.supportedSearchType,
  hints: config.hints,
  userVariables: config.userVariables,

  /**
   * 动态多源聚合搜索
   */
  async search(query, page = 1, type = "music") {
    const userEnv = getUserEnv();
    return await unifiedSearch(query, page, type, userEnv);
  },

  /**
   * 动态多源容灾与自动换源播放
   */
  async getMediaSource(musicItem, quality = "standard") {
    const userEnv = getUserEnv();
    return await resolveMediaSourceWithFallback(musicItem, quality, userEnv);
  },

  /**
   * 歌词动态跨源自动补全
   */
  async getLyric(musicItem) {
    const userEnv = getUserEnv();
    return await resolveLyricWithFallback(musicItem, userEnv);
  },

  /**
   * 获取官方榜单 (使插件出现在客户端【排行榜】分类中)
   */
  async getTopLists() {
    return await resolveTopLists();
  },

  /**
   * 获取榜单详情
   */
  async getTopListDetail(topListItem) {
    return await resolveTopListDetail(topListItem);
  },

  /**
   * 获取热门/推荐歌单标签 (使插件出现在客户端【热门歌单】分类中)
   */
  async getRecommendSheetTags() {
    return await resolveRecommendSheetTags();
  },

  /**
   * 按标签获取热门/推荐歌单列表
   */
  async getRecommendSheetsByTag(tag, page = 1) {
    return await resolveRecommendSheetsByTag(tag, page);
  },

  /**
   * 获取歌单内歌曲列表详情
   */
  async getMusicSheetInfo(sheetItem, page = 1) {
    return await resolveMusicSheetInfo(sheetItem, page);
  },

  /**
   * 获取专辑详情
   */
  async getAlbumInfo(albumItem, page = 1) {
    return await resolveAlbumInfo(albumItem, page);
  },

  /**
   * 获取歌手作品
   */
  async getArtistWorks(artistItem, page = 1, type = "music") {
    return await resolveArtistWorks(artistItem, page, type);
  },

  /**
   * 智能控制台 / 歌单导入 / 一键更新与插件热添加中心
   */
  async importMusicSheet(urlLike) {
    if (!urlLike || typeof urlLike !== "string") return [];
    const text = urlLike.trim();
    const userEnv = getUserEnv();

    // 指令 1: 查看音源状态看板 ("status" / "源" / "看板" / "音源")
    if (
      text === "status" ||
      text === "源" ||
      text === "看板" ||
      text === "音源" ||
      text === "list"
    ) {
      const activeSources = await getOrderedSources(userEnv);
      if (activeSources.length === 0) {
        return [
          {
            id: "no_active_source",
            title: "当前纯净版未加载任何音源",
            artist: "提示: 请在用户变量【优先音源】中添加 .js 插件或 .json 合集链接",
            album: "状态: 空闲",
            artwork: config.defaultArtwork,
            duration: 0,
            platform: config.platform,
          },
        ];
      }
      return activeSources.map((s, idx) => {
        const name = s.name || s.platform || "未知音源";
        const ver = s.version || "1.0.0";
        const tier = s._tier || (idx < 5 ? "Tier 0 动态优先" : "Tier 3 动态兜底");
        return {
          id: `source_status_${idx}`,
          title: `[${tier}] ${name} (v${ver})`,
          artist: `状态: 在线活跃 · 动态热加载 · 输入 'del ${name}' 可删除`,
          album: `优先级位次: 第 ${idx + 1} 位`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        };
      });
    }

    // 指令 2: 一键检查并更新所有源 ("update" / "更新" / "check")
    if (text === "update" || text === "更新" || text === "check") {
      const reports = await updateAllRegisteredPlugins(builtInSources);
      const items = [];

      items.push({
        id: "builtin_core_status",
        title: `[核心引擎] 智能多源聚合 (纯净版 v${config.version})`,
        artist: `作者: ${config.author} · 纯净模式 (0 内置源)`,
        album: `运行环境: MusicFree Desktop/Android`,
        artwork: config.defaultArtwork,
        duration: 0,
        platform: config.platform,
      });

      if (reports.length === 0) {
        items.push({
          id: "no_dyn_report",
          title: `[更新报告] 当前未配置外部动态插件`,
          artist: `提示: 可在用户变量【优先音源】中填入 .js 插件或 .json 合集链接`,
          album: `状态: 待配置`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        });
      } else {
        reports.forEach((r, i) => {
          let statusText = "已是最新版本";
          if (r.status === "updated") statusText = `已升级至 v${r.version}`;
          if (r.status === "added") statusText = `新增注册成功 v${r.version}`;
          if (r.status === "error") statusText = `更新异常: ${r.message}`;

          items.push({
            id: `update_report_${i}`,
            title: `[${r.status === "error" ? "失败" : "成功"}] ${r.name}`,
            artist: `${statusText} · ${r.message}`,
            album: `更新时间: ${new Date().toLocaleTimeString()}`,
            artwork: config.defaultArtwork,
            duration: 0,
            platform: config.platform,
          });
        });
      }

      return items;
    }

    // 指令 3: 删除指定音源 ("del 5sing" / "删除 酷我" / "rm 碳酸酷我")
    if (
      text.startsWith("del ") ||
      text.startsWith("delete ") ||
      text.startsWith("rm ") ||
      text.startsWith("remove ") ||
      text.startsWith("删除 ") ||
      text.startsWith("卸载 ")
    ) {
      const query = text
        .replace(/^(del|delete|rm|remove|删除|卸载)\s+/i, "")
        .trim();
      const delRes = deleteDynamicPlugin(query);
      return [
        {
          id: "delete_feedback_item",
          title: delRes.message,
          artist: delRes.success
            ? `已从本地硬盘 (localStorage) 与当前运行内存中永久移除`
            : `提示: 请输入 status 查看看板获取准确音源名称`,
          album: `状态: ${delRes.success ? "DELETED" : "NOT_FOUND"}`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        },
      ];
    }

    // 指令 4: 查看换源秒开记忆看板 ("cache" / "记忆" / "秒开表" / "缓存")
    if (
      text === "cache" ||
      text === "记忆" ||
      text === "秒开表" ||
      text === "缓存"
    ) {
      const stats = matchCache.getStats();
      return [
        {
          id: "cache_stats_item",
          title: `[换源秒开记忆看板] 已本地记忆 ${stats.count} 首曲目直达`,
          artist: `本地持久化占用: ${stats.sizeKb} KB · 存储位置: localStorage[${stats.storageKey}]`,
          album: `💡 提示: 输入 'clearcache' 或 '清空记忆' 可重置秒开缓存`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        },
      ];
    }

    // 指令 5: 单独清空换源秒开记忆表 ("clearcache" / "清空记忆" / "重置记忆")
    if (
      text === "clearcache" ||
      text === "清空记忆" ||
      text === "重置记忆"
    ) {
      const count = matchCache.size();
      matchCache.clear();
      return [
        {
          id: "clearcache_feedback_item",
          title: `成功清空 ${count} 条换源秒开记忆缓存！`,
          artist: `音源插件配置已完整保留，秒开表已重置`,
          album: `状态: CACHE_RESET`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        },
      ];
    }

    // 指令 6: 一键清空所有本地缓存音源与记忆 ("clear" / "清空" / "reset" / "重置")
    if (
      text === "clear" ||
      text === "清空" ||
      text === "reset" ||
      text === "重置"
    ) {
      const clearRes = clearAllDynamicPlugins();
      matchCache.clear();
      return [
        {
          id: "clear_feedback_item",
          title: clearRes.message,
          artist: `音源插件与换源秒开记忆已全部恢复为出厂纯净状态`,
          album: `状态: CLEARED`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        },
      ];
    }

    // 功能 3: 粘贴 HTTP 链接 (支持 .js 脚本 与 .json 合集订阅)
    if (text.startsWith("http://") || text.startsWith("https://")) {
      const regRes = await registerOrUpdatePlugin(text, "tier0", builtInSources);
      const feedbackItems = [];

      feedbackItems.push({
        id: "plugin_register_main_feedback",
        title: regRes.message,
        artist: `名称: ${regRes.name} · 版本: ${regRes.version}`,
        album: `💡 提示: 已临时激活！如需软件重启后永久生效，请填入【插件设置 -> 优先音源】中保存`,
        artwork: config.defaultArtwork,
        duration: 0,
        platform: config.platform,
      });

      if (Array.isArray(regRes.subReports)) {
        regRes.subReports.slice(0, 30).forEach((sub, idx) => {
          feedbackItems.push({
            id: `sub_plugin_${idx}`,
            title: `[${sub.status.toUpperCase()}] ${sub.name}`,
            artist: sub.message,
            album: `版本: v${sub.version}`,
            artwork: config.defaultArtwork,
            duration: 0,
            platform: config.platform,
          });
        });
      }

      return feedbackItems;
    }

    // 功能 4: JSON 备份文本的一键无损迁移
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);

        if (parsed && (Array.isArray(parsed.plugins) || (Array.isArray(parsed) && parsed[0]?.url))) {
          const list = Array.isArray(parsed.plugins) ? parsed.plugins : parsed;
          let addedCount = 0;
          for (const item of list) {
            if (item.url && item.url.startsWith("http")) {
              const r = await registerOrUpdatePlugin(item.url, "tier0", builtInSources);
              if (r.status === "added" || r.status === "updated") addedCount++;
            }
          }
          return [
            {
              id: "json_paste_feedback",
              title: `成功从 JSON 文本导入并激活 ${addedCount} 个音源插件！`,
              artist: `全部音源已加入 Tier 0 优先调度池`,
              album: `💡 提示: 如需重启后永久生效，请将链接填入【插件设置 -> 优先音源】保存`,
              artwork: config.defaultArtwork,
              duration: 0,
              platform: config.platform,
            },
          ];
        }

        const songs = extractSongsFromBackup(parsed);
        if (songs.length > 0) {
          return songs;
        }
      } catch (e) {}
    }

    return [];
  },

  /**
   * 导入单曲
   */
  async importMusicItem(urlLike) {
    if (!urlLike || typeof urlLike !== "string") return null;
    const text = urlLike.trim();
    if (text.startsWith("{")) {
      try {
        const item = JSON.parse(text);
        return {
          id: String(item.id || "import_" + Date.now()),
          title: item.title || item.name,
          artist: item.artist || item.singer || "",
          album: item.album || "",
          artwork: item.artwork || item.cover || config.defaultArtwork,
          duration: item.duration || 0,
          platform: config.platform,
        };
      } catch (e) {}
    }
    return null;
  },
};

module.exports = plugin;

  },
  };

  var cache = {};

  function normalizePath(p) {
    var parts = p.split("/");
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return stack.join("/");
  }

  function resolveModuleKey(currentModuleKey, requestedPath) {
    if (requestedPath.startsWith("./") || requestedPath.startsWith("../")) {
      var currentDir = currentModuleKey.substring(0, currentModuleKey.lastIndexOf("/"));
      if (!currentDir) currentDir = ".";
      var combined = currentDir + "/" + requestedPath;
      var norm = "./" + normalizePath(combined);
      if (modules[norm]) return norm;
      if (modules[norm + ".js"]) return norm + ".js";
      return norm;
    }
    return requestedPath;
  }

  function customRequire(fromKey, moduleId) {
    var resolvedKey = resolveModuleKey(fromKey, moduleId);

    if (cache[resolvedKey]) {
      return cache[resolvedKey].exports;
    }

    var modFn = modules[resolvedKey];
    if (!modFn) {
      if (typeof require === "function") {
        try {
          return require(moduleId);
        } catch (e) {}
      }
      return {};
    }

    var module = { exports: {} };
    cache[resolvedKey] = module;

    function scopedRequire(nextModuleId) {
      return customRequire(resolvedKey, nextModuleId);
    }

    modFn(module, module.exports, scopedRequire);
    return module.exports;
  }

  var entry = customRequire(".", "./index-pure");
  module.exports = entry.default || entry;
})();
