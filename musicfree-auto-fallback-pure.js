/**
 * MusicFree 智能多源聚合与自动容灾换源插件 (纯净版 - 0内置源)
 * 
 * 版本: 1.7.0-pure
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
(function(env, getUserVariables, __musicfree_require) {
  var modules = {
  "./utils/format": function(module, exports, require, env, getUserVariables, __musicfree_require) {
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

/**
 * 安全解析音频时长为秒数 (兼容数值秒、数值毫秒与 "mm:ss" / "hh:mm:ss" 字符串)
 * 解决评分器与比对器因时长格式化为字符串而失效的问题
 */
function parseDurationSeconds(duration) {
  if (duration === undefined || duration === null || duration === "" || duration === 0) {
    return 0;
  }
  if (typeof duration === "number") {
    if (isNaN(duration) || duration <= 0) return 0;
    return duration > 10000 ? Math.floor(duration / 1000) : Math.floor(duration);
  }
  if (typeof duration === "string") {
    const s = duration.trim();
    if (s.includes(":")) {
      const parts = s.split(":").map(Number);
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return parts[0] * 60 + parts[1];
      }
      if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
    }
    const sec = Number(s);
    if (!isNaN(sec) && sec > 0) {
      return sec > 10000 ? Math.floor(sec / 1000) : Math.floor(sec);
    }
  }
  return 0;
}

module.exports = {
  formatDuration,
  parseDurationSeconds,
};

  },
  "./utils/http": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const axios = require("axios");

/**
 * 在 Node / Electron 环境下经常出现 TLS 握手断开的传统 HTTP 兼容域名
 */
const LEGACY_HTTP_HOSTS = new Set([
  "music.163.com",
  "c.y.qq.com",
  "u.y.qq.com",
  "y.qq.com",
  "search.kuwo.cn",
  "m.kuwo.cn",
  "kbangserver.kuwo.cn",
  "antiserver.kuwo.cn",
  "mobilecdn.kugou.com",
  "d.musicapp.migu.cn",
  "c.musicapp.migu.cn",
  "m.music.migu.cn",
]);

/**
 * 运行期记忆已确认需要回退为 HTTP 的域名，避免重复等待 TLS 失败耗时
 */
const preferHttpHosts = new Set();

function extractHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

function isWindowsPlatform() {
  try {
    return typeof process !== "undefined" && process.platform === "win32";
  } catch (e) {
    return false;
  }
}

function swapProtocol(url, targetProtocol) {
  if (!url || typeof url !== "string") return url;
  if (targetProtocol === "http:") {
    return url.replace(/^https:\/\//i, "http://");
  }
  if (targetProtocol === "https:") {
    return url.replace(/^http:\/\//i, "https://");
  }
  return url;
}

function normalizeHeadersForProtocol(headers, targetProtocol) {
  if (!headers || typeof headers !== "object") return headers;
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    const lk = key.toLowerCase();
    if ((lk === "referer" || lk === "origin") && typeof next[key] === "string") {
      next[key] = swapProtocol(next[key], targetProtocol);
    }
  }
  return next;
}

function isTlsOrConnectionError(err) {
  if (!err) return false;
  if (err.response) return false;
  const msg = String(err.message || "").toLowerCase();
  const code = String(err.code || "").toUpperCase();
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPROTO" ||
    code === "ETIMEDOUT" ||
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("socket disconnected") ||
    msg.includes("econnreset") ||
    msg.includes("certificate")
  );
}

/**
 * 智能协议容错 HTTP 请求：
 * - 非 Windows 端或非传统兼容域名：优先使用 HTTPS，仅在 TLS/连接异常时自动降级 HTTP 重试并记忆域名；
 * - Windows Electron 桌面端针对国内已确认 TLS 易断连的传统音频接口：直接走 HTTP 并支持反向回退 HTTPS，避免 3s 超时熔断误杀。
 */
async function httpRequest(method, url, dataOrConfig = {}, maybeConfig = null) {
  const isPostLike = method === "post" || method === "put" || method === "patch";
  const config = isPostLike ? (maybeConfig || {}) : (dataOrConfig || {});
  const host = extractHostname(url);

  const shouldPreferHttp =
    url.startsWith("https://") &&
    (preferHttpHosts.has(host) || (isWindowsPlatform() && LEGACY_HTTP_HOSTS.has(host)));

  const primaryProto = shouldPreferHttp ? "http:" : (url.startsWith("http://") ? "http:" : "https:");
  const secondaryProto = primaryProto === "https:" ? "http:" : "https:";

  const buildConfig = (proto) => ({
    ...config,
    headers: normalizeHeadersForProtocol(config.headers, proto),
  });

  const execute = (targetUrl, cfg) => {
    if (isPostLike) {
      return axios[method](targetUrl, dataOrConfig, cfg);
    }
    return axios[method](targetUrl, cfg);
  };

  const primaryUrl = swapProtocol(url, primaryProto);
  try {
    return await execute(primaryUrl, buildConfig(primaryProto));
  } catch (err) {
    if (host && (LEGACY_HTTP_HOSTS.has(host) || primaryProto === "https:") && isTlsOrConnectionError(err)) {
      if (secondaryProto === "http:" && host) {
        preferHttpHosts.add(host);
      }
      const fallbackUrl = swapProtocol(url, secondaryProto);
      return await execute(fallbackUrl, buildConfig(secondaryProto));
    }
    throw err;
  }
}

function httpGet(url, config = {}) {
  return httpRequest("get", url, config);
}

function httpPost(url, data, config = {}) {
  return httpRequest("post", url, data, config);
}

/**
 * 统一解析用户环境变量中的布尔开关（兼容 true/false/0/1/开/关/是/否 与大小写、空白）
 */
function parseBooleanFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  const norm = String(value).trim().toLowerCase();
  if (!norm) return defaultValue;
  if (norm === "false" || norm === "0" || norm === "no" || norm === "off" || norm === "关" || norm === "关闭" || norm === "否") {
    return false;
  }
  if (norm === "true" || norm === "1" || norm === "yes" || norm === "on" || norm === "开" || norm === "开启" || norm === "是") {
    return true;
  }
  return defaultValue;
}

/**
 * 宽松解析 JSON / 酷我类 JSONP-like 响应：
 * 1. 若 axios 已自动反序列化为对象/数组，直接返回（避免拼串报错）；
 * 2. 优先尝试标准 JSON.parse，其次做单引号与 True/False 规范化再 JSON.parse；
 * 3. 仅当去空白后确实以 `{` 或 `[` 开头时，才允许使用 Function 兜底，防止 HTML 错误页触发执行。
 */
function parseLooseJson(data) {
  if (!data) return null;
  if (typeof data === "object") return data;
  if (typeof data !== "string") return null;

  const trimmed = data.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (e1) {}

  try {
    const normalized = trimmed
      .replace(/'/g, '"')
      .replace(/True/g, "true")
      .replace(/False/g, "false");
    return JSON.parse(normalized);
  } catch (e2) {}

  try {
    return Function('"use strict"; return (' + trimmed + ");")();
  } catch (e3) {
    return null;
  }
}

module.exports = {
  httpGet,
  httpPost,
  httpRequest,
  parseBooleanFlag,
  parseLooseJson,
  isTlsOrConnectionError,
  LEGACY_HTTP_HOSTS,
};


  },
  "./config-pure": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const config = {
  platform: "智能多源聚合",
  version: "1.7.0-pure",
  author: "夢酷 (mengkuikun)",
  srcUrl: "https://raw.githubusercontent.com/mengkuikun/MusicFreePlusins/main/musicfree-auto-fallback-pure.js",
  description: "纯净框架版 0 内置源多源聚合与自动容灾换源插件 (支持自定义单插件及合集订阅)",
  cacheControl: "no-cache",
  defaultArtwork: "https://github.com/mengkuikun.png",
  supportedSearchType: ["music", "album", "artist", "sheet", "lyric"],
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
      hint: "高音质或无损失效时自动向下兼容播放（填 true 或 false，默认 true）",
    },
    {
      key: "enableMatchCache",
      name: "秒开记忆",
      hint: "记住可用音源实现 10ms 秒开与失效自愈（填 true 或 false，默认 true）",
    },
    {
      key: "enableCrossComments",
      name: "跨源热评",
      hint: "音源无评论时自动拉取网易云/QQ热评（填 true 或 false，默认 true）",
    },
    {
      key: "showSourceInLyric",
      name: "歌词显示音源",
      hint: "在歌词开头实时显示当前实际播放的音源名称（填 true 或 false，默认 true）",
    },
  ],
};

