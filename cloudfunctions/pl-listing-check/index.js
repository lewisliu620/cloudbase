'use strict';
/**
 * pl-listing-check — Shopee 上架合规预检（知识库《Shopee 官方上架指南速查》规则固化）
 *
 * 知识库来源：https://feishu.doubao.com/docx/RCwUd8vnVoGdmdx16xAcg0I4ntf （卖家学习中心版，2026-10-18 快照）
 * 本函数只做本地逻辑校验，无浏览器依赖 → 可完全云化，供 AI 选品 → 建草稿/批量上传前门禁。
 *
 * 输入 event（与 listing.json 对齐）：
 *   {
 *     offer_id: "997460258722",
 *     title: "泰文或英文标题",
 *     description: "商品描述",
 *     category_id: 101203,        // Shopee 叶子类目 ID
 *     brand: "No Brand",
 *     images: ["url1","url2",...],
 *     video: {url, duration_s, size_mb} | null,
 *     weight_kg: 0.5, dims_cm: {w,h,l},
 *     skus: [{name, price, qty, sku_code, image_url?}, ...],
 *     dimension_count: 1,         // 变体维度数（规格层数），官方硬性 ≤2
 *     allow_listing_extra: []     // 附加检查项名
 *   }
 * 输出：
 *   { ok, pass, category_ok, checks: [{rule, level:"error|warn", pass, msg}], summary }
 */
'use strict';

// ===== 知识库规则常量（卖家学习中心版，2024-01-08 泰国站强制） =====
// 命名：新商品名称 ≥30 字符；首字母大写；禁促销词；不堆砌重复词
const TITLE_MIN_CHARS = 30;
// 促销/营销禁用词（知识库：名称中不得包含促销相关字眼）
const PROMO_WORDS = [
  '热卖', '爆款', '降价', '特价', '秒杀', '清仓', '促销', '包邮', '免运费',
  '优惠', '限时', '抢购', '第一', '最好', '销量第一',
  'hot sale', 'best seller', 'discount', 'sale', 'free shipping', 'promotion',
  'cheap', 'low price', 'clearance', 'flash sale', 'limited time', 'no.1', 'best',
];
// 站外引流红线（知识库：站外引流立即暂停账号）——出现在任何字段都硬性违规
const OFF_PLATFORM = [
  'line', 'facebook', 'fb.com', 'instagram', 'whatsapp', 'telegram', 'tiktok',
  'youtube', 'wechat', '微信', '网站', 'www.', 'http://', 'https://',
  '电话', '手机号', '联系', 'tel:', '二维码', 'qr code', 'shopee 外', '其他平台',
];
// spam 红线（知识库：spam 行为暂停甚至不可申诉）
const SPAM_MARKERS = [
  '批发', '一件代发', '厂家直销', '工厂', '1688', '阿里巴巴', '淘宝', '天猫',
  '拼多多', '京东', '批发价', '量大从优', '代理', '加盟', 'OEM', 'ODM',
];
// 描述要求：≥20 个不重复词；仅泰/英；无促销引流
const DESC_MIN_UNIQUE_WORDS = 20;
const DESC_MAX_CHARS = 5000;
// 图片：官方 ≤9 张（主图 + 附图）
const IMG_MAX = 9;
// 变体：官方硬性 ≤2 类维度
const DIM_MAX = 2;
// 商品数量（库存）下限
const QTY_MIN = 1;

function lower(s) { return String(s || '').toLowerCase(); }

function hitAny(text, words) {
  const t = lower(text);
  return words.filter((w) => t.includes(lower(w)));
}

function uniqueWordCount(text) {
  const t = String(text || '');
  // 英文/数字词按空格与边界分词
  const en = (t.match(/[a-z0-9]+/gi) || []).map((x) => x.toLowerCase());
  const set = new Set(en);
  // 泰文按空白分隔的连续泰文段逐个计词（泰文 Listing 标准写法用空格分词）
  const thSegs = (t.match(/[\u0E00-\u0E7F]+/g) || []).filter((s) => s.trim());
  thSegs.forEach((seg) => set.add('th:' + seg.trim()));
  return set.size;
}

function checkTitle(title) {
  const t = String(title || '');
  const out = [];
  // 必填
  if (!t.trim()) out.push({ rule: '名称必填', level: 'error', pass: false, msg: '标题为空' });
  else {
    // ≥30 字符（新商品硬性）
    if (t.length < TITLE_MIN_CHARS) {
      out.push({ rule: '名称长度', level: 'error', pass: false, msg: `标题 ${t.length}/30 字符，新商品硬性要求≥30` });
    }
    // 首字母大写（英文标题）
    const enLead = t.match(/[a-z]/i);
    if (enLead && enLead.index === 0 && /[a-z]/.test(t[0])) {
      out.push({ rule: '首字母大写', level: 'error', pass: false, msg: '英文标题首字母需大写' });
    }
    // 促销词
    const promo = hitAny(t, PROMO_WORDS);
    if (promo.length) out.push({ rule: '禁促销词', level: 'error', pass: false, msg: `含促销词: ${promo.join('、')}` });
    // 站外引流（红线）
    const off = hitAny(t, OFF_PLATFORM);
    if (off.length) out.push({ rule: '禁站外引流', level: 'error', pass: false, msg: `标题含引流词: ${off.join('、')}（红线）` });
    // spam 词
    const spam = hitAny(t, SPAM_MARKERS);
    if (spam.length) out.push({ rule: '禁spam词', level: 'error', pass: false, msg: `标题含spam词: ${spam.join('、')}` });
    // 重复词堆砌
    const enWords = (lower(t).match(/[a-z0-9]+/g) || []);
    const dup = enWords.filter((w, i) => enWords.indexOf(w) !== i);
    if (dup.length > 2) out.push({ rule: '勿堆砌重复词', level: 'warn', pass: false, msg: `重复词过多: ${[...new Set(dup)].slice(0, 5).join('、')}` });
  }
  return out;
}

