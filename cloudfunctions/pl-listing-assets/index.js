'use strict';
/**
 * pl-listing-assets — 上架素材生命周期管理（图片/视频转存 CloudBase，14 天自动删除）
 *
 * 数据流：
 *   1. register-from-url（上架前，推荐）：输入 offer_id + files[{name, sourceUrl, type}]，
 *     云函数下载 sourceUrl → app.uploadFile 到 listing-assets/<offer_id>/ → 登记 pl_listing_assets
 *     （expire_at = now + 14 天）→ 返回 CDN 直链。一次调用完成「下载+上传+登记」。
 *   2. register（兼容）：登记已存在于存储的 cloudPath（外部已上传场景）。
 *   3. cleanup（timer 每天 03:00 触发）：扫 expire_at < now 且 status=active 的记录，
 *     → app.deleteFile 删除存储对象 → 记录 status=deleted、deleted_at。
 *   4. list（查询）：按 offer_id 返回素材清单与过期时间。
 *
 * 幂等：同一 offer_id 重复 register 会先清旧记录再写新（素材换代场景）。
 */
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

const COLL = 'pl_listing_assets';
const ASSET_TTL_DAYS = 14;            // 用户红线：2 周
const PREFIX = 'listing-assets/';      // 存储前缀
const CDN_DOMAIN = process.env.CDN_DOMAIN || '';

function nowISO() { return new Date().toISOString(); }

function cdnUrl(cloudPath) {
  return CDN_DOMAIN ? `https://${CDN_DOMAIN}/${cloudPath}` : cloudPath;
}

async function downloadBuffer(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`empty body: ${url}`);
  return buf;
}

async function uploadFromUrl(offerId, file) {
  const name = file.name || 'asset';
  const cloudPath = file.cloudPath || `${PREFIX}${offerId}/${name}`;
  const buf = await downloadBuffer(file.sourceUrl);
  await app.uploadFile({ cloudPath, fileContent: buf });
  return { name, cloudPath, type: file.type || 'image', size: buf.length, cdn_url: cdnUrl(cloudPath) };
}

async function registerFromUrl(offerId, files) {
  const now = new Date();
  const expireAt = new Date(now.getTime() + ASSET_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  await db.collection(COLL).where({ offer_id: String(offerId), status: _.neq('deleted') })
    .update({ status: 'superseded', superseded_at: nowISO() });
  const uploaded = [];
  for (const f of files || []) {
    if (!f.sourceUrl) throw new Error(`file ${f.name || ''} missing sourceUrl`);
    uploaded.push(await uploadFromUrl(offerId, f));
  }
  const doc = {
    offer_id: String(offerId),
    files: uploaded.map((u) => ({ name: u.name, cloudPath: u.cloudPath, type: u.type, size: u.size, cdn_url: u.cdn_url })),
    created_at: nowISO(),
    expire_at: expireAt,
    ttl_days: ASSET_TTL_DAYS,
    status: 'active',
  };
  const r = await db.collection(COLL).add(doc);
  return { ok: true, record_id: (r.id_list || [])[0] || '', doc, expire_at: expireAt };
}

async function register(offerId, files) {
  const now = new Date();
  const expireAt = new Date(now.getTime() + ASSET_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const cloudPaths = (files || []).map((f) => ({
    name: f.name || '',
    cloudPath: f.cloudPath || `${PREFIX}${offerId}/${f.name || 'asset'}`,
    type: f.type || 'image',
    size: f.size || 0,
  }));
  await db.collection(COLL).where({ offer_id: String(offerId), status: _.neq('deleted') })
    .update({ status: 'superseded', superseded_at: nowISO() });
  const doc = {
    offer_id: String(offerId),
    files: cloudPaths.map((f) => ({ ...f, cdn_url: cdnUrl(f.cloudPath) })),
    created_at: nowISO(),
    expire_at: expireAt,
    ttl_days: ASSET_TTL_DAYS,
    status: 'active',
  };
  const r = await db.collection(COLL).add(doc);
  return { ok: true, record_id: (r.id_list || [])[0] || '', doc, expire_at: expireAt };
}

async function cleanup() {
  const now = nowISO();
  const expired = await db.collection(COLL)
    .where({ status: 'active', expire_at: _.lt(now) })
    .limit(100)
    .get();
  const rows = expired.data || [];
  if (!rows.length) return { ok: true, scanned: 0, deleted: 0, msg: '无过期素材' };
  const fileList = [];
  rows.forEach((row) => { (row.files || []).forEach((f) => { if (f.cloudPath) fileList.push(f.cloudPath); }); });
  const delRes = fileList.length ? await app.deleteFile({ fileList }) : { fileList: [] };
  const ids = rows.map((r) => r._id);
  await db.collection(COLL).where({ _id: _.in(ids) })
    .update({ status: 'deleted', deleted_at: now });
  return {
    ok: true,
    scanned: rows.length,
    objects_deleted: (delRes.fileList || []).filter((f) => f.code === 0 || f.status === 0 || f.ok).length,
    records_deleted: ids.length,
    offer_ids: rows.map((r) => r.offer_id),
  };
}

async function listOffer(offerId) {
  const res = await db.collection(COLL)
    .where({ offer_id: String(offerId), status: 'active' })
    .limit(10)
    .get();
  return { ok: true, offer_id: String(offerId), records: res.data || [] };
}

exports.main = async (event = {}) => {
  const action = event.action || 'cleanup';
  try {
    switch (action) {
      case 'register-from-url':
        return await registerFromUrl(event.offer_id, event.files || []);
      case 'register':
        return await register(event.offer_id, event.files || []);
      case 'cleanup':
        return await cleanup();
      case 'list':
        return await listOffer(event.offer_id);
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  } catch (e) {
    return { ok: false, action, error: String((e && e.message) || e), time: nowISO() };
  }
};