module.exports = config;

  },
  "./core/matcher": function(module, exports, require, env, getUserVariables, __musicfree_require) {
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
    .replace(/\s*[（(][^）)]*[）)]/g, "")
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
  "./core/version": function(module, exports, require, env, getUserVariables, __musicfree_require) {
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
  "./core/cache": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { cleanTitle, cleanArtist } = require("./matcher");
const { getLocalStorageSafe, getMusicFreeNativeStorage } = require("./storage");

const CACHE_STORAGE_KEY = "mf_match_memory_cache_v1";
const MAX_PERSISTED_CACHE_ENTRIES = 220;

const KEEP_LARGE_ITEM_KEYS = new Set(["id", "url", "artwork", "lrc", "formats"]);
const KEEP_STRUCTURED_KEYS = new Set(["formats", "qualities", "extra", "meta"]);
const MAX_STRUCTURED_JSON_LEN = 2048;
const STRIP_ITEM_KEYS = new Set([
  "singerList",
  "lyric",
  "rawLrc",
  "translation",
  "klyric",
  "romalrc",
  "_raw",
  "musicList",
]);

function compactMatchedItem(item) {
  if (!item || typeof item !== "object") return item;
  const compact = {};
  for (const [k, v] of Object.entries(item)) {
    if (STRIP_ITEM_KEYS.has(k) || v === undefined || v === null) continue;
    if (typeof v === "function") continue;
    if (typeof v === "object") {
      if (KEEP_STRUCTURED_KEYS.has(k)) {
        try {
          const serialized = JSON.stringify(v);
          if (serialized && serialized.length <= MAX_STRUCTURED_JSON_LEN) {
            compact[k] = JSON.parse(serialized);
          }
        } catch (e) {}
      }
      continue;
    }
    if (typeof v === "string" && v.length > 512 && !KEEP_LARGE_ITEM_KEYS.has(k)) continue;
    compact[k] = v;
  }
  return compact;
}

/**
 * LRU 智能换源秒开记忆缓存 (支持桌面端 musicfree/storage 与 Web/移动端 localStorage 双端持久化)
 * 存储结构: key -> { sourceKey, sourceName, isFallback, item, time }
 */
class MatchCacheManager {
  constructor(maxSize = 500, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs; // 默认记忆有效期 7 天
    this.cache = new Map();
    this._tombstones = new Set();
    this._clearedAt = 0;
    this._lastRawLength = 0;
    this._nativeReady = false;
    this._quotaExceeded = false;
    this._loadFromDisk();
    this._initPromise = this._initNativeStorage();
  }

  _getKey(title, artist) {
    return `${cleanTitle(title)}___${cleanArtist(artist)}`.toLowerCase().trim();
  }

  _hydrateList(raw, loadedAt = Date.now()) {
    if (!raw || typeof raw !== "string") return;
    this._lastRawLength = raw.length;
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      const now = Date.now();
      for (const entry of list) {
        if (
          entry &&
          entry.key &&
          entry.sourceKey &&
          entry.item &&
          now - (entry.time || 0) <= this.ttlMs
        ) {
          if (this._tombstones.has(entry.key) || (entry.time || 0) < this._clearedAt) {
            continue;
          }
          const existing = this.cache.get(entry.key);
          if (existing && (existing.time || 0) >= (entry.time || 0)) {
            continue;
          }
          if (!existing && this.cache.size >= this.maxSize) {
            continue;
          }
          this.cache.set(entry.key, {
            sourceKey: entry.sourceKey,
            sourceName: entry.sourceName || entry.sourceKey,
            isFallback: !!entry.isFallback,
            item: entry.item,
            time: entry.time || loadedAt,
          });
        }
      }
    } catch (e) {}
  }

  _loadFromDisk() {
    try {
      const ls = getLocalStorageSafe();
      if (!ls) return;
      const raw = ls.getItem(CACHE_STORAGE_KEY);
      if (raw) {
        this._hydrateList(raw);
      }
    } catch (e) {}
  }

  async _initNativeStorage() {
    try {
      const mfStorage = getMusicFreeNativeStorage();
      if (!mfStorage) {
        this._nativeReady = true;
        return;
      }
      const raw = await mfStorage.getItem(CACHE_STORAGE_KEY);
      if (raw) {
        this._hydrateList(raw);
      }
    } catch (e) {
    } finally {
      this._nativeReady = true;
    }
  }

  /**
   * 异步等待桌面端原生磁盘缓存就绪（冷启动首拍最多等待 maxWaitMs，不影响响应速度）
   */
  async ensureReady(maxWaitMs = 50) {
    if (this._nativeReady || !this._initPromise) return;
    try {
      await Promise.race([
        this._initPromise,
        new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
      ]);
    } catch (e) {}
  }

  _saveToDisk() {
    try {
      const entries = Array.from(this.cache.entries()).slice(-MAX_PERSISTED_CACHE_ENTRIES);
      const list = entries.map(([key, entry]) => ({
        key,
        sourceKey: entry.sourceKey,
        sourceName: entry.sourceName || entry.sourceKey,
        isFallback: !!entry.isFallback,
        item: entry.item,
        time: entry.time,
      }));
      const payload = JSON.stringify(list);
      this._lastRawLength = payload.length;

      const ls = getLocalStorageSafe();
      if (ls) {
        try {
          ls.setItem(CACHE_STORAGE_KEY, payload);
        } catch (e) {}
      }

      const mfStorage = getMusicFreeNativeStorage();
      if (mfStorage) {
        Promise.resolve(mfStorage.setItem(CACHE_STORAGE_KEY, payload))
          .then(() => {
            this._quotaExceeded = false;
          })
          .catch((e) => {
            const msg = String(e?.message || "").toLowerCase();
            if (msg.includes("exceeds limit") || msg.includes("quota")) {
              this._quotaExceeded = true;
            }
          });
      }
    } catch (e) {}
  }

  /**
   * 获取某首歌的换源记忆
   */
  get(title, artist) {
    const key = this._getKey(title, artist);
    if (!key || !this.cache.has(key)) return null;

    const entry = this.cache.get(key);
    if (Date.now() - entry.time > this.ttlMs) {
      this.cache.delete(key);
      this._tombstones.add(key);
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
  set(title, artist, sourceKey, matchedItem, sourceName = "", isFallback = false) {
    const key = this._getKey(title, artist);
    if (!key) return;

    this._tombstones.delete(key);
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.delete(key);
    this.cache.set(key, {
      sourceKey,
      sourceName: sourceName || sourceKey,
      isFallback: !!isFallback,
      item: compactMatchedItem(matchedItem),
      time: Date.now(),
    });

    this._saveToDisk();
  }

  /**
   * 清除特定歌曲的记忆（当记忆源失效时触发自愈）
   */
  invalidate(title, artist) {
    const key = this._getKey(title, artist);
    if (key) {
      this._tombstones.add(key);
      if (this.cache.has(key)) {
        this.cache.delete(key);
        this._saveToDisk();
      }
    }
  }

  /**
   * 清空所有换源记忆
   */
  clear() {
    this.cache.clear();
    this._tombstones.clear();
    this._clearedAt = Date.now();
    this._lastRawLength = 0;

    const ls = getLocalStorageSafe();
    if (ls) {
      try {
        ls.removeItem(CACHE_STORAGE_KEY);
      } catch (e) {}
    }

    const mfStorage = getMusicFreeNativeStorage();
    if (mfStorage) {
      Promise.resolve(mfStorage.removeItem(CACHE_STORAGE_KEY)).catch(() => {});
    }
  }

  /**
   * 获取记忆看板统计数据
   */
  getStats() {
    const ls = getLocalStorageSafe();
    let rawSize = this._lastRawLength || 0;
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
  "./core/playback-session": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { cleanTitle, cleanArtist } = require("./matcher");
const { matchCache } = require("./cache");
const { getLocalStorageSafe, getMusicFreeNativeStorage } = require("./storage");

const SESSION_STORAGE_KEY = "mf_playback_session_v1";
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时会话有效期，覆盖超长曲目与暂停恢复
const MAX_SESSIONS = 200;
const MAX_PERSISTED_SESSIONS = 60;

const SOURCE_DISPLAY_NAME_MAP = {
  netease: "网易云音乐",
  qq: "QQ音乐",
  kuwo: "酷我音乐",
  kugou: "酷狗音乐",
  migu: "咪咕音乐",
  bilibili: "B站音频",
  gdstudio: "GD音乐台",
  fivesing: "5sing原创",
  ximalaya: "喜马拉雅",
};

const SOURCE_TAG_STRIP_RE =
  /^\[[\d:.]+\]\s*🎵\s*(?:播放)?音源[：:][^\r\n]*(?:\r?\n|$)/gm;
const FIRST_TIMESTAMP_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;
const CREDIT_OR_BANNER_RE =
  /(?:作词|作曲|编曲|制作人|演唱|原唱|混音|母带|监制|策划|统筹|出品|纯音乐|暂无歌词|lyricist|composer|arranger|producer|produced\s+by|written\s+by|lyrics\s+by|music\s+by|vocals|(?:^|\s)词\s*[:：]|(?:^|\s)曲\s*[:：]|\s-\s)/i;

function normalizeTrackName(title, fallbackRaw = "") {
  if (!title && !fallbackRaw) return "";
  const cleaned = cleanTitle(String(title || "")).toLowerCase().trim();
  if (cleaned) return cleaned;
  return String(title || fallbackRaw || "").toLowerCase().trim();
}

function normalizeArtistName(artist) {
  if (!artist || typeof artist !== "string") return "";
  return cleanArtist(artist).toLowerCase().trim();
}

function isArtistCompatible(a1, a2) {
  const n1 = normalizeArtistName(a1);
  const n2 = normalizeArtistName(a2);
  if (!n1 || !n2) return true;
  if (n1 === n2) return true;

  const t1 = n1.split(/\s+/).filter(Boolean);
  const t2 = new Set(n2.split(/\s+/).filter(Boolean));
  for (const tok of t1) {
    if ((tok.length >= 2 || (n1.length === 1 && n2.length === 1)) && t2.has(tok)) {
      return true;
    }
  }

  if (Math.min(n1.length, n2.length) >= 2 && (n1.includes(n2) || n2.includes(n1))) {
    return true;
  }
  return false;
}

function isTrackMatch(aTitle, aArtist, bTitle, bArtist) {
  const t1 = normalizeTrackName(aTitle);
  const t2 = normalizeTrackName(bTitle);
  if (!t1 || !t2) return false;
  return t1 === t2 && isArtistCompatible(aArtist, bArtist);
}

function parseTimestampSec(minStr, secStr, fracStr) {
  const min = parseInt(minStr, 10) || 0;
  const sec = parseInt(secStr, 10) || 0;
  let frac = 0;
  if (fracStr) {
    frac = parseInt(fracStr, 10) / Math.pow(10, fracStr.length);
  }
  return min * 60 + sec + frac;
}

/**
 * 实时播放会话管理器
 * 负责精准追踪实际出声播放源，支持桌面端/移动端持久化与 LRC 头部安全注入
 */
class PlaybackSessionManager {
  constructor() {
    this.sessions = new Map();
    this.waiters = new Map();
    this.resolvingCounts = new Map();
    this.currentPlayback = null;
    this._nativeReady = false;
    this._loadSync();
    this._initPromise = this._initNativeStorage();
  }

  markResolving(title, artist) {
    const exactKey = this._getExactKey(title, artist);
    const normTitle = normalizeTrackName(title);
    if (exactKey) {
      this.resolvingCounts.set(exactKey, (this.resolvingCounts.get(exactKey) || 0) + 1);
    }
    if (normTitle && normTitle !== exactKey) {
      const cur = this.resolvingCounts.get(normTitle);
      if (Array.isArray(cur)) {
        cur.push(artist || "");
      } else {
        this.resolvingCounts.set(normTitle, [artist || ""]);
      }
    }
  }

  unmarkResolving(title, artist) {
    const exactKey = this._getExactKey(title, artist);
    const normTitle = normalizeTrackName(title);
    if (exactKey && this.resolvingCounts.has(exactKey)) {
      const next = (this.resolvingCounts.get(exactKey) || 0) - 1;
      if (next <= 0) this.resolvingCounts.delete(exactKey);
      else this.resolvingCounts.set(exactKey, next);
    }
    if (normTitle && normTitle !== exactKey && this.resolvingCounts.has(normTitle)) {
      const arr = this.resolvingCounts.get(normTitle);
      if (Array.isArray(arr)) {
        const idx = arr.indexOf(artist || "");
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this.resolvingCounts.delete(normTitle);
      }
    }

    // 同一歌曲全部并发解析任务结束后，立即按已有会话或默认音源唤醒等待中的歌词请求，无需空耗超时等待
    if (!this.isResolving(title, artist)) {
      this._flushResolvedWaiters(title, artist, exactKey, normTitle);
    }
  }

  _findMatchingOrCurrentSession(title, artist) {
    const lateSession = this._findMatchingSession(title, artist);
    if (lateSession) return lateSession;
    if (
      this.currentPlayback &&
      Date.now() - this.currentPlayback.time <= SESSION_TTL_MS &&
      isTrackMatch(title, artist, this.currentPlayback.title, this.currentPlayback.artist)
    ) {
      return this.currentPlayback;
    }
    return null;
  }

  _removeWaiter(waiter) {
    if (!waiter || !Array.isArray(waiter.registerKeys)) return;
    for (const k of waiter.registerKeys) {
      if (!this.waiters.has(k)) continue;
      const arr = this.waiters.get(k).filter((w) => w !== waiter);
      if (arr.length === 0) this.waiters.delete(k);
      else this.waiters.set(k, arr);
    }
  }

  _flushResolvedWaiters(title, artist, exactKey, normTitle) {
    const toWake = new Set();
    if (exactKey && this.waiters.has(exactKey)) {
      for (const w of this.waiters.get(exactKey)) {
        toWake.add(w);
      }
    }
    if (normTitle && this.waiters.has(normTitle)) {
      for (const w of this.waiters.get(normTitle)) {
        if (isArtistCompatible(w.artist, artist) && !this.isResolving(w.title, w.artist)) {
          toWake.add(w);
        }
      }
    }
    for (const w of toWake) {
      this._removeWaiter(w);
      const fallback = this._findMatchingOrCurrentSession(w.title, w.artist) || w.defaultResult || null;
      try {
        w.resolve(fallback);
      } catch (e) {}
    }
  }

  isResolving(title, artist) {
    const exactKey = this._getExactKey(title, artist);
    if (exactKey && (this.resolvingCounts.get(exactKey) || 0) > 0) return true;
    const normTitle = normalizeTrackName(title);
    if (normTitle && this.resolvingCounts.has(normTitle)) {
      const arr = this.resolvingCounts.get(normTitle);
      if (Array.isArray(arr)) {
        return arr.some((a) => isArtistCompatible(artist, a));
      }
    }
    return false;
  }

  /**
   * 归一化音源展示名称（将内部英文 key 映射为标准可读中文平台名，并过滤聚合自身占位名）
   */
  formatSourceName(rawName) {
    if (!rawName || typeof rawName !== "string") return "";
    const trimmed = rawName.trim();
    if (!trimmed || trimmed === "智能多源聚合") return "";
    const lower = trimmed.toLowerCase();
    return SOURCE_DISPLAY_NAME_MAP[lower] || trimmed;
  }

  _getExactKey(title, artist) {
    const t = normalizeTrackName(title);
    if (!t) return "";
    const a = normalizeArtistName(artist);
    return `${t}___${a}`;
  }

  _hydrateSnapshot(raw) {
    if (!raw || typeof raw !== "string") return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const now = Date.now();

      if (Array.isArray(parsed.sessions)) {
        for (const item of parsed.sessions) {
          if (
            item &&
            item.key &&
            item.info &&
            item.info.sourceName &&
            now - (item.info.time || 0) <= SESSION_TTL_MS
          ) {
            const existing = this.sessions.get(item.key);
            if (!existing || (item.info.time || 0) > (existing.time || 0)) {
              this.sessions.set(item.key, item.info);
            }
          }
        }
      }

      if (
        !this.currentPlayback &&
        parsed.currentPlayback &&
        parsed.currentPlayback.sourceName &&
        now - (parsed.currentPlayback.time || 0) <= SESSION_TTL_MS
      ) {
        this.currentPlayback = parsed.currentPlayback;
      }
    } catch (e) {}
  }

  _loadSync() {
    const ls = getLocalStorageSafe();
    if (!ls) return;
    try {
      this._hydrateSnapshot(ls.getItem(SESSION_STORAGE_KEY));
    } catch (e) {}
  }

  async _initNativeStorage() {
    try {
      const mfStorage = getMusicFreeNativeStorage();
      if (!mfStorage) {
        this._nativeReady = true;
        return;
      }
      const raw = await mfStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) this._hydrateSnapshot(raw);
    } catch (e) {
    } finally {
      this._nativeReady = true;
    }
  }

  async ensureReady(maxWaitMs = 40) {
    if (this._nativeReady || !this._initPromise) return;
    try {
      await Promise.race([
        this._initPromise,
        new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
      ]);
    } catch (e) {}
  }

  _persistSnapshot() {
    try {
      const entries = Array.from(this.sessions.entries()).slice(-MAX_PERSISTED_SESSIONS);
      const payload = JSON.stringify({
        currentPlayback: this.currentPlayback,
        sessions: entries.map(([key, info]) => ({ key, info })),
      });

      const ls = getLocalStorageSafe();
      if (ls) {
        try {
          ls.setItem(SESSION_STORAGE_KEY, payload);
        } catch (e) {}
      }

      const mfStorage = getMusicFreeNativeStorage();
      if (mfStorage) {
        Promise.resolve(mfStorage.setItem(SESSION_STORAGE_KEY, payload)).catch(() => {});
      }
    } catch (e) {}
  }

  _findMatchingSession(title, artist) {
    const now = Date.now();
    const exactKey = this._getExactKey(title, artist);
    if (exactKey && this.sessions.has(exactKey)) {
      const hit = this.sessions.get(exactKey);
      if (now - hit.time <= SESSION_TTL_MS) return hit;
    }

    const normTitle = normalizeTrackName(title);
    if (!normTitle) return null;

    // 反向遍历优先命中最新记录，并强制要求歌手兼容，防止同名不同歌手串台
    const entries = Array.from(this.sessions.values());
    for (let i = entries.length - 1; i >= 0; i--) {
      const item = entries[i];
      if (now - item.time > SESSION_TTL_MS) continue;
      if (item.normTitle === normTitle && isArtistCompatible(artist, item.artist)) {
        return item;
      }
    }
    return null;
  }

  /**
   * 记录已成功获取到播放链接的活动曲目音源
   */
  recordActiveSession(title, artist, sourceName, isFallback = false) {
    const formattedSource = this.formatSourceName(sourceName);
    if (!title || !formattedSource) return;

    const normTitle = normalizeTrackName(title);
    const normArtist = normalizeArtistName(artist);
    const exactKey = this._getExactKey(title, artist);

    const info = {
      title,
      artist: artist || "",
      normTitle,
      normArtist,
      sourceName: formattedSource,
      isFallback: !!isFallback,
      time: Date.now(),
    };

    if (exactKey) {
      this.sessions.delete(exactKey);
      this.sessions.set(exactKey, info);
    }
    this.currentPlayback = info;

    // 唤醒匹配等待队列：精准键直接唤醒，纯歌名键须校验歌手兼容后唤醒
    if (exactKey && this.waiters.has(exactKey)) {
      const cbs = this.waiters.get(exactKey);
      this.waiters.delete(exactKey);
      cbs.forEach((w) => {
        try {
          w.resolve(info);
        } catch (e) {}
      });
    }

    if (normTitle && normTitle !== exactKey && this.waiters.has(normTitle)) {
      const list = this.waiters.get(normTitle);
      const remaining = [];
      list.forEach((w) => {
        if (isArtistCompatible(w.artist, artist)) {
          try {
            w.resolve(info);
          } catch (e) {}
        } else {
          remaining.push(w);
        }
      });
      if (remaining.length === 0) this.waiters.delete(normTitle);
      else this.waiters.set(normTitle, remaining);
    }

    // 超容量时按 LRU 与过期时间裁剪
    if (this.sessions.size > MAX_SESSIONS) {
      const now = Date.now();
      for (const [k, v] of this.sessions.entries()) {
        if (now - v.time > SESSION_TTL_MS || this.sessions.size > MAX_SESSIONS) {
          this.sessions.delete(k);
        }
      }
    }

    this._persistSnapshot();
  }

  /**
   * 获取或等待当前播放歌曲的实际音源信息（零串源、抗切换歌词污染、超时熔断）
   */
  async getOrWaitSource(
    title,
    artist,
    defaultSourceName = "",
    timeoutMs = 600,
    isLyricSearch = false,
    options = {}
  ) {
    await Promise.all([this.ensureReady(40), matchCache.ensureReady(40)]);
    const now = Date.now();

    // 模式 A：用户在弹窗搜索/切换关联歌词
    // 必须严格绑定当前真实正在出声的 currentPlayback，绝不能被所点歌词条目的歌名/历史缓存污染！
    if (isLyricSearch) {
      if (this.currentPlayback && now - this.currentPlayback.time <= SESSION_TTL_MS) {
        return this.currentPlayback;
      }
      const fallbackMatch = this._findMatchingSession(title, artist);
      if (fallbackMatch) return fallbackMatch;

      const cached = matchCache.get(title, artist);
      if (cached && (cached.sourceName || cached.sourceKey)) {
        return {
          sourceName: this.formatSourceName(cached.sourceName || cached.sourceKey),
          isFallback: !!cached.isFallback,
          time: cached.time,
        };
      }
      return null;
    }

    // 模式 B：常规切歌/播放读取歌词
    // 1. 先查当前活跃播放（严格歌名+歌手校验，防止上一首歌污染下一首）
    if (
      this.currentPlayback &&
      now - this.currentPlayback.time <= SESSION_TTL_MS &&
      isTrackMatch(title, artist, this.currentPlayback.title, this.currentPlayback.artist)
    ) {
      return this.currentPlayback;
    }

    // 2. 查内存及持久化会话表（含同名且歌手兼容的规范化匹配）
    const matchedSession = this._findMatchingSession(title, artist);
    if (matchedSession) {
      return matchedSession;
    }

    // 3. 查持久化秒开记忆表
    const cached = matchCache.get(title, artist);
    if (cached && (cached.sourceName || cached.sourceKey)) {
      const sName = this.formatSourceName(cached.sourceName || cached.sourceKey);
      if (sName) {
        return {
          sourceName: sName,
          isFallback: !!cached.isFallback,
          time: cached.time,
        };
      }
    }

    // 4. 并发等待正在执行的 getMediaSource 取链完成（若仅命中缓存音频未触发 getMediaSource，可由 waitOnlyIfResolving 立即放行 0ms 返回）
    const exactKey = this._getExactKey(title, artist);
    const normTitle = normalizeTrackName(title);
    const formattedDefault = this.formatSourceName(defaultSourceName);

    if (options && options.waitOnlyIfResolving && !this.isResolving(title, artist)) {
      return formattedDefault ? { sourceName: formattedDefault, isFallback: false } : null;
    }

    return new Promise((resolve) => {
      let timer = null;
      const defaultResult = formattedDefault
        ? { sourceName: formattedDefault, isFallback: false }
        : null;
      const registerKeys = [];
      if (exactKey) registerKeys.push(exactKey);
      if (normTitle && normTitle !== exactKey) registerKeys.push(normTitle);

      if (registerKeys.length === 0) {
        resolve(defaultResult);
        return;
      }

      const waiter = {
        title,
        artist: artist || "",
        registerKeys,
        defaultResult,
        resolve: (info) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          resolve(info);
        },
      };

      timer = setTimeout(() => {
        this._removeWaiter(waiter);
        // 超时后仅在确认歌名歌手匹配时采纳会话，严禁把上一首歌的 currentPlayback 张冠李戴到当前曲目
        resolve(this._findMatchingOrCurrentSession(title, artist) || defaultResult);
      }, timeoutMs);

      for (const k of registerKeys) {
        if (!this.waiters.has(k)) this.waiters.set(k, []);
        this.waiters.get(k).push(waiter);
      }
    });
  }

  /**
   * 将 [00:00.00] 音源提示安全注入 LRC：
   * 1. 保留原有 [ti:]/[ar:]/[al:]/[offset:] 等 LRC 元数据头在最前面；
   * 2. 自动识别开头连续的 00:00.00 署名/标题/说明行（跳过夹杂的空行），整体微调至安全间隙内，确保桌面歌词与高亮不被跳过且绝不改动演唱行与翻译对齐；
   * 3. 关闭开关或更新时可幂等清理旧标记。
   */
  injectSourceTagToLrc(lrcRes, sourceInfo, enabled = true, trackTitle = "") {
    const baseRes = lrcRes && typeof lrcRes === "object" ? lrcRes : { rawLrc: "" };
    const cleanedRaw = String(baseRes.rawLrc || "").replace(SOURCE_TAG_STRIP_RE, "");
    const formattedName = sourceInfo ? this.formatSourceName(sourceInfo.sourceName) : "";

    if (!enabled || !formattedName) {
      return {
        ...baseRes,
        rawLrc: cleanedRaw,
      };
    }

    const tag = sourceInfo.isFallback
      ? `[00:00.00] 🎵 播放音源：${formattedName} (容灾换源)`
      : `[00:00.00] 🎵 播放音源：${formattedName}`;

    if (!cleanedRaw.trim()) {
      return {
        ...baseRes,
        rawLrc: `${tag}\n[00:01.00] 纯音乐 / 暂无歌词\n`,
      };
    }

    // 拆分 LRC 前置元数据标签 ([ti:...] [ar:...] [offset:...] 等) 与正文时间戳行
    const firstTsMatch = FIRST_TIMESTAMP_RE.exec(cleanedRaw);
    let metaHeader = "";
    let body = cleanedRaw;
    if (firstTsMatch) {
      const splitIdx = firstTsMatch.index;
      metaHeader = cleanedRaw.slice(0, splitIdx);
      body = cleanedRaw.slice(splitIdx);
    }

    // 处理开头连续 00:00.00（含夹杂空行）的桌面歌词高亮避让
    const hasZeroTranslation = /^\[0{1,2}:0{2}(?:[.:]0+)?\]/m.test(
      String(baseRes.translation || "")
    );
    if (!hasZeroTranslation) {
      const lines = body.split(/\r?\n/);
      const zeroLineIndices = [];
      let tNext = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
          if (zeroLineIndices.length > 0) continue;
          break;
        }
        const m = /^(\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\])(.*)$/.exec(line);
        if (!m) break;
        const sec = parseTimestampSec(m[2], m[3], m[4]);
        if (sec === 0) {
          zeroLineIndices.push({ index: i, tag: m[1], text: m[5] || "" });
        } else {
          tNext = sec;
          break;
        }
      }

      if (zeroLineIndices.length > 0) {
        const cleanTargetTitle = trackTitle ? cleanTitle(trackTitle).toLowerCase().trim() : "";
        const nonEmptyZeroLines = zeroLineIndices.filter((z) => z.text.trim().length > 0);
        const isCreditOrBannerLine = (text) => {
          if (CREDIT_OR_BANNER_RE.test(text)) return true;
          if (!cleanTargetTitle) return false;
          const cleanLine = cleanTitle(text).toLowerCase().trim();
          const rawLower = text.toLowerCase().trim();
          return (
            cleanLine === cleanTargetTitle ||
            (cleanTargetTitle.length >= 2 && rawLower.includes(cleanTargetTitle))
          );
        };

        const effectiveNext = tNext !== null ? tNext : 1.0;
        if (nonEmptyZeroLines.length === 0) {
          const zeroIdxSet = new Set(zeroLineIndices.map((z) => z.index));
          const filteredBody = lines.filter((_, idx) => !zeroIdxSet.has(idx)).join("\n");
          if (!filteredBody.trim()) {
            return {
              ...baseRes,
              rawLrc: `${metaHeader && !metaHeader.endsWith("\n") ? `${metaHeader}\n` : metaHeader}${tag}\n[00:01.00] 纯音乐 / 暂无歌词\n`,
            };
          }
          body = filteredBody;
        } else {
          const canShift =
            nonEmptyZeroLines.every((z) => isCreditOrBannerLine(z.text)) &&
            effectiveNext >= 0.06;

          if (canShift) {
            const maxTargetCs = Math.min(
              45,
              Math.max(3, Math.floor((effectiveNext * 100) / 2))
            );
            const count = zeroLineIndices.length;
            for (let j = 0; j < count; j++) {
              const z = zeroLineIndices[j];
              const cs = Math.min(
                maxTargetCs,
                Math.max(3, Math.floor(((j + 1) * maxTargetCs) / count))
              );
              const bumpedTag = `[00:00.${String(cs).padStart(2, "0")}]`;
              lines[z.index] = bumpedTag + z.text;
            }
            body = lines.join("\n");
          }
        }
      }
    }

    const prefix = metaHeader && !metaHeader.endsWith("\n") ? `${metaHeader}\n` : metaHeader;
    return {
      ...baseRes,
      rawLrc: `${prefix}${tag}\n${body}`,
    };
  }
}

const playbackSession = new PlaybackSessionManager();

module.exports = {
  playbackSession,
  PlaybackSessionManager,
  isTrackMatch,
  isArtistCompatible,
  SESSION_TTL_MS,
};

  },
  "./core/storage": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

/**
 * MusicFree 跨平台高自适应持久化存储引擎
 * 三轨融合：
 *  1. [桌面端核心首选] musicfree/storage (MusicFree 官方原生磁盘存储，持久化到 %APPDATA%/musicfree-plugin-storage/chunk.json)
 *  2. [Web/浏览器同步] localStorage (0ms 极速内存/WebStorage 镜像)
 *  3. [Web/大容量容灾] IndexedDB (支持 GB 级超大插件持久化)
 */

const DB_NAME = "MusicFreePluginDB";
const STORE_NAME = "dynamic_plugins";
const DB_VERSION = 1;
const STORAGE_KEY = "mf_dynamic_plugins_cache_v2";
const STORAGE_INITIALIZED_KEY = "mf_storage_initialized_v1";
const STORAGE_TOMBSTONE_KEY = "mf_deleted_tombstones_v1";

let idbInstance = null;
let inMemoryStore = [];

// 内存快照缓存：保证无论在何种平台，同步读取均能 0ms 瞬间命中
const nativeStorageCache = new Map();
let isNativeStorageInit = false;
let nativeStorageInitPromise = null;
let lastInheritInfo = null;
let quotaStatus = { exceeded: false, lastError: "" };

function getQuotaStatus() {
  return { ...quotaStatus };
}

/**
 * 在 Electron 桌面端安全探测 Node.js 原生 fs 模块 (具备沙箱穿透与全局降级容错)
 */
function getGlobalNodeFs() {
  try {
    const globalRoot = (function () {
      return (function () {}).constructor("return this")();
    })();
    const proc = globalRoot ? globalRoot.process : null;
    if (proc) {
      if (typeof proc.getBuiltinModule === "function") {
        const fs = proc.getBuiltinModule("fs");
        if (fs && typeof fs.readFileSync === "function") return fs;
      }
      if (proc.mainModule && typeof proc.mainModule.require === "function") {
        const fs = proc.mainModule.require("fs");
        if (fs && typeof fs.readFileSync === "function") return fs;
      }
    }
  } catch (e) {}

  try {
    if (typeof require === "function") {
      const fs = require("fs");
      if (fs && typeof fs.readFileSync === "function") return fs;
    }
  } catch (e) {}

  return null;
}

/**
 * 探测并获取 MusicFree 桌面端官方原生磁盘存储模块 (musicfree/storage)
 */
function getMusicFreeNativeStorage() {
  try {
    if (typeof require === "function") {
      const s = require("musicfree/storage");
      if (s && typeof s.getItem === "function" && typeof s.setItem === "function") {
        return s;
      }
    }
  } catch (e) {}

  try {
    if (typeof __musicfree_require === "function") {
      const s = __musicfree_require("musicfree/storage");
      if (s && typeof s.getItem === "function" && typeof s.setItem === "function") {
        return s;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * 获取或记录墓碑黑名单（防止用户主动删除的音源在跨版本升级后死灰复燃）
 */
async function getTombstones(mfStorage) {
  if (!mfStorage) return [];
  try {
    const raw = await mfStorage.getItem(STORAGE_TOMBSTONE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch (e) {}
  return [];
}

async function addTombstone(urlOrId) {
  if (!urlOrId) return;
  const mfStorage = getMusicFreeNativeStorage();
  if (!mfStorage) return;
  try {
    const list = await getTombstones(mfStorage);
    if (!list.includes(urlOrId)) {
      list.push(urlOrId);
      await mfStorage.setItem(STORAGE_TOMBSTONE_KEY, JSON.stringify(list));
    }
  } catch (e) {}
}

/**
 * 跨版本存储无感自愈与继承引擎
 * 当检测到当前代码 Hash 存储为空（全新版本初次运行），自动扫描本地历史版本存储，
 * 经过五重安全防线（防复活、语法强校验、指纹特征隔离、0延迟非阻塞），无缝继承上一个有效版本的全部音源！
 */
async function tryInheritFromPreviousVersions(mfStorage, customFs = null) {
  if (!mfStorage) return { inherited: false, reason: "no_storage" };

  try {
    const initFlag = await mfStorage.getItem(STORAGE_INITIALIZED_KEY);
    if (initFlag === "cleared") {
      return { inherited: false, reason: "explicitly_cleared" };
    }
    const currentCache = await mfStorage.getItem(STORAGE_KEY);
    if (initFlag === "true" && currentCache) {
      return { inherited: false, reason: "already_initialized" };
    }

    // 1. 无感优先继承：从共享的全局 localStorage 中恢复（不依赖任何本地文件系统权限，纯沙箱自愈）
    const ls = getLocalStorageSafe();
    if (ls) {
      try {
        const lsRaw = ls.getItem(STORAGE_KEY);
        if (lsRaw) {
          const parsed = JSON.parse(lsRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            await mfStorage.setItem(STORAGE_KEY, lsRaw);
            await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
            inMemoryStore = parsed.slice();
            nativeStorageCache.set(STORAGE_KEY, lsRaw);
            return { inherited: true, count: parsed.length, source: "localStorage" };
          }
        }
      } catch (e) {}
    }

    const fs = customFs || getGlobalNodeFs();
    if (!fs) {
      await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
      return { inherited: false, reason: "no_fs" };
    }

    const globalRoot = (function () {
      return (function () {}).constructor("return this")();
    })();
    const proc = globalRoot ? globalRoot.process : null;
    const env = proc ? proc.env || {} : {};

    // 适配各操作系统下 MusicFree 桌面端 chunk.json 默认位置
    const candidatePaths = [];
    if (env.APPDATA) {
      candidatePaths.push(
        env.APPDATA + "/MusicFree/musicfree-plugin-storage/chunk.json",
        env.APPDATA + "/musicfree-plugin-storage/chunk.json"
      );
    }
    if (env.HOME) {
      candidatePaths.push(
        env.HOME + "/.config/MusicFree/musicfree-plugin-storage/chunk.json",
        env.HOME + "/Library/Application Support/MusicFree/musicfree-plugin-storage/chunk.json"
      );
    }

    let chunkPath = null;
    for (const p of candidatePaths) {
      const norm = p.replace(/\\/g, "/");
      try {
        if (fs.existsSync(norm)) {
          chunkPath = norm;
          break;
        }
      } catch (e) {}
    }

    if (!chunkPath) {
      await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
      return { inherited: false, reason: "no_chunk_file" };
    }

    const rawContent = fs.readFileSync(chunkPath, "utf-8");
    const data = JSON.parse(rawContent);
    if (!data || typeof data !== "object") {
      await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
      return { inherited: false, reason: "invalid_chunk_data" };
    }

    const tombstones = new Set(await getTombstones(mfStorage));

    // 倒序检索最近有效 Hash
    const keys = Object.keys(data).reverse();
    let candidatePlugins = null;
    let candidateFingerprint = null;
    let sourceHash = null;

    for (const h of keys) {
      const entry = data[h];
      if (entry && typeof entry === "object" && entry.mf_dynamic_plugins_cache_v2) {
        try {
          const parsed = JSON.parse(entry.mf_dynamic_plugins_cache_v2);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // 五重安全过滤：去除墓碑、校验必要字段
            const valid = parsed.filter((p) => {
              if (!p || typeof p !== "object") return false;
              if (!p.url || tombstones.has(p.url)) return false;
              if (!p.code || typeof p.code !== "string" || p.code.length < 20) return false;
              if (!p.name && !p.platform) return false;
              return true;
            });

            if (valid.length > 0) {
              candidatePlugins = valid;
              candidateFingerprint = entry.mf_last_synced_fingerprint_v1 || "";
              sourceHash = h;
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (candidatePlugins && candidatePlugins.length > 0) {
      // 写入当前版本存储与内存快照
      const jsonStr = JSON.stringify(candidatePlugins);
      inMemoryStore = candidatePlugins.slice();
      nativeStorageCache.set(STORAGE_KEY, jsonStr);

      await mfStorage.setItem(STORAGE_KEY, jsonStr);
      if (candidateFingerprint) {
        await mfStorage.setItem("mf_last_synced_fingerprint_v1", candidateFingerprint);
      }
      await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
      await mfStorage.setItem("mf_inherited_from_hash_v1", sourceHash);

      lastInheritInfo = {
        inherited: true,
        count: candidatePlugins.length,
        fromHash: sourceHash,
        fingerprint: candidateFingerprint,
      };
      return lastInheritInfo;
    }

    await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "true");
    return { inherited: false, reason: "no_valid_candidates" };
  } catch (err) {
    return { inherited: false, error: err.message };
  }
}

function getInheritInfo() {
  return lastInheritInfo;
}

/**
 * 开机预热：异步从 MusicFree 官方原生磁盘存储恢复数据到内存缓存中
 */
async function ensureNativeStorageLoaded() {
  if (isNativeStorageInit) return;
  if (nativeStorageInitPromise) return nativeStorageInitPromise;

  nativeStorageInitPromise = (async () => {
    const mfStorage = getMusicFreeNativeStorage();
    if (mfStorage) {
      try {
        const raw = await mfStorage.getItem(STORAGE_KEY);
        if (raw) {
          nativeStorageCache.set(STORAGE_KEY, raw);
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            inMemoryStore = parsed.slice();
          }
        }

        // 若当前版本存储为空，触发跨版本自动继承自愈引擎
        if (inMemoryStore.length === 0) {
          await tryInheritFromPreviousVersions(mfStorage);
        }
      } catch (e) {}
    }
    isNativeStorageInit = true;
  })();

  return nativeStorageInitPromise;
}

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
  try {
    if (
      typeof window !== "undefined" &&
      window.localStorage &&
      typeof window.localStorage.getItem === "function"
    ) {
      return window.localStorage;
    }
  } catch (e) {}
  return null;
}

/**
 * 同步安全读取任意键值 (优先读取内存快照，次之 localStorage)
 */
function getStoredItemSync(key) {
  if (nativeStorageCache.has(key)) return nativeStorageCache.get(key);
  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      return ls.getItem(key);
    } catch (e) {}
  }
  return null;
}

/**
 * 异步安全读取任意键值 (从原生磁盘、localStorage 或内存中获取)
 */
async function getStoredItemAsync(key) {
  const syncVal = getStoredItemSync(key);
  if (syncVal !== null && syncVal !== undefined && syncVal !== "") return syncVal;

  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      const raw = await mfStorage.getItem(key);
      if (raw !== null && raw !== undefined) {
        nativeStorageCache.set(key, String(raw));
        return String(raw);
      }
    } catch (e) {}
  }

  return null;
}

/**
 * 异步写入任意键值 (三轨同步：内存快照 + localStorage + 原生磁盘持久化)
 */
async function setStoredItem(key, value) {
  const strVal = String(value ?? "");
  nativeStorageCache.set(key, strVal);

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(key, strVal);
    } catch (e) {}
  }

  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      await mfStorage.setItem(key, strVal);
    } catch (e) {}
  }
}

