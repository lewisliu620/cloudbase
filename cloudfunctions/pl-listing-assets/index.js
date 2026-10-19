'use strict';
/**
 * pl-listing-assets — 上架素材生命周期管理（图片/视频转存 CloudBase，14 天自动删除）
 *
 * 用户要求（2026-10-19）：上架后的商品图片和视频在 CloudBase 存 2 周后自动删除。
 *
 * 数据流：
 *   1. register（上架前）：把商品图片/视频登记到 pl_listing_assets，expire_at = now + 14 天；
 *     素材统一存 storage 前缀 listing-assets/<offer_id>/（配合 COS 生命周期规则双保险）。
 *   2. cleanup（timer 每天 03:00 触发）：扫 expire_at < now 且 status=active 的记录，
 *     → app.deleteFile 删除存储对象 → 记录 status=deleted、deleted_at。
 *   3. list（查询）：按 offer_id 返回素材清单与过期时间。
 *
 * 幂等：同一 offer_id 重复 register 会先清旧记录再写新（素材换代场景）。
 * 删除前不二次确认：过期素材按用户红线直接清理，但保留集合记录（status=deleted）供审计。
 */
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

const COLL = 'pl_listing_assets';
const ASSET_TTL_DAYS = 14;          // 用户红线：2 周
const PREFIX = 'listing-assets/';    // 存储前缀（COS 生命周期规则按此前缀配置 14 天过期）

function nowISO() { return new Date().toISOString(); }

async function register(offerId, files) {
  const now = new Date();
  const expireAt = new Date(now.getTime() + ASSET_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const cloudPaths = (files || []).map((f) => ({
    name: f.name || '',
    cloudPath: f.cloudPath || `${PREFIX}${offerId}/${f.name || 'asset'}`,
    type: f.type || 'image',
    size: f.size || 0,
  }));
  // 幂等：先软删旧记录
  await db.collection(COLL).where({ offer_id: String(offerId), status: _.neq('deleted') })
    .update({ status: 'superseded', superseded_at: nowISO() });
  const doc = {
    offer_id: String(offerId),
    files: cloudPaths,
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
  rows.forEach((row) => {
    (row.files || []).forEach((f) => {
      if (f.cloudPath) fileList.push(f.cloudPath);
    });
  });

  const delRes = fileList.length
    ? await app.deleteFile({ fileList })
    : { fileList: [] };

  // 标记记录
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