function checkDescription(desc) {
  const d = String(desc || '');
  const out = [];
  if (!d.trim()) {
    out.push({ rule: '描述必填', level: 'error', pass: false, msg: '描述为空' });
    return out;
  }
  if (d.length > DESC_MAX_CHARS) out.push({ rule: '描述长度', level: 'error', pass: false, msg: `描述 ${d.length}/${DESC_MAX_CHARS} 超限` });
  const uq = uniqueWordCount(d);
  if (uq < DESC_MIN_UNIQUE_WORDS) out.push({ rule: '描述不重复词', level: 'error', pass: false, msg: `仅 ${uq}/20 个不重复词` });
  const off = hitAny(d, OFF_PLATFORM);
  if (off.length) out.push({ rule: '禁站外引流', level: 'error', pass: false, msg: `描述含引流词: ${off.join('、')}（红线）` });
  const promo = hitAny(d, PROMO_WORDS);
  if (promo.length) out.push({ rule: '禁促销词', level: 'warn', pass: false, msg: `描述含促销词: ${promo.join('、')}` });
  return out;
}

function checkImages(images) {
  const out = [];
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (!list.length) out.push({ rule: '图片必填', level: 'error', pass: false, msg: '无主图' });
  if (list.length > IMG_MAX) out.push({ rule: '图片数量', level: 'error', pass: false, msg: `${list.length}/${IMG_MAX} 超限` });
  return out;
}

function checkVideo(video) {
  const out = [];
  if (!video) return out;
  if (video.duration_s > 60) out.push({ rule: '视频时长', level: 'error', pass: false, msg: `${video.duration_s}s > 60s 超限` });
  if (video.size_mb > 200) out.push({ rule: '视频大小', level: 'error', pass: false, msg: `${video.size_mb}MB > 200MB 超限` });
  return out;
}

function checkVariants(skus, dimensionCount) {
  const out = [];
  const list = Array.isArray(skus) ? skus : [];
  if (!list.length) {
    out.push({ rule: '变体必填', level: 'error', pass: false, msg: '无 SKU 变体' });
    return out;
  }
  // 官方硬性：变体最多 2 类维度
  const dims = Number(dimensionCount) || 1;
  if (dims > DIM_MAX) out.push({ rule: '变体维度', level: 'error', pass: false, msg: `${dims} 类维度 > 官方上限 2（须合并为单维度）` });
  // 每个变体值：名称/价格/库存/货号必填
  const missing = [];
  list.forEach((s, i) => {
    const problems = [];
    if (!String(s.name || '').trim()) problems.push('名称');
    if (s.price === undefined || s.price === null || s.price === '') problems.push('价格');
    if (!(s.qty > 0)) problems.push('库存');
    if (!String(s.sku_code || '').trim()) problems.push('货号');
    if (problems.length) missing.push(`SKU#${i + 1}(${problems.join('/')})`);
  });
  if (missing.length) out.push({ rule: '变体完整', level: 'error', pass: false, msg: `缺字段: ${missing.join('，')}` });
  return out;
}

function checkLogistics(weightKg, dimsCm, shipDays) {
  const out = [];
  if (!(weightKg > 0)) out.push({ rule: '重量必填', level: 'error', pass: false, msg: '重量未填（须含包装）' });
  if (!dimsCm || !(dimsCm.w > 0) || !(dimsCm.l > 0) || !(dimsCm.h > 0)) {
    out.push({ rule: '尺寸必填', level: 'error', pass: false, msg: '包裹尺寸未填（宽长高cm）' });
  }
  if (!(shipDays >= 1)) out.push({ rule: '发货时间', level: 'error', pass: false, msg: '发货时间未填（1 或 4-10）' });
  return out;
}

exports.main = async (event = {}) => {
  const checks = [];
  checks.push(...checkTitle(event.title));
  checks.push(...checkDescription(event.description));
  checks.push(...checkImages(event.images));
  checks.push(...checkVideo(event.video));
  checks.push(...checkVariants(event.skus, event.dimension_count));
  checks.push(...checkLogistics(event.weight_kg, event.dims_cm, event.ship_days));

  const errors = checks.filter((c) => c.level === 'error' && !c.pass);
  const warns = checks.filter((c) => c.level === 'warn' && !c.pass);
  const pass = errors.length === 0;

  return {
    ok: true,
    pass,
    category_ok: !!event.category_id,
    offer_id: event.offer_id || '',
    category_id: event.category_id || null,
    summary: {
      total: checks.length,
      errors: errors.length,
      warns: warns.length,
      verdict: pass ? (warns.length ? 'PASS_WITH_WARN' : 'PASS') : 'FAIL',
    },
    checks,
    time: new Date().toISOString(),
  };
};