/**
 * 删除任意存储键值
 */
async function removeStoredItem(key) {
  nativeStorageCache.delete(key);

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.removeItem(key);
    } catch (e) {}
  }

  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      await mfStorage.removeItem(key);
    } catch (e) {}
  }
}

/**
 * ⚡ 同步优先写入 (0ms 极速增量合并写入，杜绝旧音源被全量覆盖清空)
 */
function savePluginsSync(list) {
  if (!Array.isArray(list)) return false;

  // 1. 读取本地已有的旧数据进行安全增量合并 (Merge Upsert)
  const existingList = loadPluginsSync();
  const mergedMap = new Map();

  if (Array.isArray(existingList)) {
    for (const item of existingList) {
      if (item && item.url) mergedMap.set(item.url, item);
    }
  }

  for (const item of list) {
    if (item && item.url) mergedMap.set(item.url, item);
  }

  const mergedList = Array.from(mergedMap.values());
  inMemoryStore = mergedList.slice();
  const jsonStr = JSON.stringify(mergedList);
  nativeStorageCache.set(STORAGE_KEY, jsonStr);

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, jsonStr);
      return true;
    } catch (e) {
      // 若超 5MB，由原生磁盘或 IndexedDB 接管
      return false;
    }
  }

  return true;
}

// 写入任务队列：保证所有 IndexedDB 写事务严格串行化执行
let idbWriteQueue = Promise.resolve();

function enqueueIdbWrite(operation) {
  const resultPromise = idbWriteQueue.then(() => operation().catch(() => false));
  idbWriteQueue = resultPromise;
  return resultPromise;
}

/**
 * 📦 异步完整写入 (MusicFree 官方原生磁盘 + IndexedDB 双重持久化)
 */
async function savePluginsAsync(list) {
  if (!Array.isArray(list)) return false;

  // 1. 先进行内存增量合并
  savePluginsSync(list);

  // 2. 写入 MusicFree 官方原生磁盘存储 (解决桌面端无 localStorage/IndexedDB 的根本手段！)
  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      const mergedList = inMemoryStore.slice();
      const jsonStr = JSON.stringify(mergedList);
      nativeStorageCache.set(STORAGE_KEY, jsonStr);
      await mfStorage.setItem(STORAGE_KEY, jsonStr);
      quotaStatus = { exceeded: false, lastError: "" };
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.toLowerCase().includes("exceeds limit") || msg.toLowerCase().includes("quota")) {
        quotaStatus = { exceeded: true, lastError: msg };
        // 若共享 chunk.json 接近 10MB 上限，尝试降级保存精简核心音源子集，保证基础冷启动可用
        try {
          const compactSubset = inMemoryStore
            .slice()
            .filter((p) => p && p.code && p.code.length <= 40000)
            .slice(0, 12);
          if (compactSubset.length > 0 && compactSubset.length < inMemoryStore.length) {
            await mfStorage.setItem(STORAGE_KEY, JSON.stringify(compactSubset));
          }
        } catch (compactErr) {}
      } else {
        console.warn("[Storage] 写入 MusicFree 原生磁盘存储失败:", msg);
      }
    }
  }

  // 3. 写入 IndexedDB (保留 Web 浏览器端大容量兼容)
  return enqueueIdbWrite(async () => {
    try {
      const db = await openIndexedDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          for (const item of inMemoryStore) {
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
    } catch (err) {
      return false;
    }
  });
}

/**
 * 单个插件原子 upsert
 */
async function putPluginAsync(item) {
  if (!item || !item.url) return false;
  return savePluginsAsync([item]);
}

/**
 * 统一同步/异步保存入口
 */
function savePlugins(list) {
  savePluginsSync(list);
  savePluginsAsync(list).catch(() => {});
}

/**
 * ⚡ 同步优先读取已持久化插件
 */
function loadPluginsSync() {
  // 1. 检查 localStorage
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

  // 2. 检查原生磁盘缓存快照
  if (nativeStorageCache.has(STORAGE_KEY)) {
    try {
      const parsed = JSON.parse(nativeStorageCache.get(STORAGE_KEY));
      if (Array.isArray(parsed) && parsed.length > 0) {
        inMemoryStore = parsed.slice();
        return parsed;
      }
    } catch (e) {}
  }

  // 3. 返回当前内存快照
  return inMemoryStore.slice();
}

/**
 * 📦 异步完整读取 (MusicFree 原生磁盘 + IndexedDB + localStorage 全源对齐)
 */
async function loadPlugins() {
  // 1. 优先等待并加载 MusicFree 官方原生磁盘存储
  await ensureNativeStorageLoaded();

  const resultMap = new Map();

  // 预热回填内存
  if (Array.isArray(inMemoryStore)) {
    inMemoryStore.forEach((item) => {
      if (item && item.url) resultMap.set(item.url, item);
    });
  }

  // 2. 补充 localStorage
  const syncList = loadPluginsSync();
  if (Array.isArray(syncList)) {
    syncList.forEach((item) => {
      if (item && item.url) resultMap.set(item.url, item);
    });
  }

  // 3. 补充 IndexedDB
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
  nativeStorageCache.set(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * 删除指定 URL 的插件数据
 */
async function removePlugin(url) {
  if (!url) return false;
  const currentList = loadPluginsSync();
  const filtered = currentList.filter((x) => x && x.url !== url);
  inMemoryStore = filtered.slice();
  const jsonStr = JSON.stringify(filtered);
  nativeStorageCache.set(STORAGE_KEY, jsonStr);

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, jsonStr);
    } catch (e) {}
  }

  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      await mfStorage.setItem(STORAGE_KEY, jsonStr);
      await addTombstone(url);
    } catch (e) {}
  }

  return enqueueIdbWrite(async () => {
    try {
      const db = await openIndexedDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          store.delete(url);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    } catch (err) {
      return false;
    }
  });
}

/**
 * 清空所有存储
 */
async function clearAll() {
  inMemoryStore = [];
  nativeStorageCache.clear();

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  const mfStorage = getMusicFreeNativeStorage();
  if (mfStorage) {
    try {
      await mfStorage.removeItem(STORAGE_KEY);
      await mfStorage.setItem(STORAGE_INITIALIZED_KEY, "cleared");
    } catch (e) {}
  }

  return enqueueIdbWrite(async () => {
    try {
      const db = await openIndexedDB();
      if (!db) return false;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (e) {
          resolve(false);
        }
      });
    } catch (err) {
      return false;
    }
  });
}

module.exports = {
  isIndexedDBAvailable,
  getLocalStorageSafe,
  getMusicFreeNativeStorage,
  ensureNativeStorageLoaded,
  getStoredItemSync,
  getStoredItemAsync,
  setStoredItem,
  removeStoredItem,
  savePlugins,
  savePluginsSync,
  savePluginsAsync,
  putPluginAsync,
  loadPlugins,
  loadPluginsSync,
  removePlugin,
  clearAll,
  STORAGE_KEY,
  STORAGE_INITIALIZED_KEY,
  STORAGE_TOMBSTONE_KEY,
  getInheritInfo,
  getQuotaStatus,
  tryInheritFromPreviousVersions,
  getGlobalNodeFs,
  addTombstone,
};


  },
  "./core/dynamic-loader": function(module, exports, require, env, getUserVariables, __musicfree_require) {
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
const FINGERPRINT_STORAGE_KEY = "mf_last_synced_fingerprint_v1";

function getLastSyncedFingerprint() {
  return storage.getStoredItemSync(FINGERPRINT_STORAGE_KEY) || "";
}

async function getLastSyncedFingerprintAsync() {
  return (await storage.getStoredItemAsync(FINGERPRINT_STORAGE_KEY)) || "";
}

function setLastSyncedFingerprint(fp) {
  storage.setStoredItem(FINGERPRINT_STORAGE_KEY, fp || "").catch(() => {});
}

function clearLastSyncedFingerprint() {
  storage.removeStoredItem(FINGERPRINT_STORAGE_KEY).catch(() => {});
}

// 最近的同步与诊断日志 (BUG-006 & BUG-007)
const syncDiagnosticLogs = {
  lastSyncTime: 0,
  lastSyncStatus: "idle",
  lastSyncError: null,
  totalSubPlugins: 0,
  successCount: 0,
  failCount: 0,
  failedPlugins: [],
};

function getSyncDiagnosticLogs() {
  return syncDiagnosticLogs;
}

// 远程内容哈希感知 (BUG-005)
const HASH_STORAGE_KEY_PREFIX = "mf_sub_content_hash_";

function getStoredContentHash(url) {
  return storage.getStoredItemSync(HASH_STORAGE_KEY_PREFIX + url) || "";
}

function setStoredContentHash(url, hash) {
  storage.setStoredItem(HASH_STORAGE_KEY_PREFIX + url, hash).catch(() => {});
}

function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

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
    if (list.length > 0) {
      storage.savePlugins(list);
    }
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
let isBgInitRunning = false;

function triggerBackgroundInit() {
  if (isBgInitRunning) return bgInitPromise;
  isBgInitRunning = true;
  bgInitPromise = (async () => {
    try {
      // 1. 同步 0ms 从 localStorage 恢复
      restoreDynamicPluginsFromStorage();

      // 2. 异步补充与对齐原生磁盘 / IndexedDB (【修复 BUG-002】：允许覆盖与升级旧版数据)
      const asyncList = await storage.loadPlugins();
      if (Array.isArray(asyncList)) {
        for (const item of asyncList) {
          if (item && item.code && item.url) {
            const existing = dynamicRegistry.get(item.url);
            const shouldUpdate =
              !existing ||
              (item.version && existing.plugin && compareVersions(item.version, existing.plugin.version || "0.0.0") > 0) ||
              (item.time && existing.time && item.time > existing.time) ||
              !existing.code;

            if (shouldUpdate) {
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
      }

      if (!lastSyncedFingerprint) {
        lastSyncedFingerprint = (await getLastSyncedFingerprintAsync()) || "";
      }
    } catch (e) {
      console.warn("[Storage] 异步恢复异常:", e.message);
    } finally {
      isBgInitRunning = false;
    }
  })();
  return bgInitPromise;
}

// 模块加载顶层立即自执行！(开机 0ms 瞬间把已存插件拉满内存)
triggerBackgroundInit();

/**
 * 全局就绪等待锁：保证本地持久化存储（原生磁盘 + localStorage + IndexedDB）完全加载入内存
 * 【修复 BUG-003】：将硬超时放宽至 8000ms，保证多插件恢复完成，同时保留防死锁保护
 */
async function ensureDynamicPluginsReady(timeoutMs = 8000) {
  if (!bgInitPromise || (!isBgInitRunning && dynamicRegistry.size === 0)) {
    triggerBackgroundInit();
  }
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
 * 【修复 BUG-009】：异步等待 IndexedDB 彻底删除完成后再完成持久化
 */
async function deleteDynamicPlugin(query) {
  if (!query || typeof query !== "string") {
    return { success: false, message: "请指定要删除的音源名称（如: del 5sing 或 删除 酷我）" };
  }

  const target = query.trim().toLowerCase();
  let deletedCount = 0;
  let deletedName = "";
  const toDeleteUrls = [];

  for (const [url, reg] of dynamicRegistry.entries()) {
    const pName = (reg.plugin.platform || reg.plugin.name || "").toLowerCase();
    if (pName === target || pName.includes(target) || url.toLowerCase().includes(target)) {
      deletedName = reg.plugin.platform || reg.plugin.name || url;
      toDeleteUrls.push(url);
      deletedCount++;
    }
  }

  for (const url of toDeleteUrls) {
    dynamicRegistry.delete(url);
    await storage.removePlugin(url);
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
 * 一键清空所有本地缓存的动态音源与配置指纹
 */
async function clearAllDynamicPlugins() {
  const count = dynamicRegistry.size;
  dynamicRegistry.clear();
  await storage.clearAll();
  lastSyncedFingerprint = "";
  clearLastSyncedFingerprint();
  bgInitPromise = null;
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
function registerSingleEvaluatedPlugin(
  plugin,
  cleanUrl,
  tier,
  builtInSourcesMap = {},
  rawCode = "",
  skipPersist = false
) {
  const remoteName = plugin.platform || plugin.name || "未命名插件";
  const remoteVersion = plugin.version || "1.0.0";
  plugin._sourceUrl = cleanUrl;
  plugin._isDynamic = true;
  plugin._tier = tier;

  // 1. 查找是否存在完全相同 URL 的已有插件 (精准更新同一插件)
  let existingEntry = null;
  let samePlatformCount = 0;
  for (const [u, reg] of dynamicRegistry.entries()) {
    if (u === cleanUrl) {
      existingEntry = { type: "dynamic", url: u, reg };
      break;
    }
    if (reg.plugin.platform === remoteName) {
      samePlatformCount++;
    }
  }

  let existingBuiltin = null;
  if (!existingEntry && builtInSourcesMap) {
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

  // 2. 相同 URL 进行版本对比升级
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
      if (!skipPersist) persistDynamicPluginsToStorage();
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

  // 3. 若不同 URL 但平台同名，支持多线路并存 (如 酷我 [线路2])
  if (samePlatformCount > 0) {
    plugin._isAlternativeRoute = true;
    plugin._routeIndex = samePlatformCount + 1;
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
      if (!skipPersist) persistDynamicPluginsToStorage();
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
  if (!skipPersist) persistDynamicPluginsToStorage();

  return {
    status: "added",
    name: remoteName,
    version: remoteVersion,
    message: `添加音乐源 [${remoteName}] 成功，版本号为 ${remoteVersion}`,
    plugin,
  };
}

function resetDiagnosticLogs() {
  syncDiagnosticLogs.lastSyncTime = 0;
  syncDiagnosticLogs.lastSyncStatus = "syncing";
  syncDiagnosticLogs.lastSyncError = null;
  syncDiagnosticLogs.totalSubPlugins = 0;
  syncDiagnosticLogs.successCount = 0;
  syncDiagnosticLogs.failCount = 0;
  syncDiagnosticLogs.failedPlugins = [];
}

function finalizeDiagnosticLogs(totalCount, successCount, failCount, lastErr = null) {
  syncDiagnosticLogs.lastSyncTime = Date.now();
  syncDiagnosticLogs.totalSubPlugins = totalCount;
  syncDiagnosticLogs.successCount = successCount;
  syncDiagnosticLogs.failCount = failCount;
  syncDiagnosticLogs.lastSyncError = lastErr;
  if (failCount === 0) {
    syncDiagnosticLogs.lastSyncStatus = "success";
  } else if (successCount > 0) {
    syncDiagnosticLogs.lastSyncStatus = "partial";
  } else {
    syncDiagnosticLogs.lastSyncStatus = "error";
  }
}

function aggregateSyncDiagnostics(results = []) {
  let totalCount = 0;
  let successCount = 0;
  let failCount = 0;
  let lastErrorMsg = null;

  results.forEach((item) => {
    const val = item && ("status" in item && (item.status === "fulfilled" || item.status === "rejected"))
      ? (item.status === "fulfilled" ? item.value : { status: "error", message: "更新失败" })
      : item;
    if (!val) {
      totalCount += 1;
      failCount += 1;
      return;
    }
    if (val._syncCounts) {
      totalCount += val._syncCounts.total;
      successCount += val._syncCounts.success;
      failCount += val._syncCounts.fail;
    } else {
      totalCount += 1;
      if (val.status === "error") {
        failCount += 1;
        lastErrorMsg = val.message || lastErrorMsg;
      } else {
        successCount += 1;
      }
    }
  });

  finalizeDiagnosticLogs(totalCount, successCount, failCount, lastErrorMsg);
}

/**
 * 批量从插件配置列表导入并汇总单次诊断日志
 */
async function registerPluginBatch(items = [], tier = "tier0", builtInSourcesMap = {}) {
  const validUrls = (Array.isArray(items) ? items : [])
    .map((it) => (it && typeof it.url === "string" ? it.url.trim() : ""))
    .filter((u) => u.startsWith("http"));

  if (validUrls.length === 0) {
    return { addedCount: 0, results: [] };
  }

  resetDiagnosticLogs();
  const results = [];
  let addedCount = 0;
  for (const url of validUrls) {
    const r = await registerOrUpdatePlugin(url, tier, builtInSourcesMap, { resetLogs: false });
    results.push(r);
    if (r && (r.status === "added" || r.status === "updated")) {
      addedCount++;
    }
  }
  aggregateSyncDiagnostics(results);
  return { addedCount, results };
}

/**
 * 注册或更新单个或批量插件 (支持 .js 脚本 与 .json 订阅合集)
 */
async function registerOrUpdatePlugin(
  url,
  tier = "tier0",
  builtInSourcesMap = {},
  options = {}
) {
  const { resetLogs = true } = options || {};
  if (resetLogs) {
    resetDiagnosticLogs();
  }

  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    const errRes = {
      status: "error",
      name: "未知",
      version: "0.0.0",
      message: "无效的插件 URL 链接",
    };
    if (resetLogs) {
      syncDiagnosticLogs.failedPlugins.push({
        name: errRes.name,
        url: String(url || ""),
        reason: errRes.message,
      });
      finalizeDiagnosticLogs(1, 0, 1, errRes.message);
    }
    return errRes;
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

      // 8 路并发高速拉取子插件，完成后严格按订阅列表原有优先级顺序注册（杜绝乱序抢占 Chunk 0）
      let subFailCount = 0;
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
            return { ok: true, itemUrl, plugin, rawSubCode };
          }
          return {
            ok: false,
            name: item.name || "未知",
            url: itemUrl,
            reason: "代码不符合 MusicFree 插件协议",
          };
        } catch (subErr) {
          console.warn(`[PluginDownload] 音源 [${item.name || itemUrl}] 下载或解析失败:`, subErr.message);
          return {
            ok: false,
            name: item.name || "未知",
            url: itemUrl,
            reason: subErr.message,
          };
        }
      });

      const subResults = await Promise.allSettled(tasks);
      let addedCount = 0;
      let updatedCount = 0;
      let existsCount = 0;
      const subReports = [];

      subResults.forEach((r) => {
        if (r.status === "fulfilled" && r.value) {
          const v = r.value;
          if (v.ok) {
            const singleRes = registerSingleEvaluatedPlugin(
              v.plugin,
              v.itemUrl,
              tier,
              builtInSourcesMap,
              v.rawSubCode,
              true // skipPersist: 批处理完成后统一保存
            );
            if (singleRes.status === "added") addedCount++;
            if (singleRes.status === "updated") updatedCount++;
            if (singleRes.status === "exists") existsCount++;
            subReports.push(singleRes);
          } else {
            subFailCount++;
            syncDiagnosticLogs.failedPlugins.push({
              name: v.name,
              url: v.url,
              reason: v.reason,
            });
          }
        } else {
          subFailCount++;
        }
      });

      // 集中保存到本地持久化存储中
      if (addedCount > 0 || updatedCount > 0) {
        persistDynamicPluginsToStorage();
      }

      // 记录内容 Hash (BUG-005)
      const contentStr = typeof rawData === "string" ? rawData : JSON.stringify(rawData);
      setStoredContentHash(cleanUrl, simpleHash(contentStr));

      const subSuccessCount = addedCount + updatedCount + existsCount;
      if (resetLogs) {
        finalizeDiagnosticLogs(validItems.length, subSuccessCount, subFailCount, null);
      }

      return {
        status: addedCount > 0 || updatedCount > 0 ? "added" : "exists",
        name: "插件合集订阅",
        version: `${validItems.length}个源`,
        message: `成功解析插件合集! 新增: ${addedCount} 个, 更新: ${updatedCount} 个, 已有: ${existsCount} 个`,
        subReports,
        _syncCounts: {
          total: validItems.length,
          success: subSuccessCount,
          fail: subFailCount,
        },
      };
    }

    // B. 处理单个 JS 插件
    const codeStr =
      typeof rawData === "string" ? rawData : JSON.stringify(rawData);
    const plugin = evaluatePluginCode(codeStr);
    if (!plugin) {
      const errRes = {
        status: "error",
        name: cleanUrl,
        version: "0.0.0",
        message: "代码格式不符合 MusicFree 插件协议",
      };
      syncDiagnosticLogs.failedPlugins.push({
        name: cleanUrl,
        url: cleanUrl,
        reason: errRes.message,
      });
      if (resetLogs) {
        finalizeDiagnosticLogs(1, 0, 1, errRes.message);
      }
      return errRes;
    }

    const singleRes = registerSingleEvaluatedPlugin(
      plugin,
      cleanUrl,
      tier,
      builtInSourcesMap,
      codeStr
    );
    if (resetLogs) {
      finalizeDiagnosticLogs(1, 1, 0, null);
    }
    return singleRes;
  } catch (err) {
    const errRes = {
      status: "error",
      name: cleanUrl,
      version: "0.0.0",
      message: `网络连接失败: ${err.message}`,
    };
    syncDiagnosticLogs.failedPlugins.push({
      name: cleanUrl,
      url: cleanUrl,
      reason: err.message,
    });
    if (resetLogs) {
      finalizeDiagnosticLogs(1, 0, 1, err.message);
    }
    return errRes;
  }
}

/**
 * 智能同步用户变量中的插件链接（具备 0ms 指纹记忆与本地缓存秒读拦截，杜绝重复网络请求）
 */
async function syncCustomPlugins(
  tier0UrlsStr = "",
  tier3UrlsStr = "",
  builtInSourcesMap = {}
) {
  const currentFingerprint = `${tier0UrlsStr || ""}###${tier3UrlsStr || ""}`;

  // 0. 纯内存 0ms 瞬时快路径：避免高频调用 search/getMediaSource/getLyric 时反复等待存储 IPC
  if (dynamicRegistry.size > 0 && currentFingerprint === lastSyncedFingerprint) {
    return [];
  }

  const savedFingerprint =
    (await getLastSyncedFingerprintAsync()) || getLastSyncedFingerprint();

  // 1. 检查内存常驻与持久化指纹：
  // 若内存已有插件，且指纹与上次同步指纹（或本地持久化指纹）一致，0ms 瞬间退出，严禁联网！
  if (
    dynamicRegistry.size > 0 &&
    (currentFingerprint === lastSyncedFingerprint || currentFingerprint === savedFingerprint)
  ) {
    lastSyncedFingerprint = currentFingerprint;
    return [];
  }

  // 2. 检查本地硬盘数据库：若指纹一致且本地存储中已有缓存插件，秒读恢复入内存，0ms 退出无需联网！
  if (currentFingerprint === savedFingerprint) {
    if (dynamicRegistry.size === 0) {
      restoreDynamicPluginsFromStorage(builtInSourcesMap);
    }
    if (dynamicRegistry.size > 0) {
      lastSyncedFingerprint = currentFingerprint;
      return [];
    }
  }

  // 3. 仅在首次启动或用户修改了 URL 时，才真正向网络请求
  // 网络同步前，必须确保本地磁盘已有数据完全加载进内存，严禁空内存同步覆盖磁盘！
  await ensureDynamicPluginsReady(8000);

  const allUrls = [];

  if (tier0UrlsStr && typeof tier0UrlsStr === "string") {
    const urls0 = Array.from(
      new Set(
        tier0UrlsStr
          .split(/[\s\n,;，；]+/)
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
          .split(/[\s\n,;，；]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"))
      )
    );
    urls3.forEach((u) => allUrls.push({ url: u, tier: "tier3" }));
  }

  if (allUrls.length === 0) {
    lastSyncedFingerprint = currentFingerprint;
    setLastSyncedFingerprint(currentFingerprint);
    return [];
  }

  resetDiagnosticLogs();
  const tasks = allUrls.map((item) =>
    registerOrUpdatePlugin(item.url, item.tier, builtInSourcesMap, { resetLogs: false })
  );
  const results = await Promise.allSettled(tasks);
  aggregateSyncDiagnostics(results);

  // 4. 只有在至少成功拉取到音源时，才持久化记录指纹，防止断网导致“永久断更”
  const hasSuccess = results.some(
    (r) => r.status === "fulfilled" && r.value && r.value.status !== "error"
  );
  if (hasSuccess) {
    lastSyncedFingerprint = currentFingerprint;
    setLastSyncedFingerprint(currentFingerprint);
  }

  return results;
}

/**
 * 一键检查并更新所有当前注册的动态插件
 */
async function updateAllRegisteredPlugins(builtInSourcesMap = {}) {
  const entries = Array.from(dynamicRegistry.entries());
  if (entries.length === 0) return [];
  resetDiagnosticLogs();
  const tasks = entries.map(([url, reg]) =>
    registerOrUpdatePlugin(url, reg.tier, builtInSourcesMap, { resetLogs: false })
  );
  const results = await Promise.allSettled(tasks);
  persistDynamicPluginsToStorage();

  const mapped = results.map((r) =>
    r.status === "fulfilled" && r.value
      ? r.value
      : { status: "error", message: "更新失败" }
  );
  aggregateSyncDiagnostics(mapped);

  return mapped;
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
  registerPluginBatch,
  syncCustomPlugins,
  updateAllRegisteredPlugins,
  getActiveDynamicPlugins,
  evaluatePluginCode,
  persistDynamicPluginsToStorage,
  restoreDynamicPluginsFromStorage,
  ensureDynamicPluginsReady,
  deleteDynamicPlugin,
  clearAllDynamicPlugins,
  getSyncDiagnosticLogs,
};

  },
  "./core/quality-fallback": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

/**
 * 音质安全降级与多源音质调度引擎
 * 
 * 核心设计准则：
 * 1. 严格遵循宿主软件设置中的默认音质作为上限基准，绝对不擅自向上越级攀升（如默认 standard 时绝不自作主张下 super）；
 * 2. 单向向下平滑梯队：只有在当前请求的音质无法获取时，才在用户允许降级的前提下逐级向下试探，保底出声；
 * 3. 强容错：捕获插件抛出的任何异常，避免因单源不支持特定音质而导致整体假死或误报“没有”。
 */

const { isTlsOrConnectionError } = require("../utils/http");

function isInvalid404Url(url) {
  if (!url || typeof url !== "string") return true;
  const u = url.toLowerCase();
  if (
    u.includes("/404.html") ||
    u.includes("/404/") ||
    u.endsWith("/404") ||
    u.includes("music.163.com/404") ||
    u.includes("404.mp3") ||
    u.includes("error.mp3")
  ) {
    return true;
  }
  return false;
}

/**
 * 根据宿主传入的目标音质与降级开关，生成单向向下的回退梯队
 * @param {string} requestedQuality - 客户端请求的目标音质
 * @param {boolean} allowDowngrade - 是否允许自动降级兜底
 * @returns {string[]} 尝试音质序列
 */
function getQualityFallbackLadder(requestedQuality = "standard", allowDowngrade = true) {
  const req = (requestedQuality || "standard").toLowerCase();

  // 若用户关闭了自动降级（洁癖模式），严格只尝试用户指定的单一音质
  if (!allowDowngrade) {
    return [req];
  }

  // 单向向下回退梯队（绝不向上越级！）
  switch (req) {
    case "hires":
      return ["hires", "super", "high", "standard", "low"];
    case "super":
    case "lossless":
      return ["super", "high", "standard", "low"];
    case "high":
      return ["high", "standard", "low"];
    case "standard":
      return ["standard", "low"];
    case "low":
      return ["low"];
    default:
      // 未知标识，优先尝试其本身，然后向下兜底
      return [req, "standard", "low"];
  }
}

function getMediaSourceWithTimeout(source, item, quality, timeoutMs = 2800) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const err = new Error("GET_MEDIA_TIMEOUT");
        err._timedOut = true;
        reject(err);
      }
    }, timeoutMs);

    try {
      Promise.resolve(source.getMediaSource(item, quality)).then(
        (res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(res);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      );
    } catch (syncErr) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(syncErr);
      }
    }
  });
}

