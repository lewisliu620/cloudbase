'use strict';
/**
 * pl-listing-template — Shopee CNSC 批量上传模板生成（知识库官方批量通道）
 *
 * 知识库（卖家学习中心版）要点：
 *   · 路径：CNSC 卖家中心 → 全球商品 → 批量工具 → 批量上传（Excel 模板，6 子表）
 *   · 规格 ≤2 层；规格选项须填图片链接，且图片须来自稳定、无登录校验的服务源（如 COS/CloudBase 存储直链）
 *   · 上传后商品状态为「未发布」，需再发布才可见
 *
 * 本函数输入商品档案 + 素材清单（pl-listing-assets 的 record），输出批量上传模板行数据，
 * 供本地或云端转 Excel（官方模板字段映射见 notes）。价格沿用用户已拍板的利润率逻辑输出值，
 * 不在本函数重算（价格由调用方/选品流水线传入 price）。
 *
 * 输入 event：
 *   {
 *     offer_id, title, description, category_id, brand,
 *     weight_kg, dims_cm:{w,l,h}, ship_days,
 *     images:[url...], video_url,
 *     spec1_name, spec2_name,          // 维度名（≤2 层；单维度时 spec2_name 缺省）
 *     variations: [{spec1, spec2?, price, qty, sku_code}],
 *     asset_base_url                   // 素材稳定直链前缀（来自 CloudBase，无登录校验）
 *   }
 * 输出：批量模板行 + 校验 notes
 */
'use strict';

exports.main = async (event = {}) => {
  const variations = Array.isArray(event.variations) ? event.variations : [];
  const spec1 = String(event.spec1_name || '规格').trim();
  const spec2 = String(event.spec2_name || '').trim();
  const dims = event.dims_cm || {};
  const base = String(event.asset_base_url || '').replace(/\/+$/, '');

  const rows = variations.map((v, i) => ({
    row: i + 1,
    sku: String(v.sku_code || `SKU${i + 1}`),
    [spec1]: String(v.spec1 || ''),
    ...(spec2 ? { [spec2]: String(v.spec2 || '') } : {}),
    price: v.price,
    qty: v.qty || 500,
    image_url: v.image_url || (base ? `${base}/${v.sku_code || i}.jpg` : ''),
  }));

  const notes = [];
  if (spec2 && !rows.some((r) => r[spec2])) notes.push('规格2 无值，请删除第二维度（官方变体 ≤2 类）');
  if (!rows.length) notes.push('无变体行，模板为空');
  if (!base) notes.push('未提供素材稳定直链前缀，图片链接需在转 Excel 前补齐（官方要求无登录校验源）');

  return {
    ok: true,
    offer_id: event.offer_id || '',
    template_version: 'cnsc-batch-v1',
    global: {
      product_name: event.title || '',
      category_id: event.category_id || null,
      brand: event.brand || 'No Brand',
      description: event.description || '',
      weight_kg: event.weight_kg || null,
      dims_cm: { w: dims.w || '', l: dims.l || '', h: dims.h || '' },
      ship_days: event.ship_days || 1,
    },
    spec: { spec1_name: spec1, spec2_name: spec2 || null, dimension_count: spec2 ? 2 : 1 },
    images: Array.isArray(event.images) ? event.images : [],
    video_url: event.video_url || '',
    variations: rows,
    notes,
    time: new Date().toISOString(),
  };
};