function isFatalNetworkError(err) {
  if (!err) return false;
  if (err._timedOut || isTlsOrConnectionError(err)) return true;
  if (err.response) return false;
  const code = String(err.code || "").toUpperCase();
  const msg = String(err.message || "").toLowerCase();
  return (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ERR_NETWORK" ||
    msg.includes("timeout") ||
    msg.includes("无法连接") ||
    msg.includes("network error")
  );
}

/**
 * 对指定音源安全拉取音频直链（含平滑降级、超时熔断与死链快速中止）
 * @param {object} source - 音源实例
 * @param {object} item - 歌曲条目
 * @param {string} requestedQuality - 客户端请求的音质
 * @param {boolean} allowDowngrade - 是否允许降级
 * @param {number} perCallTimeoutMs - 单次音质请求最大等待时间
 * @returns {Promise<{ mediaRes: object, qualityUsed: string } | null>}
 */
async function safeGetMediaSourceWithFallback(
  source,
  item,
  requestedQuality = "standard",
  allowDowngrade = true,
  perCallTimeoutMs = 2800,
  options = {}
) {
  if (!source || typeof source.getMediaSource !== "function") {
    return null;
  }

  const ladder = getQualityFallbackLadder(requestedQuality, allowDowngrade);

  for (const q of ladder) {
    try {
      const res = await getMediaSourceWithTimeout(source, item, q, perCallTimeoutMs);
      if (
        res &&
        res.url &&
        typeof res.url === "string" &&
        res.url.startsWith("http") &&
        !isInvalid404Url(res.url)
      ) {
        return {
          mediaRes: res,
          qualityUsed: q,
        };
      }
    } catch (err) {
      // 若宿主域名本身 TLS 断连、超时或不可达，没必要再连续失败重试 remaining quality tiers
      if (isFatalNetworkError(err)) {
        if (options && typeof options.onFatalError === "function") {
          options.onFatalError(err);
        }
        return null;
      }
    }
  }

  return null;
}

module.exports = {
  isInvalid404Url,
  getQualityFallbackLadder,
  getMediaSourceWithTimeout,
  isFatalNetworkError,
  safeGetMediaSourceWithFallback,
};

  },
  "./core/sheet-importer": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const axios = require("axios");
const { httpGet } = require("../utils/http");

/**
 * 判断是否为插件代码或合集配置的安装链接
 * @param {string} text - 输入文本
 * @returns {boolean}
 */
function isPluginOrSubscriptionUrl(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();

  // 1. 显式前缀指令 (强制认定为插件/合集安装)
  if (
    t.startsWith("add ") ||
    t.startsWith("install ") ||
    t.startsWith("plugin ") ||
    t.startsWith("源 ") ||
    t.startsWith("添加 ")
  ) {
    return true;
  }

  // 2. 如果是已知音乐平台的歌单链接，绝不当成插件安装！
  const isKnownMusicPlatform =
    /163\.com|163cn\.tv|qq\.com|kuwo\.cn|kugou\.com|bilibili\.com|b23\.tv|spotify\.com|apple\.com/i.test(
      t
    );
  if (isKnownMusicPlatform) {
    return false;
  }

  // 3. 去除 URL query 和 hash，检查后缀
  const cleanUrl = t.split("?")[0].split("#")[0].toLowerCase();
  if (cleanUrl.endsWith(".js") || cleanUrl.endsWith(".json")) {
    return true;
  }

  // 4. 常见托管源特征
  if (
    /raw\.githubusercontent\.com|gitee\.com\/.*\/raw|plugins\.json|subscription\.json/i.test(
      t
    )
  ) {
    return true;
  }

  return false;
}

/**
 * 提取清理后的插件下载 URL
 */
function cleanPluginUrl(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .trim()
    .replace(/^(add|install|plugin|源|添加)\s+/i, "")
    .trim();
}

/**
 * 通用跨平台歌单直解引擎
 * 支持：网易云音乐、QQ音乐、酷我、酷狗、B站等主流歌单，并支持已加载子插件代理
 * 
 * @param {string} urlLike - 歌单链接或分享文本
 * @param {Array} activeSources - 当前已激活的音源列表 (用于委托代理)
 * @param {string} platformName - 归一化的平台名称 (默认: 智能多源聚合)
 * @returns {Promise<Array>} 标准化后的歌曲列表
 */
async function resolveMusicSheet(
  urlLike,
  activeSources = [],
  platformName = "智能多源聚合"
) {
  if (!urlLike || typeof urlLike !== "string") return [];
  const text = urlLike.trim();

  // =================================================================
  // 通道 1: 网易云音乐 (163) 歌单直解
  // =================================================================
  const neteaseMatch =
    /(?:163\.com|163cn\.tv).*(?:[?&]id=|\/playlist\/)(\d+)/i.exec(text) ||
    /playlist\?id=(\d+)/i.exec(text);
  if (neteaseMatch && neteaseMatch[1]) {
    const sheetId = neteaseMatch[1];
    try {
      const res = await httpGet(
        `https://music.163.com/api/v6/playlist/detail?id=${sheetId}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: "https://music.163.com/",
          },
          timeout: 10000,
        }
      );
      const playlist = res.data?.playlist;
      const tracks = playlist?.tracks || [];
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.map((t) => ({
          id: String(t.id),
          title: t.name || "未知歌曲",
          artist: (t.ar || []).map((a) => a.name).join(", ") || "未知歌手",
          album: t.al?.name || "",
          artwork: t.al?.picUrl || "",
          duration: Math.round((t.dt || 0) / 1000),
          platform: platformName,
          _source: "netease",
        }));
      }
    } catch (e) {}
  }

  // =================================================================
  // 通道 2: QQ 音乐歌单直解
  // =================================================================
  const qqMatch =
    /(?:qq\.com).*(?:taoge\.html\?id=|playlist\/|disstid=)(\d+)/i.exec(text) ||
    /(?:y\.qq\.com\/n\/ryqq\/playlist\/)(\d+)/i.exec(text);
  if (qqMatch && qqMatch[1]) {
    const disstid = qqMatch[1];
    try {
      const res = await httpGet(
        `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${disstid}&format=json`,
        {
          headers: {
            Referer: "https://y.qq.com/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 10000,
        }
      );
      const songlist = res.data?.cdlist?.[0]?.songlist || [];
      if (Array.isArray(songlist) && songlist.length > 0) {
        return songlist.map((t) => ({
          id: String(t.songmid || t.mid || t.songid),
          title: t.songname || t.name || "未知歌曲",
          artist: (t.singer || []).map((s) => s.name).join(", ") || "未知歌手",
          album: t.albumname || t.album?.name || "",
          artwork: t.albummid
            ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${t.albummid}.jpg`
            : "",
          duration: t.interval || 0,
          platform: platformName,
          _source: "qq",
        }));
      }
    } catch (e) {}
  }

  // =================================================================
  // 通道 3: 酷我音乐歌单直解
  // =================================================================
  const kuwoMatch = /(?:kuwo\.cn).*(?:playlist_detail\/|pid=)(\d+)/i.exec(text);
  if (kuwoMatch && kuwoMatch[1]) {
    const pid = kuwoMatch[1];
    try {
      const res = await httpGet(
        `https://m.kuwo.cn/newh5/singles/songlistinfo?pid=${pid}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
          },
          timeout: 10000,
        }
      );
      const musicList = res.data?.data?.musicList || [];
      if (Array.isArray(musicList) && musicList.length > 0) {
        return musicList.map((t) => ({
          id: String(t.rid || t.id),
          title: t.name || t.songname || "未知歌曲",
          artist: t.artist || t.singer || "未知歌手",
          album: t.album || "",
          artwork: t.pic || t.cover || "",
          duration: t.duration || 0,
          platform: platformName,
          _source: "kuwo",
        }));
      }
    } catch (e) {}
  }

  // =================================================================
  // 通道 4: 酷狗音乐歌单直解
  // =================================================================
  const kugouMatch =
    /(?:kugou\.com).*(?:special\/single\/|specialid=)(\d+)/i.exec(text);
  if (kugouMatch && kugouMatch[1]) {
    const specialid = kugouMatch[1];
    try {
      const res = await httpGet(
        `https://mobilecdn.kugou.com/api/v3/special/song?specialid=${specialid}&format=json`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 10000,
        }
      );
      const list = res.data?.data?.info || [];
      if (Array.isArray(list) && list.length > 0) {
        return list.map((t) => {
          const rawName = t.filename || t.songname || "";
          let title = rawName;
          let artist = t.singername || "";
          if (rawName.includes(" - ")) {
            const parts = rawName.split(" - ");
            artist = parts[0].trim();
            title = parts.slice(1).join(" - ").trim();
          }
          return {
            id: String(t.hash || t.audio_id),
            title: title || "未知歌曲",
            artist: artist || "未知歌手",
            album: t.album_name || "",
            artwork: (t.imgpath || "").replace("{size}", "400"),
            duration: t.duration || 0,
            platform: platformName,
            _source: "kugou",
          };
        });
      }
    } catch (e) {}
  }

  // =================================================================
  // 通道 5: 哔哩哔哩 (Bilibili) 收藏夹 / 媒体列表
  // =================================================================
  const biliMatch =
    /(?:bilibili\.com).*(?:medialist\/play\/ml|fid=)(\d+)/i.exec(text);
  if (biliMatch && biliMatch[1]) {
    const fid = biliMatch[1];
    try {
      const res = await axios.get(
        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&pn=1&ps=50`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          timeout: 10000,
        }
      );
      const medias = res.data?.data?.medias || [];
      if (Array.isArray(medias) && medias.length > 0) {
        return medias.map((m) => ({
          id: String(m.id || m.bvid),
          title: m.title || "未知音频",
          artist: m.upper?.name || "B站UP主",
          album: "Bilibili收藏夹",
          artwork: m.cover || "",
          duration: m.duration || 0,
          platform: platformName,
          _source: "bilibili",
        }));
      }
    } catch (e) {}
  }

  // =================================================================
  // 通道 6: 委托给当前已加载的具有 importMusicSheet 方法的子插件
  // =================================================================
  if (Array.isArray(activeSources) && activeSources.length > 0) {
    for (const source of activeSources) {
      if (typeof source.importMusicSheet === "function") {
        try {
          const list = await source.importMusicSheet(urlLike);
          if (Array.isArray(list) && list.length > 0) {
            return list.map((item) => ({
              ...item,
              platform: platformName,
              _source: item.platform || item._source || source.name || "plugin",
            }));
          }
        } catch (e) {}
      }
    }
  }

  return [];
}

module.exports = {
  isPluginOrSubscriptionUrl,
  cleanPluginUrl,
  resolveMusicSheet,
};

  },
  "./core/comment-resolver": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { httpGet, parseBooleanFlag } = require("../utils/http");
const { cleanTitle, cleanArtist } = require("./matcher");

// LRU 缓存：记录歌曲到第三方平台歌曲ID的映射，加速后续分页请求 (容量 500)
const songIdCache = new Map();
const MAX_CACHE_SIZE = 500;

function setCachedId(key, val) {
  if (songIdCache.size >= MAX_CACHE_SIZE) {
    const firstKey = songIdCache.keys().next().value;
    songIdCache.delete(firstKey);
  }
  songIdCache.set(key, val);
}

function getCacheKey(title, artist) {
  return `${(title || "").trim().toLowerCase()}:::${(artist || "").trim().toLowerCase()}`;
}

/**
 * 获取网易云音乐公开评论区 (支持精彩热评置顶与平滑分页)
 */
async function getNeteaseComments(musicItem, page = 1) {
  if (!musicItem) return { isEnd: true, data: [] };

  let songId =
    musicItem.neteaseId ||
    (musicItem._source === "netease" && /^\d+$/.test(String(musicItem.id))
      ? String(musicItem.id)
      : null);

  const cacheKey = getCacheKey(musicItem.title, musicItem.artist);
  if (!songId && cacheKey !== ":::") {
    const cached = songIdCache.get(`netease:${cacheKey}`);
    if (cached) songId = cached;
  }

  // 若无可用 ID，根据 歌名 + 歌手 检索网易云歌曲 ID
  if (!songId) {
    const title = cleanTitle(musicItem.title || "");
    const artist = cleanArtist(musicItem.artist || "");
    const q = artist ? `${title} ${artist}` : title;
    if (!q) return { isEnd: true, data: [] };

    try {
      const searchRes = await httpGet("https://music.163.com/api/cloudsearch/pc", {
        params: { s: q, type: 1, limit: 3, offset: 0 },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://music.163.com/",
        },
        timeout: 4500,
      });

      const firstSong = searchRes.data?.result?.songs?.[0];
      if (firstSong && firstSong.id) {
        songId = String(firstSong.id);
        if (cacheKey !== ":::") {
          setCachedId(`netease:${cacheKey}`, songId);
        }
      }
    } catch (e) {}
  }

  if (!songId) {
    return { isEnd: true, data: [] };
  }

  const pageSize = 20;
  const offset = (Math.max(1, page) - 1) * pageSize;

  try {
    const res = await httpGet(
      `https://music.163.com/api/v1/resource/comments/R_SO_4_${songId}`,
      {
        params: { limit: pageSize, offset },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://music.163.com/",
        },
        timeout: 5000,
      }
    );

    const data = res.data || {};
    const commentsList = [];
    const seenIds = new Set();

    function formatNeteaseComment(c) {
      if (!c || !c.commentId) return null;
      const cid = String(c.commentId);
      if (seenIds.has(cid)) return null;
      seenIds.add(cid);

      let replies;
      if (Array.isArray(c.beReplied) && c.beReplied.length > 0) {
        replies = c.beReplied
          .filter((r) => r && r.content)
          .map((r) => ({
            id: String(r.beRepliedCommentId || ""),
            nickName: r.user?.nickname || "回复",
            avatar: r.user?.avatarUrl || "",
            comment: r.content || "",
          }));
      }

      return {
        id: cid,
        nickName: c.user?.nickname || "网易云音乐用户",
        comment: c.content || "",
        avatar: c.user?.avatarUrl || "",
        like: typeof c.likedCount === "number" ? c.likedCount : 0,
        createAt: c.time || 0,
        location: c.ipLocation?.location || "",
        replies: replies && replies.length > 0 ? replies : undefined,
      };
    }

    // 第 1 页优先置顶精彩热评 (hotComments)
    if (page === 1 && Array.isArray(data.hotComments) && data.hotComments.length > 0) {
      for (const hc of data.hotComments) {
        const item = formatNeteaseComment(hc);
        if (item) commentsList.push(item);
      }
    }

    // 添加常规评论 (comments)
    if (Array.isArray(data.comments)) {
      for (const c of data.comments) {
        const item = formatNeteaseComment(c);
        if (item) commentsList.push(item);
      }
    }

    const isEnd =
      data.more === false ||
      !data.comments ||
      data.comments.length === 0 ||
      commentsList.length === 0;

    return {
      isEnd,
      data: commentsList,
    };
  } catch (e) {
    return { isEnd: true, data: [] };
  }
}

/**
 * 获取 QQ 音乐公开评论区 (支持点赞、头像与楼中楼回复)
 */
async function getQQComments(musicItem, page = 1) {
  if (!musicItem) return { isEnd: true, data: [] };

  let songId =
    musicItem.songid ||
    (musicItem._source === "qq" && /^\d+$/.test(String(musicItem.id))
      ? String(musicItem.id)
      : null);

  const cacheKey = getCacheKey(musicItem.title, musicItem.artist);
  if (!songId && cacheKey !== ":::") {
    const cached = songIdCache.get(`qq:${cacheKey}`);
    if (cached) songId = cached;
  }

  // 若无纯数字 ID，根据 歌名 + 歌手 检索 QQ 音乐歌曲数字 ID
  if (!songId) {
    const title = cleanTitle(musicItem.title || "");
    const artist = cleanArtist(musicItem.artist || "");
    const q = artist ? `${title} ${artist}` : title;
    if (!q) return { isEnd: true, data: [] };

    try {
      const searchRes = await httpGet("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
        params: { p: 1, n: 3, w: q, format: "json" },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://y.qq.com/",
        },
        timeout: 4500,
      });

      const firstSong = searchRes.data?.data?.song?.list?.[0];
      if (firstSong && firstSong.songid) {
        songId = String(firstSong.songid);
        if (cacheKey !== ":::") {
          setCachedId(`qq:${cacheKey}`, songId);
        }
      }
    } catch (e) {}
  }

  if (!songId) {
    return { isEnd: true, data: [] };
  }

  const pageSize = 25;
  const pageNum = Math.max(0, page - 1);

  try {
    const res = await httpGet(
      "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg",
      {
        params: {
          biztype: 1,
          topid: songId,
          cmd: 8,
          pagenum: pageNum,
          pagesize: pageSize,
        },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://y.qq.com/",
        },
        timeout: 5000,
      }
    );

    const cmtData = res.data?.comment || {};
    const commentListRaw = cmtData.commentlist || [];
    const hotListRaw = (page === 1 && cmtData.hot_comment?.commentlist) || [];
    const commentsList = [];
    const seenIds = new Set();

    function formatQQComment(c) {
      if (!c || !c.commentid) return null;
      const cid = String(c.commentid);
      if (seenIds.has(cid)) return null;
      seenIds.add(cid);

      let replies;
      if (Array.isArray(c.middlecommentcontent) && c.middlecommentcontent.length > 0) {
        replies = c.middlecommentcontent
          .filter((r) => r && (r.subcommentcontent || r.replycontent))
          .map((r) => ({
            id: String(r.subcommentid || ""),
            nickName: r.replynick || "回复",
            avatar: "",
            comment: r.subcommentcontent || r.replycontent || "",
          }));
      }

      return {
        id: cid,
        nickName: c.nick || "QQ音乐用户",
        comment: c.rootcommentcontent || "",
        avatar: c.avatarurl || "",
        like: typeof c.praisenum === "number" ? c.praisenum : 0,
        createAt: (c.time || 0) * 1000,
        location: "",
        replies: replies && replies.length > 0 ? replies : undefined,
      };
    }

    // 第 1 页优先置顶 QQ 音乐热评
    if (page === 1) {
      for (const hc of hotListRaw) {
        const item = formatQQComment(hc);
        if (item) commentsList.push(item);
      }
    }

    // 添加常规评论列表
    for (const c of commentListRaw) {
      const item = formatQQComment(c);
      if (item) commentsList.push(item);
    }

    const isEnd =
      cmtData.morecomment === 0 ||
      commentListRaw.length === 0 ||
      commentsList.length === 0;

    return {
      isEnd,
      data: commentsList,
    };
  } catch (e) {
    return { isEnd: true, data: [] };
  }
}

/**
 * 智能跨源歌曲评论调度与容灾核心
 * 优先级:
 * 1. 当前曲目关联音源 (若实现了 getMusicComments 则原汁原味透传)
 * 2. 已激活的其他音源 (若实现了 getMusicComments)
 * 3. 跨源热评容灾 (若用户开启 enableCrossComments，优先网易云热评，兜底 QQ 音乐)
 */
async function resolveMusicCommentsWithFallback(
  musicItem,
  page = 1,
  env = {},
  activeSources = []
) {
  if (!musicItem) return { isEnd: true, data: [] };

  // 是否开启跨源热评兜底（默认 true，若用户在设置中填 false 则关闭）
  const allowCrossFallback = parseBooleanFlag(env.enableCrossComments, true);

  // -------------------------------------------------------------
  // Step 1: 原音源优先策略 (若当前歌曲有明确的 _source 且已加载)
  // -------------------------------------------------------------
  const sourceKey = (musicItem._source || "").toLowerCase();
  if (sourceKey && Array.isArray(activeSources)) {
    const origSource = activeSources.find(
      (s) =>
        (s.key && s.key.toLowerCase() === sourceKey) ||
        (s.platform && s.platform.toLowerCase() === sourceKey) ||
        (s.name && s.name.toLowerCase() === sourceKey)
    );

    if (origSource && typeof origSource.getMusicComments === "function") {
      try {
        const res = await origSource.getMusicComments(musicItem, page);
        if (res && Array.isArray(res.data) && res.data.length > 0) {
          return {
            isEnd: !!res.isEnd,
            data: res.data,
          };
        }
      } catch (e) {}
    }
  }

  // -------------------------------------------------------------
  // Step 2: 轮询其他已注册的第三方音源插件 (若实现了 getMusicComments)
  // -------------------------------------------------------------
  if (Array.isArray(activeSources)) {
    for (const source of activeSources) {
      if (
        typeof source.getMusicComments === "function" &&
        source.key !== sourceKey
      ) {
        try {
          const res = await source.getMusicComments(musicItem, page);
          if (res && Array.isArray(res.data) && res.data.length > 0) {
            return {
              isEnd: !!res.isEnd,
              data: res.data,
            };
          }
        } catch (e) {}
      }
    }
  }

  // -------------------------------------------------------------
  // Step 3: 跨源公共热评兜底 (若开关开启)
  // -------------------------------------------------------------
  if (allowCrossFallback) {
    // 3.1 优先拉取网易云热评
    try {
      const neteaseRes = await getNeteaseComments(musicItem, page);
      if (neteaseRes && Array.isArray(neteaseRes.data) && neteaseRes.data.length > 0) {
        return neteaseRes;
      }
    } catch (e) {}

    // 3.2 兜底拉取 QQ 音乐评论
    try {
      const qqRes = await getQQComments(musicItem, page);
      if (qqRes && Array.isArray(qqRes.data) && qqRes.data.length > 0) {
        return qqRes;
      }
    } catch (e) {}
  }

  return { isEnd: true, data: [] };
}

module.exports = {
  getNeteaseComments,
  getQQComments,
  resolveMusicCommentsWithFallback,
};

  },
  "./core/lyric-searcher": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { httpGet, httpPost, parseLooseJson } = require("../utils/http");

let config = {};
try {
  config = require("../config");
} catch (e1) {
  try {
    config = require("./config-pure");
  } catch (e2) {
    try {
      config = require("./config");
    } catch (e3) {
      config = {};
    }
  }
}

const defaultArtwork = config?.defaultArtwork || "https://github.com/mengkuikun.png";
const platformName = config?.platform || "智能多源聚合";

/**
 * 网易云音乐歌词检索
 */
async function searchNetEaseLyrics(query, page = 1, pageSize = 10) {
  try {
    const res = await httpGet("https://music.163.com/api/search/get/web", {
      params: {
        s: query,
        type: 1, // 歌曲搜索能精准定位正版音频及歌词
        offset: (page - 1) * pageSize,
        limit: pageSize,
      },
      headers: {
        Referer: "https://music.163.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 4000,
    });

    const songs = res.data?.result?.songs || [];
    const total = res.data?.result?.songCount || songs.length;

    return {
      isEnd: page * pageSize >= total,
      data: songs.map((s) => ({
        id: "lrc_netease_" + s.id,
        _rawId: String(s.id),
        title: s.name,
        artist: (s.artists || []).map((a) => a.name).join(" / "),
        album: (s.album?.name ? s.album.name + " · " : "") + "[网易云音乐]",
        artwork: s.album?.picUrl || defaultArtwork,
        _source: "netease",
        platform: platformName,
        _isLyricSearchItem: true,
      })),
    };
  } catch (e) {
    return { isEnd: true, data: [] };
  }
}

/**
 * QQ 音乐歌词检索 (通过 musicu.fcg 接口，含关键 comm 信令)
 */
async function searchQQLyrics(query, page = 1, pageSize = 10) {
  const headers = {
    referer: "https://y.qq.com",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
    Cookie: "uin=",
  };

  try {
    const res = await httpPost(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        comm: { ct: "19", cv: "1873", uin: "0" },
        req_1: {
          method: "DoSearchForQQMusicDesktop",
          module: "music.search.SearchCgiService",
          param: {
            num_per_page: pageSize,
            page_num: page,
            query: query,
            search_type: 0, // 0 为歌曲直达
          },
        },
      },
      { headers, timeout: 3000 }
    );

    const songData = res.data?.req_1?.data?.body?.song;
    const list = songData?.list || res.data?.req_1?.data?.body?.item_song || [];
    const total = songData?.totalnum || list.length;

    return {
      isEnd: page * pageSize >= total,
      data: list.map((s) => ({
        id: "lrc_qq_" + (s.mid || s.id),
        _rawId: s.mid || String(s.id),
        songmid: s.mid,
        title: s.name || s.title,
        artist: (s.singer || []).map((a) => a.name).join(" / "),
        album: (s.album?.name ? s.album.name + " · " : "") + "[QQ音乐]",
        artwork: s.album?.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
          : defaultArtwork,
        _source: "qq",
        platform: platformName,
        _isLyricSearchItem: true,
      })),
    };
  } catch (e) {
    return { isEnd: true, data: [] };
  }
}

/**
 * 酷我音乐歌词检索 (支持内置源或独立 HTTP 双通道)
 */
async function searchKuwoLyrics(query, page = 1, pageSize = 10, kuwoSource) {
  // 1. 如果内置源就绪，优先利用内置源
  if (kuwoSource && typeof kuwoSource.search === "function") {
    try {
      const res = await kuwoSource.search(query, page, "music");
      const list = res?.data || [];
      if (list.length > 0) {
        return {
          isEnd: res?.isEnd ?? (page * pageSize >= list.length),
          data: list.slice(0, pageSize).map((s) => ({
            id: "lrc_kuwo_" + s.id,
            _rawId: String(s.id),
            title: s.title || s.name,
            artist: s.artist,
            album: (s.album ? s.album + " · " : "") + "[酷我音乐]",
            artwork: s.artwork || defaultArtwork,
            _source: "kuwo",
            platform: platformName,
            _isLyricSearchItem: true,
          })),
        };
      }
    } catch (e) {}
  }

  // 2. 独立轻量 HTTP 备选通道 (纯净版与脱机模式通用)
  try {
    const res = await httpGet("https://search.kuwo.cn/r.s", {
      params: {
        all: query,
        ft: "music",
        itemset: "web_2013",
        client: "kt",
        pn: (page - 1) * pageSize,
        rn: pageSize,
        rformat: "json",
        encoding: "utf8",
      },
      headers: {
        "User-Agent": "okhttp/3.10.0",
      },
      responseType: "text",
      timeout: 4000,
    });
    const parsed = parseLooseJson(res.data);
    const list = parsed?.abslist || [];
    const total = parseInt(parsed?.TOTAL) || list.length;
    return {
      isEnd: page * pageSize >= total,
      data: list.map((s) => {
        const cleanTitle = (s.SONGNAME || "").replace(/&nbsp;/g, " ");
        const cleanArtist = (s.ARTIST || "").replace(/&nbsp;/g, " ");
        const rawId = (s.MUSICRID || "").replace(/^MUSIC_/, "") || String(s.DC_TARGETID || "");
        return {
          id: "lrc_kuwo_" + rawId,
          _rawId: rawId,
          title: cleanTitle,
          artist: cleanArtist,
          album: (s.ALBUM ? s.ALBUM.replace(/&nbsp;/g, " ") + " · " : "") + "[酷我音乐]",
          artwork: defaultArtwork,
          _source: "kuwo",
          platform: platformName,
          _isLyricSearchItem: true,
        };
      }),
    };
  } catch (e) {
    return { isEnd: true, data: [] };
  }
}

/**
 * 外部动态插件歌词检索
 */
async function searchDynamicPluginLyrics(plugin, query, page = 1, pageSize = 10) {
  if (!plugin || typeof plugin.search !== "function") {
    return [];
  }

  try {
    const res = await Promise.race([
      plugin.search(query, page, "lyric"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1500)),
    ]);

    if (res && Array.isArray(res.data)) {
      const pluginName = plugin.name || plugin.platform || "外部源";
      return res.data.slice(0, pageSize).map((item, idx) => ({
        ...item,
        id: `lrc_dyn_${plugin.key || pluginName}_${item.id || idx}`,
        _rawId: String(item.id || idx),
        title: item.title || item.name,
        artist: item.artist || item.singer || "",
        album: (item.album ? item.album + " · " : "") + `[${pluginName}]`,
        artwork: item.artwork || item.cover || defaultArtwork,
        _source: plugin.key || pluginName,
        _sourceUrl: plugin._sourceUrl || "",
        platform: platformName,
        _isLyricSearchItem: true,
      }));
    }
  } catch (e) {}

  return [];
}

/**
 * 全网多源聚合歌词搜索核心入口 (极速并发 + 异步预热)
 */
async function unifiedSearchLyric(query, page = 1, env = {}, builtInSources = {}, dynamicSources = []) {
  if (!query || typeof query !== "string") {
    return { isEnd: true, data: [] };
  }

  const cleanQ = query.trim();
  const pageSize = 10;

  const neteaseSource = builtInSources.netease;
  const qqSource = builtInSources.qq;
  const kuwoSource = builtInSources.kuwo;

  const tasks = [
    searchNetEaseLyrics(cleanQ, page, pageSize),
    searchQQLyrics(cleanQ, page, pageSize),
    searchKuwoLyrics(cleanQ, page, pageSize, kuwoSource),
  ];

  // 关键修复：仅筛选明确声明支持 lyric 检索的动态插件，严禁将带有播放 getLyric 的普通播放源当作歌词搜索引擎！
  const lyricDynamicSources = (dynamicSources || []).filter(
    (s) => s && Array.isArray(s.supportedSearchType) && s.supportedSearchType.includes("lyric")
  );

  lyricDynamicSources.forEach((ds) => {
    tasks.push(
      searchDynamicPluginLyrics(ds, cleanQ, page, pageSize).then((items) => ({
        isEnd: true,
        data: items,
      }))
    );
  });

  const settled = await Promise.allSettled(tasks);

  const neResult = settled[0]?.status === "fulfilled" ? settled[0].value?.data || [] : [];
  const qqResult = settled[1]?.status === "fulfilled" ? settled[1].value?.data || [] : [];
  const kwResult = settled[2]?.status === "fulfilled" ? settled[2].value?.data || [] : [];
  const dynResults = [];

  for (let i = 3; i < settled.length; i++) {
    if (settled[i]?.status === "fulfilled" && Array.isArray(settled[i].value?.data)) {
      dynResults.push(...settled[i].value.data);
    }
  }

  // 交叉交织 (Interleave) 聚合排序：确保各音源精品均能在前排展示
  const combined = [];
  const maxLen = Math.max(neResult.length, qqResult.length, kwResult.length, dynResults.length);

  for (let i = 0; i < maxLen; i++) {
    if (neResult[i]) combined.push(neResult[i]);
    if (qqResult[i]) combined.push(qqResult[i]);
    if (kwResult[i]) combined.push(kwResult[i]);
    if (dynResults[i]) combined.push(dynResults[i]);
  }

  // 首屏后台静默预拉取首项歌词 (fire-and-forget，绝不阻断列表立即返回)
  if (page === 1 && combined.length > 0) {
    const topNE = combined.find((it) => it._source === "netease");
    if (topNE) {
      directFetchNetEaseLyric(topNE._rawId).then((res) => {
        if (res && res.rawLrc) {
          topNE.rawLrc = res.rawLrc;
          topNE.translation = res.translation || "";
        }
      }).catch(() => {});
    }

    const topQQ = combined.find((it) => it._source === "qq");
    if (topQQ) {
      directFetchQQLyric(topQQ.songmid || topQQ._rawId).then((res) => {
        if (res && res.rawLrc) {
          topQQ.rawLrc = res.rawLrc;
          topQQ.translation = res.translation || "";
        }
      }).catch(() => {});
    }
  }

  const isAllEnd = settled.every((r) => r.status === "fulfilled" && r.value?.isEnd !== false);

  return {
    isEnd: isAllEnd || combined.length === 0,
    data: combined,
  };
}

/**
 * 网易云歌词直连提取通道
 */
async function directFetchNetEaseLyric(id) {
  if (!id) return null;
  try {
    const res = await httpGet("https://music.163.com/api/song/lyric", {
      params: { id, lv: 1, kv: 1, tv: -1 },
      headers: {
        Referer: "https://music.163.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 4000,
    });
    const rawLrc = res.data?.lrc?.lyric;
    const translation = res.data?.tlyric?.lyric;
    if (rawLrc && typeof rawLrc === "string" && rawLrc.trim().length > 10) {
      return { rawLrc, translation: translation || "" };
    }
  } catch (e) {}
  return null;
}

/**
 * QQ 音乐歌词直连提取通道
 */
async function directFetchQQLyric(songmid) {
  if (!songmid) return null;
  try {
    const res = await httpGet("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg", {
      params: {
        songmid,
        g_tk: 5381,
        format: "json",
        nobase64: 1,
      },
      headers: {
        Referer: "https://y.qq.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 4000,
    });
    const rawLrc = res.data?.lyric;
    const translation = res.data?.trans;
    if (rawLrc && typeof rawLrc === "string" && rawLrc.trim().length > 10) {
      return { rawLrc, translation: translation || "" };
    }
  } catch (e) {}
  return null;
}

/**
 * 酷我音乐歌词直连提取通道
 */
async function directFetchKuwoLyric(rid) {
  if (!rid) return null;
  const cleanId = String(rid).replace(/^MUSIC_/, "");
  try {
    const res = await httpGet("https://m.kuwo.cn/newh5/singles/songinfoandlrc", {
      params: { musicId: cleanId },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 4000,
    });
    const lrclist = res.data?.data?.lrclist;
    if (Array.isArray(lrclist) && lrclist.length > 0) {
      const lrcText = lrclist
        .map((l) => {
          const time = parseFloat(l.time) || 0;
          const min = Math.floor(time / 60).toString().padStart(2, "0");
          const sec = (time % 60).toFixed(2).padStart(5, "0");
          return `[${min}:${sec}]${l.lineLyric || ""}`;
        })
        .join("\n");
      return { rawLrc: lrcText, translation: "" };
    }
  } catch (e) {}
  return null;
}

function pickUsableLyricResult(res) {
  if (!res || typeof res !== "object") return null;
  const hasRaw =
    typeof res.rawLrc === "string" && res.rawLrc.trim().length > 5;
  const hasUrl =
    typeof res.lrc === "string" && /^https?:\/\//i.test(res.lrc.trim());
  if (!hasRaw && !hasUrl) return null;
  return {
    rawLrc: hasRaw ? res.rawLrc : "",
    lrc: hasUrl ? res.lrc.trim() : "",
    translation: res.translation || "",
  };
}

/**
 * 针对搜索选中的特定歌词项进行精准提取 (0ms 预取命中 + 独立高可用 HTTP 直通 + 远程 lrc URL 透传)
 */
async function resolveDirectLyricItem(musicItem, builtInSources = {}, dynamicSources = []) {
  // 1. 如果已预加载有 rawLrc，直接 0ms 返回
  if (musicItem.rawLrc && typeof musicItem.rawLrc === "string" && musicItem.rawLrc.trim().length > 10) {
    return {
      rawLrc: musicItem.rawLrc,
      translation: musicItem.translation || "",
    };
  }

  const idStr = String(musicItem.id || "");
  const rawId = musicItem._rawId || idStr.replace(/^lrc_[a-z0-9]+_/, "");
  const isSearchTarget = !!musicItem._isLyricSearchItem || idStr.startsWith("lrc_");

  // 若非歌词搜索点击项，直接交给外层 Step 1/Step 1.5 处理，避免与 origSource 重复调用以及 _source 为空时误匹配动态插件
  if (!isSearchTarget) {
    return { rawLrc: "", translation: "" };
  }

  const callGetLyricWithTimeout = (fn, timeoutMs = 2000) =>
    Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]).catch(() => null);

  // 2. 网易云定向拉取 (优先内置源，备选直连 HTTP)
  if (musicItem._source === "netease" || idStr.startsWith("lrc_netease_")) {
    const neSource = builtInSources.netease;
    if (neSource && typeof neSource.getLyric === "function") {
      try {
        const picked = pickUsableLyricResult(
          await callGetLyricWithTimeout(() => neSource.getLyric({ id: rawId }))
        );
        if (picked) return picked;
      } catch (e) {}
    }
    const directRes = await directFetchNetEaseLyric(rawId);
    if (directRes) return directRes;
  }

  // 3. QQ 音乐定向拉取 (优先内置源，备选直连 HTTP)
  if (musicItem._source === "qq" || idStr.startsWith("lrc_qq_")) {
    const qqSource = builtInSources.qq;
    if (qqSource && typeof qqSource.getLyric === "function") {
      try {
        const picked = pickUsableLyricResult(
          await callGetLyricWithTimeout(() =>
            qqSource.getLyric({ songmid: musicItem.songmid || rawId })
          )
        );
        if (picked) return picked;
      } catch (e) {}
    }
    const directRes = await directFetchQQLyric(musicItem.songmid || rawId);
    if (directRes) return directRes;
  }

  // 4. 酷我音乐定向拉取 (优先内置源，备选直连 HTTP)
  if (musicItem._source === "kuwo" || idStr.startsWith("lrc_kuwo_")) {
    const kwSource = builtInSources.kuwo;
    if (kwSource && typeof kwSource.getLyric === "function") {
      try {
        const picked = pickUsableLyricResult(
          await callGetLyricWithTimeout(() => kwSource.getLyric({ id: rawId }))
        );
        if (picked) return picked;
      } catch (e) {}
    }
    const directRes = await directFetchKuwoLyric(rawId);
    if (directRes) return directRes;
  }

  // 5. 动态插件定向拉取（严格校验非空 _sourceUrl / _source，彻底杜绝 undefined === undefined 误中全量插件）
  const targetSourceUrl = String(musicItem._sourceUrl || "").trim();
  const targetSourceKey = String(musicItem._source || "").trim().toLowerCase();
  const matchedDynamics =
    targetSourceUrl || targetSourceKey
      ? (dynamicSources || []).filter(
          (ds) =>
            ds &&
            typeof ds.getLyric === "function" &&
            ((targetSourceUrl && ds._sourceUrl === targetSourceUrl) ||
              (targetSourceKey &&
                ((ds.key && String(ds.key).toLowerCase() === targetSourceKey) ||
                  (ds.platform && String(ds.platform).toLowerCase() === targetSourceKey) ||
                  (ds.name && String(ds.name).toLowerCase() === targetSourceKey))))
        )
      : [];
  if (targetSourceUrl && matchedDynamics.length > 1) {
    matchedDynamics.sort((a, b) => {
      const aExact = a._sourceUrl === targetSourceUrl ? 0 : 1;
      const bExact = b._sourceUrl === targetSourceUrl ? 0 : 1;
      return aExact - bExact;
    });
  }
  for (const matchedDynamic of matchedDynamics) {
    try {
      const picked = pickUsableLyricResult(
        await callGetLyricWithTimeout(
          () => matchedDynamic.getLyric({ ...musicItem, id: rawId }),
          2000
        )
      );
      if (picked) return picked;
    } catch (e) {}
  }

  // 6. 若歌词搜索条目本身携带了 .lrc URL，则直接透传给上层 fetchRemoteLrcIfNeeded 拉取
  if (typeof musicItem.lrc === "string" && /^https?:\/\//i.test(musicItem.lrc.trim())) {
    return {
      rawLrc: "",
      lrc: musicItem.lrc.trim(),
      translation: musicItem.translation || "",
    };
  }

  return { rawLrc: "", translation: "" };
}

module.exports = {
  searchNetEaseLyrics,
  searchQQLyrics,
  searchKuwoLyrics,
  unifiedSearchLyric,
  resolveDirectLyricItem,
  directFetchNetEaseLyric,
  directFetchQQLyric,
  directFetchKuwoLyric,
};

  },
  "./core/fallback-helpers": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { httpGet, parseBooleanFlag, isTlsOrConnectionError } = require("../utils/http");
const {
  getMediaSourceWithTimeout,
  isFatalNetworkError,
  getQualityFallbackLadder,
} = require("./quality-fallback");

const AUDIO_EXTS = new Set([
  "mp3", "flac", "m4a", "m4s", "aac", "ogg", "wav", "ape", "wma", "opus", "webm",
]);
const SCRIPT_EXTS = new Set([
  "php", "jsp", "asp", "aspx", "do", "action", "cgi",
]);

const AUDIOBOOK_OR_STORAGE_RE =
  /喜马拉雅|ximalaya|猫耳|荔枝|lizhi|番茄|fanqie|cctv|听音|webdav|navidrome|emby|jellyfin|alist|udio|audiomack/i;
const DJ_SOURCE_RE =
  /(?:^|[^a-z])dj|mix|舞曲|电音阁|串烧|先上|皮狗|清风|宝贝|魅力|小熊电音/i;

/**
 * 运行期音源健康状态追踪（基于延迟与连续失败做会话级降权熔断，5 分钟自动衰减恢复）
 */
const HEALTH_DECAY_MS = 5 * 60 * 1000;
const sourceHealthMap = new Map();

const SOFT_FAIL_SINK_THRESHOLD = 3;

function getSourceHealthId(source) {
  if (!source) return "";
  return String(source._sourceUrl || source.key || source.platform || source.name || "").trim();
}

function getSourceHealthState(source) {
  const id = getSourceHealthId(source);
  if (!id) return null;
  const st = sourceHealthMap.get(id);
  if (!st) return null;
  if (st.lastFailAt && Date.now() - st.lastFailAt > HEALTH_DECAY_MS) {
    sourceHealthMap.delete(id);
    return null;
  }
  return st;
}

function recordSearchLatency(source, elapsedMs = 0) {
  const id = getSourceHealthId(source);
  if (!id) return;
  const prev = getSourceHealthState(source) || {
    fatalFailStreak: 0,
    softFailStreak: 0,
    failStreak: 0,
    lastFailAt: 0,
    avgMs: 0,
  };
  const avgMs = prev.avgMs ? Math.round(prev.avgMs * 0.6 + elapsedMs * 0.4) : elapsedMs;
  sourceHealthMap.set(id, { ...prev, avgMs });
}

function recordSourceSuccess(source, elapsedMs = 0) {
  const id = getSourceHealthId(source);
  if (!id) return;
  const prev = sourceHealthMap.get(id) || {};
  const avgMs = prev.avgMs ? Math.round(prev.avgMs * 0.6 + elapsedMs * 0.4) : elapsedMs;
  sourceHealthMap.set(id, {
    fatalFailStreak: 0,
    softFailStreak: 0,
    failStreak: 0,
    lastFailAt: 0,
    avgMs,
  });
}

function recordSourceSoftFailure(source) {
  const id = getSourceHealthId(source);
  if (!id) return;
  const prev = getSourceHealthState(source) || {
    fatalFailStreak: 0,
    softFailStreak: 0,
    failStreak: 0,
    avgMs: 0,
  };
  const softFailStreak = (prev.softFailStreak || 0) + 1;
  sourceHealthMap.set(id, {
    fatalFailStreak: prev.fatalFailStreak || 0,
    softFailStreak,
    failStreak: (prev.fatalFailStreak || 0) + (softFailStreak >= SOFT_FAIL_SINK_THRESHOLD ? softFailStreak : 0),
    lastFailAt: Date.now(),
    avgMs: prev.avgMs || 0,
  });
}

function recordSourceFailure(source, isFatal = false) {
  if (isFatal === "soft") {
    recordSourceSoftFailure(source);
    return;
  }
  const id = getSourceHealthId(source);
  if (!id) return;
  const prev = getSourceHealthState(source) || {
    fatalFailStreak: 0,
    softFailStreak: 0,
    failStreak: 0,
    avgMs: 0,
  };
  const delta = isFatal ? 2 : 1;
  const fatalFailStreak = (prev.fatalFailStreak || 0) + delta;
  sourceHealthMap.set(id, {
    fatalFailStreak,
    softFailStreak: prev.softFailStreak || 0,
    failStreak: fatalFailStreak + (prev.softFailStreak || 0),
    lastFailAt: Date.now(),
    avgMs: prev.avgMs || 0,
  });
}

/**
 * 通用 Promise 超时包装（避免同步异常或永不返回的第三方插件挂死链路）
 */
function withTimeout(taskOrPromise, timeoutMs, fallbackValue = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallbackValue);
      }
    }, timeoutMs);

    try {
      const p =
        typeof taskOrPromise === "function"
          ? Promise.resolve().then(taskOrPromise)
          : Promise.resolve(taskOrPromise);
      p.then(
        (res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(res);
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(fallbackValue);
          }
        }
      );
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      }
    }
  });
}

/**
 * 带超时与状态标记的搜索（区分“正常无结果”与“超时/网络错误”，避免对死源二次重搜浪费时间）
 */
function searchWithStatusTimeout(source, query, page = 1, type = "music", timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ isEnd: true, data: [], _timedOut: true, _error: false });
      }
    }, timeoutMs);

    try {
      Promise.resolve(source.search(query, page, type)).then(
        (res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(res || { isEnd: true, data: [] });
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ isEnd: true, data: [], _timedOut: false, _error: true });
          }
        }
      );
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ isEnd: true, data: [], _timedOut: false, _error: true });
      }
    }
  });
}

/**
 * 过滤并按能力与健康度排布音源顺序（确保 Chunk 0 由健康主流音乐源主导，过滤歌词/纯专辑等不可播源）
 */
function orderSourcesForPlayback(orderedSources = [], target = {}) {
  const hint = `${target.title || ""} ${target.artist || ""}`.toLowerCase();
  const wantsDj = /dj|remix|电音|串烧|慢摇|舞曲/.test(hint);
  const wantsAudio = /有声|相声|评书|广播|播客|小说|故事/.test(hint);

  const candidates = [];
  for (let i = 0; i < orderedSources.length; i++) {
    const s = orderedSources[i];
    if (!s || typeof s.search !== "function" || typeof s.getMediaSource !== "function") {
      continue;
    }
    if (Array.isArray(s.supportedSearchType) && !s.supportedSearchType.includes("music")) {
      continue;
    }

    const label = `${s.name || ""} ${s.platform || ""} ${s.key || ""}`;
    const health = getSourceHealthState(s);
    const fatalStreak = health ? health.fatalFailStreak || 0 : 0;
    const softStreak = health ? health.softFailStreak || 0 : 0;

    let bucket = 0;
    if (fatalStreak >= 1 || softStreak >= SOFT_FAIL_SINK_THRESHOLD) {
      bucket += 20 + Math.min(fatalStreak + softStreak, 12);
    } else if (AUDIOBOOK_OR_STORAGE_RE.test(label) && !wantsAudio) {
      bucket += 10;
    } else if (DJ_SOURCE_RE.test(label) && !wantsDj) {
      bucket += 8;
    } else if (s._tier === "tier3" || s.key === "fivesing" || s.key === "ximalaya") {
      bucket += 4;
    }

    candidates.push({ source: s, bucket, index: i });
  }

  candidates.sort((a, b) => a.bucket - b.bucket || a.index - b.index);
  return candidates.map((c) => c.source);
}

/**
 * 分批竞速搜索：只要有高置信度匹配（>=88分）或任意命中过短暂宽限即立刻出链，不被同批死源超时拖垮
 */
function raceSearchChunk({
  chunkSources,
  queryStr,
  titleClean,
  artistClean,
  target,
  findBestMatch,
  primaryTimeoutMs = 1500,
  retryTimeoutMs = 1000,
}) {
  return new Promise((resolve) => {
    const matches = [];
    let resolvedEarly = false;
    let graceTimer = null;

    const finishEarly = () => {
      if (resolvedEarly) return;
      resolvedEarly = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        matches: matches.slice(),
        settledAll: false,
        remainingPromise,
      });
    };

    const scheduleGrace = (ms) => {
      if (resolvedEarly) return;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(finishEarly, ms);
    };

    let bestScoreSoFar = 0;

    const tasks = chunkSources.map(async (source) => {
      const startAt = Date.now();
      try {
        const res1 = await searchWithStatusTimeout(
          source,
          queryStr,
          1,
          "music",
          primaryTimeoutMs
        );
        if (res1._timedOut || res1._error) {
          recordSourceFailure(source, true);
          return null;
        }

        let list = Array.isArray(res1.data) ? res1.data : [];
        if (list.length === 0 && artistClean) {
          const res2 = await searchWithStatusTimeout(
            source,
            titleClean,
            1,
            "music",
            retryTimeoutMs
          );
          if (res2._timedOut || res2._error) {
            recordSourceFailure(source, true);
            return null;
          }
          if (Array.isArray(res2.data)) list = res2.data;
        }

        recordSearchLatency(source, Date.now() - startAt);
        if (list.length > 0) {
          const bestMatch = findBestMatch(target, list, 55);
          if (bestMatch) {
            const score = bestMatch._matchScore || 0;
            const hit = { source, bestMatch, score };
            matches.push(hit);
            if (!resolvedEarly) {
              if (score >= 88 && bestScoreSoFar < 88) {
                bestScoreSoFar = score;
                scheduleGrace(180);
              } else if (matches.length === 1) {
                bestScoreSoFar = score;
                scheduleGrace(score >= 88 ? 180 : 420);
              }
            }
            return hit;
          }
        }
      } catch (e) {
        recordSourceFailure(source, isFatalNetworkError(e));
      }
      return null;
    });

    const remainingPromise = Promise.allSettled(tasks).then(() => matches.slice());

    remainingPromise.then(() => {
      if (!resolvedEarly) {
        resolvedEarly = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolve({
          matches: matches.slice(),
          settledAll: true,
          remainingPromise,
        });
      }
    });
  });
}

/**
 * 统一规范化音频流（安全识别 .php/无后缀 302 重定向、拦截 HTML 错误页与强制下载附件，1400ms 极限探测）
 */
async function normalizeMediaSourceShared(mediaRes, isInvalid404Url) {
  if (!mediaRes || !mediaRes.url || typeof mediaRes.url !== "string") {
    return null;
  }

  try {
    const rawUrl = mediaRes.url.trim();
    if (isInvalid404Url(rawUrl)) {
      return null;
    }

    const cleanPath = rawUrl.split("?")[0].split("#")[0];
    const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
    const ext = match ? match[1].toLowerCase() : "";

    // 1. 标准音频后缀直接 0 延迟放行
    if (AUDIO_EXTS.has(ext)) {
      return mediaRes;
    }

    // 2. .php 脚本或无后缀直链，快速追踪跳转并校验证书/响应头
    if (SCRIPT_EXTS.has(ext) || !ext) {
      let finalUrl = rawUrl;
      let contentType = "";
      let isUnplayableAttachment = false;

      try {
        const probeRes = await httpGet(rawUrl, {
          headers: mediaRes.headers || {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          maxRedirects: 3,
          timeout: 1100,
          responseType: "stream",
        });

        if (probeRes.status === 404 || probeRes.status === 410 || probeRes.status >= 500) {
          if (probeRes.data && typeof probeRes.data.destroy === "function") {
            probeRes.data.destroy();
          }
          return null;
        }

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
          contentType = (probeRes.headers["content-type"] || "").toLowerCase();
          const disp = (probeRes.headers["content-disposition"] || "").toLowerCase();
          if (disp.includes("attachment") || contentType.includes("text/html")) {
            isUnplayableAttachment = true;
          }
        }

        if (probeRes.data && typeof probeRes.data.destroy === "function") {
          probeRes.data.destroy();
        }
      } catch (probeErr) {
        const status = probeErr && probeErr.response ? probeErr.response.status : 0;
        if (status === 404 || status === 410 || status >= 500) {
          return null;
        }
      }

      if (isUnplayableAttachment) {
        return null;
      }

      const finalCleanPath = finalUrl.split("?")[0].split("#")[0];
      const finalMatch = finalCleanPath.match(/\.([a-zA-Z0-9]+)$/);
      const finalExt = finalMatch ? finalMatch[1].toLowerCase() : "";

      if (AUDIO_EXTS.has(finalExt)) {
        return {
          ...mediaRes,
          url: finalUrl,
        };
      }

      let targetExt = "mp3";
      if (contentType.includes("flac")) targetExt = "flac";
      else if (
        contentType.includes("mp4") ||
        contentType.includes("m4a") ||
        contentType.includes("aac")
      ) {
        targetExt = "m4a";
      } else if (contentType.includes("ogg")) targetExt = "ogg";
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
  } catch (err) {}

  return mediaRes;
}

/**
 * 候选源音质两轮竞速出链（先严守目标音质，再收拢慢到源；均不可用后方触发向下兼容降级）
 */
async function resolveCandidatesMedia({
  raceResult,
  quality,
  allowDowngrade,
  normalizeMediaSource,
  isInvalid404Url,
  matchCache,
  playbackSession,
  target,
  enableCache,
  defaultDisplayName,
  softFailedSourcesSet = null,
}) {
  const triedExactQualitySources = new Set();
  const fatallyFailedSources = new Set();
  const failedQualitiesBySource = new Map();
  const attemptedNonFatalSources = new Set();
  let collected = (raceResult.matches || []).slice();

  const expectedLadder = allowDowngrade
    ? getQualityFallbackLadder(quality, true)
    : [quality];

  const recordAttemptFailure = (source, attemptedQuality) => {
    if (!source || fatallyFailedSources.has(source)) return;
    attemptedNonFatalSources.add(source);
    let qSet = failedQualitiesBySource.get(source);
    if (!qSet) {
      qSet = new Set();
      failedQualitiesBySource.set(source, qSet);
    }
    qSet.add(attemptedQuality);
  };

  const applySongSoftFailures = (wonSource = null, exhaustedAllQualities = false) => {
    const softTargetSet = softFailedSourcesSet || new Set();
    for (const s of attemptedNonFatalSources) {
      if (!s || s === wonSource || fatallyFailedSources.has(s) || softTargetSet.has(s)) {
        continue;
      }
      const qSet = failedQualitiesBySource.get(s);
      const failedWholeLadder =
        exhaustedAllQualities ||
        (qSet && expectedLadder.every((q) => qSet.has(q)));
      if (failedWholeLadder) {
        softTargetSet.add(s);
        recordSourceSoftFailure(s);
      }
    }
  };

  const fetchBestCandidateAtQuality = async (list, targetQuality, perCallTimeoutMs) => {
    if (!list || list.length === 0) return null;
    const slots = list.map((candidate) => ({
      settled: false,
      value: null,
      score: candidate.score || 0,
    }));
    let settledCount = 0;

    return await new Promise((resolve) => {
      let resolved = false;
      let graceTimer = null;
      let graceDeadline = 0;

      const tryResolveBestReady = (forceAnyReady = false) => {
        if (resolved) return;
        for (let i = 0; i < slots.length; i++) {
          if (slots[i].settled) {
            if (slots[i].value) {
              resolved = true;
              if (graceTimer) clearTimeout(graceTimer);
              resolve(slots[i].value);
              return;
            }
          } else if (!forceAnyReady) {
            return;
          }
        }
        if (settledCount === slots.length) {
          resolved = true;
          if (graceTimer) clearTimeout(graceTimer);
          resolve(null);
        }
      };

      const getDynamicGraceMs = () => {
        let firstReadyIdx = -1;
        let bestReadyScore = -1;
        for (let i = 0; i < slots.length; i++) {
          if (slots[i].settled && slots[i].value) {
            if (firstReadyIdx === -1) firstReadyIdx = i;
            if (slots[i].score > bestReadyScore) bestReadyScore = slots[i].score;
          }
        }
        if (firstReadyIdx <= 0) return 900;
        let bestPendingScore = 0;
        for (let i = 0; i < firstReadyIdx; i++) {
          if (!slots[i].settled && slots[i].score > bestPendingScore) {
            bestPendingScore = slots[i].score;
          }
        }
        // 只有次高候选自身高分(>=90)且与榜首分差<=5时才缩短至 380ms，否则保留 900ms 保护精准原唱
        if (bestReadyScore >= 90 && bestPendingScore - bestReadyScore <= 5) {
          return 380;
        }
        return 900;
      };

      list.forEach(async (candidate, idx) => {
        try {
          const mediaRes = await getMediaSourceWithTimeout(
            candidate.source,
            candidate.bestMatch,
            targetQuality,
            perCallTimeoutMs
          );
          if (
            mediaRes &&
            mediaRes.url &&
            typeof mediaRes.url === "string" &&
            mediaRes.url.startsWith("http") &&
            !isInvalid404Url(mediaRes.url)
          ) {
            const normRes = await normalizeMediaSource(mediaRes);
            if (normRes && normRes.url && !isInvalid404Url(normRes.url)) {
              slots[idx].value = { candidate, normRes };
            }
          }
          if (!slots[idx].value) {
            recordAttemptFailure(candidate.source, targetQuality);
          }
        } catch (mediaErr) {
          if (isFatalNetworkError(mediaErr)) {
            fatallyFailedSources.add(candidate.source);
            recordSourceFailure(candidate.source, true);
          } else {
            recordAttemptFailure(candidate.source, targetQuality);
          }
        } finally {
          slots[idx].settled = true;
          settledCount++;
          if (!resolved) {
            tryResolveBestReady(false);
            if (!resolved && slots.some((s) => s.settled && s.value)) {
              const targetGraceMs = getDynamicGraceMs();
              const desiredDeadline = Date.now() + targetGraceMs;
              if (!graceTimer) {
                graceDeadline = desiredDeadline;
                graceTimer = setTimeout(() => tryResolveBestReady(true), targetGraceMs);
              } else if (desiredDeadline < graceDeadline - 50) {
                clearTimeout(graceTimer);
                graceDeadline = desiredDeadline;
                graceTimer = setTimeout(() => tryResolveBestReady(true), targetGraceMs);
              }
            }
          }
        }
      });
    });
  };

  const commitWinner = (winner, exhaustedAllQualities = false) => {
    if (!winner) return null;
    const { candidate, normRes } = winner;
    applySongSoftFailures(candidate.source, exhaustedAllQualities);
    const finalized = commitNormalizedMediaResult({
      normRes,
      matchCache,
      playbackSession,
      target,
      sourceObj: candidate.source,
      isFallback: true,
      matchedItem: candidate.bestMatch,
      enableCache,
      defaultDisplayName,
    });
    return {
      ...finalized,
      _matchedSong: `${candidate.bestMatch.title} - ${candidate.bestMatch.artist}`,
      _matchScore: candidate.bestMatch._matchScore,
    };
  };

  const tryBatchExactQuality = async (list) => {
    const sorted = list
      .filter((c) => !triedExactQualitySources.has(c.source) && !fatallyFailedSources.has(c.source))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    sorted.forEach((c) => triedExactQualitySources.add(c.source));
    return commitWinner(await fetchBestCandidateAtQuality(sorted, quality, 2500));
  };

  // 第一轮（快速到达批）：Top 3 并发拉链，严格目标音质
  const fastHit = await tryBatchExactQuality(collected);
  if (fastHit) return fastHit;

  // 若批内仍有尚未结束的稍慢候选源，收集完后再补试一轮目标音质（防止早产错过高音质原源）
  if (!raceResult.settledAll && raceResult.remainingPromise) {
    const fullMatches = await withTimeout(raceResult.remainingPromise, 950, null);
    if (Array.isArray(fullMatches) && fullMatches.length > collected.length) {
      collected = fullMatches;
      const lateHit = await tryBatchExactQuality(collected);
      if (lateHit) return lateHit;
    }
  }

  // 第二轮：次级音质阶梯向下兼容（同阶梯 Top 3 并发取链）
  if (allowDowngrade && collected.length > 0) {
    const ladder = expectedLadder.slice(1);
    const topCandidates = collected
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const fallbackQuality of ladder) {
      const alive = topCandidates.filter((c) => !fatallyFailedSources.has(c.source));
      if (alive.length === 0) break;
      const hit = commitWinner(
        await fetchBestCandidateAtQuality(alive, fallbackQuality, 2200)
      );
      if (hit) return hit;
    }
  }

  // 全部尝试音质均无可用播放链时，每首歌对失败候选仅记 1 次软失败（绝不在降级循环中重复累加）
  applySongSoftFailures(null, true);
  return null;
}

const LRC_TS_ANY_RE = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const PLACEHOLDER_ONLY_LYRIC_RE =
  /^(?:暂无歌词|纯音乐(?:[，,。\s]*请(?:您)?欣赏)?|此歌曲为没有填词的纯音乐(?:[，,。\s]*请(?:您)?欣赏)?|没有找到歌词|无歌词|instrumental|no\s*lyrics?)$/i;

function isUsableLyricText(rawLrc) {
  if (!rawLrc || typeof rawLrc !== "string") return false;
  const trimmed = rawLrc.trim();
  if (trimmed.length <= 5) return false;
  const hasTimestamp = LRC_TS_ANY_RE.test(trimmed);
  const stripped = trimmed
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped || PLACEHOLDER_ONLY_LYRIC_RE.test(stripped)) {
    return false;
  }
  if (hasTimestamp) {
    return stripped.length >= 4;
  }
  return stripped.length >= 25;
}

/**
 * 若歌词结果仅返回了远程 .lrc 链接而缺少 rawLrc 文本，预先下载原文以便统一注入音源标签
 */
async function fetchRemoteLrcIfNeeded(lrcRes, timeoutMs = 1800) {
  if (!lrcRes || typeof lrcRes !== "object") return null;
  if (isUsableLyricText(lrcRes.rawLrc)) {
    return lrcRes;
  }
  const lrcUrl = typeof lrcRes.lrc === "string" ? lrcRes.lrc.trim() : "";
  if (lrcUrl && /^https?:\/\//i.test(lrcUrl)) {
    try {
      const res = await httpGet(lrcUrl, {
        timeout: timeoutMs,
        responseType: "text",
      });
      if (res && isUsableLyricText(res.data)) {
        return {
          ...lrcRes,
          rawLrc: res.data,
        };
      }
    } catch (e) {}
  }
  return null;
}

function commitNormalizedMediaResult({
  normRes,
  matchCache,
  playbackSession,
  target,
  sourceObj,
  origSourceKey = "",
  isFallback = false,
  matchedItem = null,
  enableCache = true,
  defaultDisplayName = "",
  sourceNameOverride = "",
}) {
  const rawLabel =
    sourceNameOverride ||
    (sourceObj && (sourceObj.name || sourceObj.platform || sourceObj.key)) ||
    origSourceKey ||
    defaultDisplayName;
  const usedSource =
    playbackSession.formatSourceName(rawLabel) ||
    defaultDisplayName ||
    "备选源";

  if (enableCache && isFallback && matchedItem && sourceObj) {
    const sKey =
      sourceObj.key || sourceObj.platform || sourceObj.name || "unknown";
    matchCache.set(
      target.title,
      target.artist,
      sKey,
      matchedItem,
      usedSource,
      true
    );
  }

  if (sourceObj) {
    recordSourceSuccess(sourceObj);
  }

  playbackSession.recordActiveSession(
    target.title,
    target.artist,
    usedSource,
    isFallback
  );

  return {
    ...normRes,
    platform: "智能多源聚合",
    _sourceUsed: usedSource,
  };
}

/**
 * 统一校验音视频流、清洗重定向与 Content-Type，并在确认可播后再写入记忆与激活会话
 */
async function tryFinalizeMediaResult({
  rawMediaRes,
  normalizeMediaSource,
  isInvalid404Url,
  matchCache,
  playbackSession,
  target,
  sourceObj,
  origSourceKey = "",
  isFallback = false,
  matchedItem = null,
  enableCache = true,
  defaultDisplayName = "",
  sourceNameOverride = "",
}) {
  if (
    !rawMediaRes ||
    !rawMediaRes.url ||
    typeof rawMediaRes.url !== "string" ||
    !rawMediaRes.url.startsWith("http") ||
    isInvalid404Url(rawMediaRes.url)
  ) {
    return null;
  }

  const normRes = await normalizeMediaSource(rawMediaRes);
  if (
    !normRes ||
    !normRes.url ||
    typeof normRes.url !== "string" ||
    isInvalid404Url(normRes.url)
  ) {
    return null;
  }

  return commitNormalizedMediaResult({
    normRes,
    matchCache,
    playbackSession,
    target,
    sourceObj,
    origSourceKey,
    isFallback,
    matchedItem,
    enableCache,
    defaultDisplayName,
    sourceNameOverride,
  });
}

/**
 * 多个异步取词通道抢占优先返回第一个非空有效结果（任意一条通道先拿到歌词立即返回，不等待慢通道）
 */
function firstValidResult(promises = []) {
  const validPromises = promises.filter(Boolean);
  if (validPromises.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let remaining = validPromises.length;
    let done = false;

    for (const p of validPromises) {
      Promise.resolve(p)
        .then((val) => {
          if (!done && val && isUsableLyricText(val.rawLrc)) {
            done = true;
            resolve(val);
            return;
          }
          remaining -= 1;
          if (!done && remaining === 0) resolve(null);
        })
        .catch(() => {
          remaining -= 1;
          if (!done && remaining === 0) resolve(null);
        });
    }
  });
}

function findSourceByMeta(sources = [], builtInSources = {}, sourceKey = "", sourceUrl = "") {
  const keyLower = String(sourceKey || "").trim().toLowerCase();
  const url = String(sourceUrl || "").trim();

  if (url) {
    const byUrl = sources.find((s) => s && s._sourceUrl === url);
    if (byUrl) return byUrl;
  }
  if (!keyLower) return null;

  return (
    builtInSources[keyLower] ||
    sources.find(
      (s) =>
        s &&
        ((s.key && String(s.key).toLowerCase() === keyLower) ||
          (s.platform && String(s.platform).toLowerCase() === keyLower) ||
          (s.name && String(s.name).toLowerCase() === keyLower))
    ) ||
    null
  );
}

/**
 * 统一歌词多源极速调度核心：
 * - Step 0: 预加载或搜索歌词精准点击项
 * - Step 1/1.5/1.8: 原源 getLyric -> 曲目自带远程 .lrc (含咪咕 HTTP 20ms 回退) -> 已命中秒开记忆源直取 (0 搜索)
 * - Step 2: 并发公共高质量歌词三通道 (网易云+QQ+酷我) + Top 3 健康动态源并行竞速，彻底消除 50+ 源串行阻塞！
 */
async function resolveLyricCore({
  musicItem,
  env = {},
  builtInSources = {},
  dynamicSources = [],
  orderedSources = [],
  findBestMatch,
  cleanTitle,
  cleanArtist,
  searchWithTimeout,
  playbackSession,
  matchCache = null,
}) {
  const isNoticeEnabled = parseBooleanFlag(env.showSourceInLyric, true);
  const target = {
    title: musicItem.title || "",
    artist: musicItem.artist || "",
    duration: musicItem.duration || 0,
  };

  const idStr = String(musicItem.id || "");
  const isLyricSearch =
    !!musicItem._isLyricSearchItem || idStr.startsWith("lrc_");

  // 用户在弹窗主动检索/切换歌词时，严禁将歌词提供源（如 netease/qq）误当作播放音源
  const defaultSourceName = isLyricSearch
    ? ""
    : playbackSession.formatSourceName(
        musicItem._sourceName || musicItem._source || ""
      );

  const fetchRawLyric = async () => {
    const {
      resolveDirectLyricItem,
      searchNetEaseLyrics,
      directFetchNetEaseLyric,
      searchQQLyrics,
      directFetchQQLyric,
      searchKuwoLyrics,
      directFetchKuwoLyric,
    } = require("./lyric-searcher");

    // 0. 优先处理歌词搜索点击项或自带歌词文本
    const directLrc = await resolveDirectLyricItem(
      musicItem,
      builtInSources,
      dynamicSources
    );
    const readyDirect = await fetchRemoteLrcIfNeeded(directLrc, 1800);
    if (readyDirect) return readyDirect;

    // 1. 若有明确的原始音源（且非歌词搜索项），先尝试原源直取（单次 1800ms 超时熔断，绝不重复调）
    const origSourceKey = (musicItem._source || "").trim().toLowerCase();
    let triedOrigSource = null;
    if (!isLyricSearch && (origSourceKey || musicItem._sourceUrl)) {
      triedOrigSource = findSourceByMeta(
        orderedSources.length > 0 ? orderedSources : dynamicSources,
        builtInSources,
        origSourceKey,
        musicItem._sourceUrl
      );
      if (triedOrigSource && typeof triedOrigSource.getLyric === "function") {
        const origRes = await withTimeout(
          () => triedOrigSource.getLyric(musicItem),
          1800,
          null
        );
        const readyOrig = await fetchRemoteLrcIfNeeded(origRes, 1600);
        if (readyOrig) return readyOrig;
      }
    }

    // 1.5 若曲目自身已经携带准确的远程 .lrc 链接（如咪咕搜索条目），直接拉取原词
    if (!isLyricSearch && musicItem.lrc && typeof musicItem.lrc === "string") {
      const directItemRemote = await fetchRemoteLrcIfNeeded(
        {
          lrc: musicItem.lrc,
          translation: musicItem.translation || "",
        },
        1800
      );
      if (directItemRemote) return directItemRemote;
    }

    // 1.8 若本曲目已在秒开记忆表中绑定过真实可播源（如容灾换源到酷我/QQ），直接向该已匹配条目取词，免搜索 100ms 出词
    if (!isLyricSearch && matchCache) {
      await matchCache.ensureReady(30);
      const cachedMatch = matchCache.get(target.title, target.artist);
      if (cachedMatch && cachedMatch.sourceKey && cachedMatch.item) {
        const allPool = orderedSources.length > 0 ? orderedSources : dynamicSources;
        const cachedSource = findSourceByMeta(
          allPool,
          builtInSources,
          cachedMatch.sourceKey,
          cachedMatch.item._sourceUrl
        );
        if (
          cachedSource &&
          cachedSource !== triedOrigSource &&
          typeof cachedSource.getLyric === "function"
        ) {
          const cachedLrc = await withTimeout(
            () => cachedSource.getLyric(cachedMatch.item),
            1600,
            null
          );
          const readyCached = await fetchRemoteLrcIfNeeded(cachedLrc, 1400);
          if (readyCached) return readyCached;
        }
      }
    }

    // 2. 全网高速并发竞速取词：公共高质量三通道（网易/QQ/酷我）与 Top 3 健康动态源并行竞速，谁先成功用谁！
    const titleClean = cleanTitle(target.title);
    const artistClean = cleanArtist(target.artist);

    if (titleClean) {
      const q = artistClean ? `${titleClean} ${artistClean}` : titleClean;

      const neLane = async () => {
        try {
          const neSearch = await searchNetEaseLyrics(q, 1, 3);
          const first = neSearch?.data?.[0];
          if (!first?._rawId) return null;
          return await fetchRemoteLrcIfNeeded(
            await directFetchNetEaseLyric(first._rawId),
            1500
          );
        } catch (e) {
          return null;
        }
      };

      const qqLane = async () => {
        try {
          const qqSearch = await searchQQLyrics(q, 1, 3);
          const first = qqSearch?.data?.[0];
          const mid = first?.songmid || first?._rawId;
          if (!mid) return null;
          return await fetchRemoteLrcIfNeeded(
            await directFetchQQLyric(mid),
            1500
          );
        } catch (e) {
          return null;
        }
      };

      const kwLane = async () => {
        try {
          const kwSearch = await searchKuwoLyrics(q, 1, 3, builtInSources.kuwo);
          const first = kwSearch?.data?.[0];
          if (!first?._rawId) return null;
          return await fetchRemoteLrcIfNeeded(
            await directFetchKuwoLyric(first._rawId),
            1500
          );
        } catch (e) {
          return null;
        }
      };

      const healthyDynamicPool = orderSourcesForPlayback(
        orderedSources,
        target
      )
        .filter((s) => s !== triedOrigSource && typeof s.getLyric === "function")
        .slice(0, 3);

      const dynamicTasks = healthyDynamicPool.map(async (source) => {
        try {
          const r = await searchWithTimeout(source, q, 1, "music", 1000);
          const list = r && Array.isArray(r.data) ? r.data : [];
          if (list.length === 0) return null;
          const bestMatch = findBestMatch(target, list, 55);
          if (!bestMatch) return null;
          const lrcRes = await withTimeout(() => source.getLyric(bestMatch), 1200, null);
          return await fetchRemoteLrcIfNeeded(lrcRes, 1200);
        } catch (e) {
          return null;
        }
      });

      const winner = await firstValidResult([neLane(), qqLane(), kwLane(), ...dynamicTasks]);
      if (winner) return winner;
    }

    return { rawLrc: "" };
  };

  const [lrcRes, sourceInfo] = await Promise.all([
    fetchRawLyric(),
    isNoticeEnabled
      ? playbackSession.getOrWaitSource(
          target.title,
          target.artist,
          defaultSourceName,
          800,
          isLyricSearch,
          { waitOnlyIfResolving: !isLyricSearch }
        )
      : Promise.resolve(null),
  ]);

  return playbackSession.injectSourceTagToLrc(
    lrcRes,
    sourceInfo,
    isNoticeEnabled,
    target.title
  );
}

/**
 * 统一将网易云榜单列表归类为「网易云音乐官方榜单」与「网易云特色/全球榜」
 */
function groupNeteaseTopLists(rawList = [], idPrefix = "") {
  const official = [];
  const special = [];
  const officialNames = [
    "云音乐飙升榜",
    "云音乐新歌榜",
    "网易原创歌曲榜",
    "云音乐热歌榜",
  ];

  for (const item of rawList) {
    if (!item || !item.id) continue;
    const entry = {
      id: `${idPrefix}${item.id}`,
      sheetId: item.id,
      title: item.name,
      artwork: item.coverImgUrl,
      description: item.description || "",
      playCount: item.playCount,
      updateFrequency: item.updateFrequency,
      platform: "智能多源聚合",
      _source: "netease",
    };
    if (
      ["S", "N", "O", "H"].includes(item.ToplistType) ||
      officialNames.includes(item.name)
    ) {
      official.push(entry);
    } else {
      special.push(entry);
    }
  }

  const groups = [];
  if (official.length > 0) {
    groups.push({ title: "网易云音乐官方榜单", data: official });
  }
  if (special.length > 0) {
    groups.push({ title: "网易云特色/全球榜", data: special });
  }
  return groups;
}

module.exports = {
  fetchRemoteLrcIfNeeded,
  isUsableLyricText,
  firstValidResult,
  findSourceByMeta,
  tryFinalizeMediaResult,
  resolveLyricCore,
  groupNeteaseTopLists,
  withTimeout,
  searchWithStatusTimeout,
  orderSourcesForPlayback,
  raceSearchChunk,
  resolveCandidatesMedia,
  normalizeMediaSourceShared,
  recordSearchLatency,
  recordSourceSuccess,
  recordSourceSoftFailure,
  recordSourceFailure,
  getSourceHealthState,
};

  },
  "./core/fallback-pure": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const { httpGet, parseBooleanFlag } = require("../utils/http");
const { findBestMatch, cleanTitle, cleanArtist } = require("./matcher");
const { formatDuration, parseDurationSeconds } = require("../utils/format");
const {
  syncCustomPlugins,
  getActiveDynamicPlugins,
  dynamicRegistry,
  ensureDynamicPluginsReady,
} = require("./dynamic-loader");
const { matchCache } = require("./cache");
const { playbackSession } = require("./playback-session");
const {
  tryFinalizeMediaResult,
  resolveLyricCore,
  findSourceByMeta,
  groupNeteaseTopLists,
  orderSourcesForPlayback,
  raceSearchChunk,
  resolveCandidatesMedia,
  normalizeMediaSourceShared,
  recordSourceFailure,
  recordSourceSoftFailure,
} = require("./fallback-helpers");
const {
  safeGetMediaSourceWithFallback,
  getQualityFallbackLadder,
  isFatalNetworkError,
  isInvalid404Url: checkInvalid404Url,
} = require("./quality-fallback");

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
async function getOrderedSources(env = {}, options = {}) {
  const { skipSync = false, readyTimeoutMs = 8000 } = options || {};
  const sources = [];
  const blacklist = getBlacklistSet(env);

  // 1. 【前置就绪锁】：先确保本地持久化存储（localStorage + IndexedDB）全部恢复入内存！
  await ensureDynamicPluginsReady(readyTimeoutMs);

  // 2. 本地已就绪后，再视用户配置指纹是否变动决定是否需要网络同步
  const tier0Urls =
    env.tier0PluginUrls ||
    env["优先音源"] ||
    env.customPluginUrls ||
    env.pluginUrls ||
    env.urls ||
    env.tier0 ||
    "";
  const tier3Urls =
    env.tier3PluginUrls ||
    env["兜底音源"] ||
    env.tier3 ||
    env.fallbackUrls ||
    "";

  if (!skipSync && (tier0Urls || tier3Urls)) {
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

  // 3. 流行歌曲正常时长加分 (150s ~ 360s，安全支持解析 mm:ss 字符串与毫秒)
  const dur = parseDurationSeconds(item.duration);
  if (dur >= 150 && dur <= 360) {
    score += 15;
  } else if (dur > 0 && dur < 100) {
    score -= 30;
  }

  // 3.1 优质正规音源元数据加分 (拥有完整 songmid 与专辑名称)
  if (item.songmid && typeof item.songmid === "string" && item.songmid.trim().length > 5) {
    score += 10;
  }
  if (item.album && typeof item.album === "string" && item.album.trim().length > 0) {
    score += 5;
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
  // 0. 歌词类型搜索 (搜索歌词弹窗专用通道：0ms 瞬时直达，绝不阻塞网络同步)
  if (type === "lyric") {
    const { unifiedSearchLyric } = require("./lyric-searcher");
    const dynamicSources = getActiveDynamicPlugins("tier0").concat(getActiveDynamicPlugins("tier3"));
    return await unifiedSearchLyric(query, page, env, {}, dynamicSources);
  }

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
      const sourceUrl = searchTargets[idx]._sourceUrl || "";
      r.value.data.forEach((item) => {
        combined.push({
          ...item,
          duration: formatDuration(item.duration),
          _source: item._source || sourceKey,
          _sourceUrl: item._sourceUrl || sourceUrl,
          _sourceName: sourceName,
          platform: "智能多源聚合",
        });
      });
    }
  });

  // 去重并计分 (含同分智能优选策略)
  const map = new Map();
  for (const item of combined) {
    const key = `${cleanTitle(item.title)}___${cleanArtist(item.artist)}`;
    const curScore = scoreSearchResult(item, query);
    item._rankScore = curScore;

    if (!map.has(key)) {
      map.set(key, item);
    } else {
      const exist = map.get(key);
      const existScore = exist._rankScore || 0;
      if (curScore > existScore) {
        map.set(key, item);
      } else if (curScore === existScore) {
        // 同分优选策略：优先选择具备真实非空时长、完整 songmid 标识的优质原版音源
        const curDur = parseDurationSeconds(item.duration);
        const existDur = parseDurationSeconds(exist.duration);
        if (curDur > 0 && existDur === 0) {
          map.set(key, item);
        } else if (item.songmid && !exist.songmid) {
          map.set(key, item);
        }
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
  return checkInvalid404Url(url);
}

/**
 * 智能规范化音频媒体源：修复 .php 脚本后缀、追踪 302 真实 CDN 跳转与补全音频后缀
 */
async function normalizeMediaSource(mediaRes) {
  return normalizeMediaSourceShared(mediaRes, isInvalid404Url);
}

/**
 * 纯净版自动换源调度 (高敏竞速 + 健康熔断 + 记忆秒开)
 */
async function resolveMediaSourceWithFallback(
  musicItem,
  quality = "standard",
  env = {}
) {
  const allowDowngrade = parseBooleanFlag(env.autoQualityDowngrade, true);
  const enableCache = parseBooleanFlag(env.enableMatchCache, true);

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

  playbackSession.markResolving(target.title, target.artist);
  try {
    // Step 0: 检查换源记忆表 (10ms 秒开，桌面端先确保原生存储完成水合)
    if (enableCache) {
      await matchCache.ensureReady(50);
      const cachedMatch = matchCache.get(target.title, target.artist);
      const blacklist = getBlacklistSet(env);
      const isMatchBlacklisted =
        cachedMatch &&
        isSourceBlacklisted(cachedMatch.sourceKey, cachedMatch.sourceName, blacklist);

      if (cachedMatch && cachedMatch.sourceKey && !isMatchBlacklisted) {
        if (dynamicRegistry.size === 0) {
          await ensureDynamicPluginsReady(1000);
        }
        const cachedKeyLower = String(cachedMatch.sourceKey).toLowerCase();
        let cachedSource = null;
        for (const reg of dynamicRegistry.values()) {
          const p = reg && reg.plugin;
          if (
            p &&
            (p.key === cachedMatch.sourceKey ||
              p.platform === cachedMatch.sourceKey ||
              p.name === cachedMatch.sourceKey ||
              (p.key && p.key.toLowerCase() === cachedKeyLower) ||
              (p.platform && p.platform.toLowerCase() === cachedKeyLower) ||
              (p.name && p.name.toLowerCase() === cachedKeyLower))
          ) {
            cachedSource = p;
            break;
          }
        }

        if (
          cachedSource &&
          typeof cachedSource.getMediaSource === "function" &&
          !isSourceBlacklisted(
            cachedSource.key,
            cachedSource.platform || cachedSource.name,
            blacklist
          )
        ) {
          const fallbackRes = await safeGetMediaSourceWithFallback(
            cachedSource,
            cachedMatch.item,
            quality,
            allowDowngrade
          );

          const finalized =
            fallbackRes && fallbackRes.mediaRes
              ? await tryFinalizeMediaResult({
                  rawMediaRes: fallbackRes.mediaRes,
                  normalizeMediaSource,
                  isInvalid404Url,
                  matchCache,
                  playbackSession,
                  target,
                  sourceObj: cachedSource,
                  origSourceKey: cachedMatch.sourceKey,
                  isFallback: !!cachedMatch.isFallback,
                  enableCache: false,
                  defaultDisplayName:
                    cachedMatch.sourceName || cachedMatch.sourceKey,
                  sourceNameOverride: cachedMatch.sourceName,
                })
              : null;

          if (finalized) {
            return {
              ...finalized,
              _fromMemoryCache: true,
              _matchedSong: `${cachedMatch.item.title} - ${cachedMatch.item.artist}`,
            };
          }
          matchCache.invalidate(target.title, target.artist);
        }
      }
    }

    // -------------------------------------------------------------
    // Step 0.5: 原生源优先直连 (若曲目自带有效 _source 且已加载，优先尝试)
    // -------------------------------------------------------------
    const orderedSources = await getOrderedSources(env);
    if (orderedSources.length === 0) {
      throw new Error("当前纯净版未加载任何可用音源，请先在设置中填入音源插件链接");
    }

    const origSourceKey = (musicItem._source || "").toLowerCase();
    const songSoftFailedSources = new Set();
    let origSource = null;
    let primaryTriedAndFailed = false;

    if (origSourceKey || musicItem._sourceUrl) {
      origSource = findSourceByMeta(
        orderedSources,
        builtInSources,
        origSourceKey,
        musicItem._sourceUrl
      );

      if (origSource && typeof origSource.getMediaSource === "function") {
        let fallbackRes = null;
        let origFatal = false;
        try {
          fallbackRes = await safeGetMediaSourceWithFallback(
            origSource,
            musicItem,
            quality,
            allowDowngrade,
            2800,
            {
              onFatalError: () => {
                origFatal = true;
              },
            }
          );
        } catch (origErr) {
          if (isFatalNetworkError(origErr)) origFatal = true;
        }

        if (fallbackRes && fallbackRes.mediaRes) {
          const finalized = await tryFinalizeMediaResult({
            rawMediaRes: fallbackRes.mediaRes,
            normalizeMediaSource,
            isInvalid404Url,
            matchCache,
            playbackSession,
            target,
            sourceObj: origSource,
            origSourceKey,
            isFallback: false,
            enableCache: false,
          });
          if (finalized) return finalized;
        }

        if (origFatal) {
          recordSourceFailure(origSource, true);
        } else if (!songSoftFailedSources.has(origSource)) {
          songSoftFailedSources.add(origSource);
          recordSourceSoftFailure(origSource);
        }
        primaryTriedAndFailed = true;
      }
    }

    // -------------------------------------------------------------
    // Step 1: 过滤并重排可播音乐源 -> 分梯队早退竞速换源（命中即出链，不傻等死源超时）
    // -------------------------------------------------------------
    const queryStr = artistClean ? `${titleClean} ${artistClean}` : titleClean;
    const playableSources = orderSourcesForPlayback(orderedSources, target).filter(
      (s) => !(primaryTriedAndFailed && origSource && s === origSource)
    );

    const CHUNK_SIZE = 6;
    for (let i = 0; i < playableSources.length; i += CHUNK_SIZE) {
      const chunkSources = playableSources.slice(i, i + CHUNK_SIZE);
      const raceResult = await raceSearchChunk({
        chunkSources,
        queryStr,
        titleClean,
        artistClean,
        target,
        findBestMatch,
      });

      if (raceResult.matches.length > 0 || !raceResult.settledAll) {
        if (raceResult.matches.length > 0) {
          const hit = await resolveCandidatesMedia({
            raceResult,
            quality,
            allowDowngrade,
            normalizeMediaSource,
            isInvalid404Url,
            matchCache,
            playbackSession,
            target,
            enableCache,
            defaultDisplayName: "动态源",
            softFailedSourcesSet: songSoftFailedSources,
          });
          if (hit) return hit;
        }
      }
    }

    throw new Error(
      `已加载的动态音源均无法播放歌曲: ${target.title} - ${target.artist}`
    );
  } finally {
    playbackSession.unmarkResolving(target.title, target.artist);
  }
}

/**
 * 纯净版歌词自动补全（仅等待本地快速恢复与过滤黑名单，绝不阻塞在远程合集全量下载上）
 */
async function resolveLyricWithFallback(musicItem, env = {}) {
  const orderedSources = await getOrderedSources(env, {
    skipSync: true,
    readyTimeoutMs: 600,
  });
  return await resolveLyricCore({
    musicItem,
    env,
    builtInSources: {},
    dynamicSources: orderedSources,
    orderedSources,
    findBestMatch,
    cleanTitle,
    cleanArtist,
    searchWithTimeout,
    playbackSession,
    matchCache,
  });
}

/**
 * 纯净版聚合官方榜单与动态插件榜单 (多源容灾)
 */
async function resolveTopLists(env = {}) {
  const results = [];
  const tasks = [];

  // 仅等待本地磁盘/缓存恢复，不在此触发耗时的远程全量插件订阅下载
  await ensureDynamicPluginsReady(1000);

  /**
   * 包装单源榜单拉取任务，隔离同步异常、非 Promise 返回及网络超时
   */
  const safeTopListTask = (fn, transform, timeoutMs = 3000) => {
    try {
      const p = Promise.resolve(fn())
        .then((res) => (transform ? transform(res) : res))
        .catch(() => []);
      return Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);
    } catch (e) {
      return Promise.resolve([]);
    }
  };

  // 1. 优先聚合已在内存中注册的动态音源插件榜单
  const blacklist = getBlacklistSet(env);
  const dynamicSources = getActiveDynamicPlugins("tier0").concat(
    getActiveDynamicPlugins("tier3")
  );
  for (const source of dynamicSources) {
    if (
      source &&
      typeof source.getTopLists === "function" &&
      !isSourceBlacklisted(source.key, source.platform || source.name, blacklist)
    ) {
      tasks.push(
        safeTopListTask(
          () => source.getTopLists(),
          (res) =>
            Array.isArray(res)
              ? res.map((group) => ({
                  ...group,
                  title: `[动态源] ${group.title || source.platform || source.name || "自定义榜单"}`,
                  data: Array.isArray(group?.data)
                    ? group.data.map((t) => ({
                        ...t,
                        platform: "智能多源聚合",
                        _source:
                          t._source ||
                          source.key ||
                          source.platform ||
                          source.name ||
                          "",
                        _sourceUrl: t._sourceUrl || source._sourceUrl || "",
                      }))
                    : [],
                }))
              : [],
          3000
        )
      );
    }
  }

  // 2. 酷我音乐官方榜单 (即时返回，0ms 可用)
  const KUWO_BANGS = [
    { id: "16", title: "酷我热歌榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/16.jpg", description: "酷我音乐全网热播金曲" },
    { id: "17", title: "酷我新歌榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/17.jpg", description: "酷我音乐最新发行优质单曲" },
    { id: "93", title: "抖音热歌榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/93.jpg", description: "短视频爆款流行神曲" },
    { id: "62", title: "酷我飙升榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/62.jpg", description: "当前搜索与播放飙升热单" },
    { id: "158", title: "快手热歌榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/158.jpg", description: "快手平台热门背景音乐" },
    { id: "187", title: "国风热歌榜", artwork: "http://img4.kuwo.cn/star/albumcover/300/187.jpg", description: "全网国风古韵高人气热曲" },
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

  // 3. 网易云官方榜单
  tasks.push(
    safeTopListTask(
      () =>
        httpGet("https://music.163.com/api/toplist", {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://music.163.com/",
          },
          timeout: 3000,
        }),
      (res) => groupNeteaseTopLists(res.data?.list || [], "ne_"),
      3000
    )
  );

  // 4. QQ音乐官方榜单
  tasks.push(
    safeTopListTask(
      () =>
        httpGet("https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg", {
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
          timeout: 3000,
        }),
      (res) => {
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
      },
      3000
    )
  );

  const allSettled = await Promise.allSettled(tasks);
  for (const item of allSettled) {
    if (item.status === "fulfilled" && Array.isArray(item.value)) {
      for (const group of item.value) {
        if (group && Array.isArray(group.data) && group.data.length > 0) {
          results.push({
            ...group,
            data: group.data.map((t) => ({
              ...t,
              platform: "智能多源聚合",
            })),
          });
        }
      }
    }
  }

  return results;
}

/**
 * 获取榜单歌曲详情 (官方直通毫秒响应 + 动态插件容灾)
 */
async function resolveTopListDetail(topListItem, env = {}) {
  const rawId = String(topListItem.sheetId || topListItem.bangId || topListItem.topId || topListItem.id || "");

  // 1. 酷我榜单详情
  if (topListItem._source === "kuwo" || String(topListItem.id).startsWith("kw_")) {
    const cleanId = rawId.replace("kw_", "");
    try {
      const res = await httpGet("https://kbangserver.kuwo.cn/ksong.s", {
        params: {
          from: "pc",
          fmt: "json",
          type: "bang",
          data: "bang",
          id: cleanId,
          pn: 0,
          rn: 50,
        },
        timeout: 6000,
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

  // 2. QQ 榜单详情
  if (topListItem._source === "qq" || String(topListItem.id).startsWith("qq_")) {
    const cleanId = rawId.replace("qq_", "");
    try {
      const res = await httpGet("https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg", {
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
        timeout: 6000,
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

  // 3. 网易云榜单详情
  if (topListItem._source === "netease" || String(topListItem.id).startsWith("ne_")) {
    const cleanId = rawId.replace("ne_", "");
    try {
      const res = await httpGet(
        `https://music.163.com/api/v6/playlist/detail?id=${cleanId}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://music.163.com/",
          },
          timeout: 6000,
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
    } catch (e) {}
  }

  // 4. 动态插件榜单详情获取（优先精准匹配 _sourceUrl 唯一线路，再按 _source 匹配 key/platform/name）
  const orderedSources = await getOrderedSources(env);
  const targetUrl = topListItem._sourceUrl || "";
  const targetSourceKey = (topListItem._source || "").toLowerCase();

  const matchesByUrl = (s) => targetUrl && s._sourceUrl === targetUrl;
  const matchesByKey = (s) =>
    !!targetSourceKey &&
    ((s.key && s.key.toLowerCase() === targetSourceKey) ||
      (s.platform && s.platform.toLowerCase() === targetSourceKey) ||
      (s.name && s.name.toLowerCase() === targetSourceKey));

  const prioritizedSources = [
    ...orderedSources.filter((s) => matchesByUrl(s)),
    ...orderedSources.filter((s) => !matchesByUrl(s) && matchesByKey(s)),
    ...orderedSources.filter((s) => !matchesByUrl(s) && !matchesByKey(s)),
  ];

  for (const source of prioritizedSources) {
    if (typeof source.getTopListDetail === "function") {
      try {
        const res = await Promise.resolve(source.getTopListDetail(topListItem));
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

  return { ...topListItem, musicList: [] };
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
    const res = await httpGet(
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
      const apiRes = await httpGet(
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
      const searchRes = await httpGet("https://music.163.com/api/search/get/web", {
        params: { s: sheetItem.title, type: 1000, limit: 1 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactSheet = searchRes.data?.result?.playlists?.[0];
      if (exactSheet && exactSheet.id) {
        const detailRes = await httpGet(
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
      const apiRes = await httpGet(
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
      const searchRes = await httpGet("https://music.163.com/api/search/get/web", {
        params: { s: q, type: 10, limit: 1 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactAlbum = searchRes.data?.result?.albums?.[0];
      if (exactAlbum && exactAlbum.id) {
        const detailRes = await httpGet(
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
        const apiRes = await httpGet(
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
        const apiRes = await httpGet(
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
      const searchRes = await httpGet("https://music.163.com/api/search/get/web", {
        params: { s: artistItem.name, type: 100, limit: 5 },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 8000,
      });
      const exactArtist = (searchRes.data?.result?.artists || []).find(
        (a) => (a.name || "").trim().toLowerCase() === artistItem.name.trim().toLowerCase()
      ) || searchRes.data?.result?.artists?.[0];

      if (exactArtist && exactArtist.id) {
        if (type === "music") {
          const detailRes = await httpGet(
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
          const detailRes = await httpGet(
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

/**
 * 纯净版歌曲评论区多源调度与跨源容灾 (透传动态插件 + 公共热评兜底)
 */
async function resolveMusicCommentsWithFallback(musicItem, page = 1, env = {}) {
  const { resolveMusicCommentsWithFallback: resolveCommentsCore } = require("./comment-resolver");
  const activeSources = await getOrderedSources(env);
  return await resolveCommentsCore(musicItem, page, env, activeSources);
}

module.exports = {
  unifiedSearch,
  resolveMediaSourceWithFallback,
  resolveLyricWithFallback,
  resolveMusicCommentsWithFallback,
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
  playbackSession,
  getBlacklistSet,
};

  },
  "./index-pure": function(module, exports, require, env, getUserVariables, __musicfree_require) {
"use strict";

const config = require("./config-pure");
const {
  unifiedSearch,
  resolveMediaSourceWithFallback,
  resolveLyricWithFallback,
  resolveMusicCommentsWithFallback,
  resolveTopLists,
  resolveTopListDetail,
  resolveRecommendSheetTags,
  resolveRecommendSheetsByTag,
  resolveMusicSheetInfo,
  resolveAlbumInfo,
  resolveArtistWorks,
  getOrderedSources,
  builtInSources,
  playbackSession,
} = require("./core/fallback-pure");
const {
  registerOrUpdatePlugin,
  registerPluginBatch,
  updateAllRegisteredPlugins,
  deleteDynamicPlugin,
  clearAllDynamicPlugins,
  getSyncDiagnosticLogs,
} = require("./core/dynamic-loader");
const { matchCache } = require("./core/cache");
const {
  isPluginOrSubscriptionUrl,
  cleanPluginUrl,
  resolveMusicSheet,
} = require("./core/sheet-importer");
const storage = require("./core/storage");

/**
 * 跨平台全兼容安全读取 MusicFree 注入的用户变量 (支持 this.getUserVariables / env / 全局函数 / 异步 Promise)
 */
async function getUserEnv(ctx) {
  // 1. 优先检查 this 上下文 (MusicFree 桌面版核心机制: this.getUserVariables)
  try {
    if (ctx && typeof ctx.getUserVariables === "function") {
      const res = ctx.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  try {
    if (ctx && ctx.userVariables && typeof ctx.userVariables === "object" && !Array.isArray(ctx.userVariables)) {
      if (Object.keys(ctx.userVariables).length > 0) return ctx.userVariables;
    }
  } catch (e) {}

  // 2. 检查全局独立函数 getUserVariables() (部分沙箱环境直接挂载全局)
  try {
    if (typeof getUserVariables === "function") {
      const res = getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  // 3. 检查 window / globalThis 上的 getUserVariables
  try {
    if (typeof window !== "undefined" && window && typeof window.getUserVariables === "function") {
      const res = window.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  try {
    if (typeof globalThis !== "undefined" && globalThis && typeof globalThis.getUserVariables === "function") {
      const res = globalThis.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  // 4. 检查 env.getUserVariables (移动端与部分沙箱环境)
  try {
    if (typeof env !== "undefined" && env && typeof env.getUserVariables === "function") {
      const res = env.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  try {
    if (typeof globalThis !== "undefined" && globalThis.env && typeof globalThis.env.getUserVariables === "function") {
      const res = globalThis.env.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  try {
    if (typeof window !== "undefined" && window.env && typeof window.env.getUserVariables === "function") {
      const res = window.env.getUserVariables();
      const val = res && typeof res.then === "function" ? (await res) || {} : res || {};
      if (val && typeof val === "object" && Object.keys(val).length > 0) return val;
    }
  } catch (e) {}

  // 5. 检查直接注入的全局 userVariables 对象
  if (typeof userVariables !== "undefined" && userVariables && typeof userVariables === "object" && !Array.isArray(userVariables)) {
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
    const userEnv = await getUserEnv(this);
    return await unifiedSearch(query, page, type, userEnv);
  },

  /**
   * 动态多源容灾与自动换源播放
   */
  async getMediaSource(musicItem, quality = "standard") {
    const title = (musicItem && musicItem.title) || "";
    const artist = (musicItem && musicItem.artist) || "";
    playbackSession.markResolving(title, artist);
    try {
      const userEnv = await getUserEnv(this);
      return await resolveMediaSourceWithFallback(musicItem, quality, userEnv);
    } finally {
      playbackSession.unmarkResolving(title, artist);
    }
  },

  /**
   * 歌词动态跨源自动补全
   */
  async getLyric(musicItem) {
    const userEnv = await getUserEnv(this);
    return await resolveLyricWithFallback(musicItem, userEnv);
  },

  /**
   * 纯净版歌曲评论区 (支持透传动态插件、跨源热评容灾与分页)
   */
  async getMusicComments(musicItem, page = 1) {
    const userEnv = await getUserEnv(this);
    return await resolveMusicCommentsWithFallback(musicItem, page, userEnv);
  },

  /**
   * 获取官方榜单 (使插件出现在客户端【排行榜】分类中)
   */
  async getTopLists() {
    const userEnv = await getUserEnv(this);
    return await resolveTopLists(userEnv);
  },

  /**
   * 获取榜单详情
   */
  async getTopListDetail(topListItem) {
    const userEnv = await getUserEnv(this);
    return await resolveTopListDetail(topListItem, userEnv);
  },

  /**
   * 获取热门/推荐歌单标签 (使插件出现在客户端【热门歌单】分类中)
   */
  async getRecommendSheetTags() {
    const userEnv = await getUserEnv(this);
    return await resolveRecommendSheetTags(userEnv);
  },

  /**
   * 按标签获取热门/推荐歌单列表
   */
  async getRecommendSheetsByTag(tag, page = 1) {
    const userEnv = await getUserEnv(this);
    return await resolveRecommendSheetsByTag(tag, page, userEnv);
  },

  /**
   * 获取歌单内歌曲列表详情
   */
  async getMusicSheetInfo(sheetItem, page = 1) {
    const userEnv = await getUserEnv(this);
    return await resolveMusicSheetInfo(sheetItem, page, userEnv);
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
    const userEnv = await getUserEnv(this);

    // 指令 1: 查看音源状态看板 ("status" / "源" / "看板" / "音源")
    if (
      text === "status" ||
      text === "源" ||
      text === "看板" ||
      text === "音源" ||
      text === "list"
    ) {
      const activeSources = await getOrderedSources(userEnv);
      const items = [];
      const diag = getSyncDiagnosticLogs();

      // 顶部汇总状态条目
      items.push({
        id: "source_summary_status",
        title: `[存储看板] 本地活跃: ${activeSources.length} 个音源 · 多轨存储: 原生磁盘 + IndexedDB + localStorage`,
        artist: diag.lastSyncTime > 0
          ? `最近网络同步: ${diag.lastSyncStatus === "success" ? "成功" : diag.lastSyncStatus === "partial" ? `部分成功 (${diag.successCount}/${diag.totalSubPlugins})` : "异常"} | 失败源: ${diag.failedPlugins.length} 个`
          : `本地持久化状态: 正常 · 纯本地秒开`,
        album: `💡 提示: 输入 'update' 检查更新，输入 'del 音源名' 删除`,
        artwork: config.defaultArtwork,
        duration: 0,
        platform: config.platform,
      });

      const quotaInfo = storage.getQuotaStatus ? storage.getQuotaStatus() : null;
      if (quotaInfo && quotaInfo.exceeded) {
        items.push({
          id: "storage_quota_warning",
          title: "⚠️ [宿主存储配额已满] 历史插件缓存占满 MusicFree 10MB 上限",
          artist: "建议关闭客户端后清理或删除旧版本残留 chunk.json 以恢复跨重启秒开记忆",
          album: "存储路径: %APPDATA%/MusicFree/musicfree-plugin-storage/chunk.json",
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        });
      }

      const inheritInfo = storage.getInheritInfo ? storage.getInheritInfo() : null;
      if (inheritInfo && inheritInfo.inherited) {
        items.push({
          id: "source_inherit_status",
          title: `💡 [无感继承自愈] 已自动从上一个版本恢复 ${inheritInfo.count} 个音源`,
          artist: `历史版本 Hash: ${inheritInfo.fromHash.slice(0, 12)}... · 零损失平滑过渡`,
          album: `状态: AUTO_INHERITED`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        });
      }

      if (activeSources.length === 0) {
        items.push({
          id: "no_active_source",
          title: "当前纯净版未加载任何音源",
          artist: "提示: 请在用户变量【优先音源】中添加 .js 插件或 .json 合集链接",
          album: "状态: 空闲",
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        });
        return items;
      }

      activeSources.forEach((s, idx) => {
        const name = s.name || s.platform || "未知音源";
        const ver = s.version || "1.0.0";
        const tier = s._tier || (idx < 5 ? "Tier 0 动态优先" : "Tier 3 动态兜底");
        items.push({
          id: `source_status_${idx}`,
          title: `[${tier}] ${name} (v${ver})`,
          artist: `本地持久化: 正常 · 状态: 在线活跃 · 输入 'del ${name}' 可删除`,
          album: `优先级位次: 第 ${idx + 1} 位`,
          artwork: config.defaultArtwork,
          duration: 0,
          platform: config.platform,
        });
      });

      return items;
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
      const delRes = await deleteDynamicPlugin(query);
      return [
        {
          id: "delete_feedback_item",
          title: delRes.message,
          artist: delRes.success
            ? `已从本地持久化存储与当前运行内存中永久移除`
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
      await matchCache.ensureReady(100);
      const stats = matchCache.getStats();
      const storageLabel =
        typeof localStorage === "undefined"
          ? `musicfree/storage[${stats.storageKey}]`
          : `localStorage[${stats.storageKey}]`;
      return [
        {
          id: "cache_stats_item",
          title: `[换源秒开记忆看板] 已本地记忆 ${stats.count} 首曲目直达`,
          artist: `本地持久化占用: ${stats.sizeKb} KB · 存储位置: ${storageLabel}`,
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
      await matchCache.ensureReady(100);
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
      const clearRes = await clearAllDynamicPlugins();
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

    // 功能 3: 插件代码或合集订阅链接安装 (仅限以 .js/.json 结尾或带 add/install 前缀，不劫持普通音乐歌单)
    if (isPluginOrSubscriptionUrl(text)) {
      const targetUrl = cleanPluginUrl(text);
      const regRes = await registerOrUpdatePlugin(targetUrl, "tier0", builtInSources);
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
          const { addedCount } = await registerPluginBatch(list, "tier0", builtInSources);
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

    // 功能 5: 通用跨平台音乐歌单直解 (网易云、QQ音乐、酷我、酷狗、B站或已加载子插件)
    const activeSources = await getOrderedSources(userEnv);
    const sheetSongs = await resolveMusicSheet(text, activeSources, config.platform);
    if (Array.isArray(sheetSongs) && sheetSongs.length > 0) {
      return sheetSongs;
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
      if (norm === "./config" && !modules[norm] && modules["./config-pure"]) {
        return "./config-pure";
      }
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
      if (typeof __musicfree_require === "function") {
        try {
          return __musicfree_require(moduleId);
        } catch (e) {}
      }
      return {};
    }

    var module = { exports: {} };
    cache[resolvedKey] = module;

    function scopedRequire(nextModuleId) {
      return customRequire(resolvedKey, nextModuleId);
    }

    modFn(module, module.exports, scopedRequire, env, getUserVariables, __musicfree_require);
    return module.exports;
  }

  var entry = customRequire(".", "./index-pure");
  module.exports = entry.default || entry;
})(typeof env !== "undefined" ? env : undefined, typeof getUserVariables !== "undefined" ? getUserVariables : undefined, typeof __musicfree_require !== "undefined" ? __musicfree_require : (typeof require !== "undefined" ? require : undefined));
