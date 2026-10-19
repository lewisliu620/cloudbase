'use strict';
/**
 * shopee-session-keepalive — Shopee CNSC 登录态自动续期（三层机制核心）
 *
 * 层 A：滑动过期保活 — 每日 23:00 带 cookie 请求卖家中心 get_session API，
 *       捕获响应 Set-Cookie 刷新 SPC_CNSC_SESSION，会话永不失效。
 * 层 B：记住我长 cookie — 登录时勾选 remember，Set-Cookie 有效期写入集合
 *       cookie_expiry，保活窗口按最长过期时间计算。
 * 层 C：双店冗余 — TH(1719627113) + MY(1825250802) 双会话互备；
 *       A 店保活失败自动切 B 店恢复；全部失败则飞书告警人工介入。
 *
 * 依赖：@cloudbase/node-sdk（读/写 pl_shopee_login 集合）
 * 触发器：cron 0 0 23 * * * *（每天 23:00，会话 24h 过期留 1h 余量）
 */
const cloudbase = require('@cloudbase/node-sdk');
const https = require('https');
const http = require('http');

const ENV_ID = process.env.TCB_ENV_ID || 'clouddevyuwa-d0gu7horo48c7d182';
const COLLECTION = 'pl_shopee_login';
const GET_SESSION_URL = 'https://seller.shopee.cn/api/cnsc/selleraccount/get_session/?SPC_CDS_VER=2';
// 飞书通知（可选：用户消息 webhook/机器人；留空则只记日志）
const FEISHU_NOTIFY = ''; // 占位：接入现有通知队列后填

let app;
function db() {
  if (!app) {
    app = cloudbase.init({ env: ENV_ID });
  }
  return app.database();
}

function cookieHeader(cookies) {
  return (cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function parseSetCookie(setCookieHeaders) {
  const out = [];
  (setCookieHeaders || []).forEach((h) => {
    const parts = h.split(';').map((p) => p.trim());
    const [nv] = parts;
    const eq = nv.indexOf('=');
    if (eq < 0) return;
    const name = nv.slice(0, eq);
    const value = nv.slice(eq + 1);
    const rec = { name, value };
    parts.slice(1).forEach((p) => {
      const [k, ...rest] = p.split('=');
      const v = rest.join('=');
      const key = k.toLowerCase();
      if (key === 'max-age') rec.maxAge = parseInt(v, 10) || null;
      else if (key === 'expires') rec.expires = v;
      else if (key === 'domain') rec.domain = v;
      else if (key === 'path') rec.path = v;
      else if (key === 'secure') rec.secure = true;
      else if (key === 'httponly') rec.httpOnly = true;
      else if (key === 'samesite') rec.sameSite = v;
    });
    if (name) out.push(rec);
  });
  return out;
}

function httpsGet(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({
        status: res.statusCode,
        setCookie: res.headers['set-cookie'] || [],
        body: body.slice(0, 500),
        finalUrl: res.headers.location || u.href,
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function nowIso() { return new Date().toISOString(); }

exports.main = async () => {
  const result = { at: nowIso(), shops: [] };
  try {
    const col = db().collection(COLLECTION);
    const { data } = await col.where({ account: 'YSGX001N:main' }).limit(1).get();
    if (!data || !data.length) {
      return { ok: false, error: 'pl_shopee_login 无登录态记录', result };
    }
    const doc = data[0];

    // ===== 层 C 入口：按序尝试每个店铺会话 =====
    const shops = doc.shops || [];
    let recovered = false;
    for (const shop of shops) {
      const shopId = shop.shop_id;
      const shopCookies = (doc.cookies || []).filter((c) => !c.shopId || c.shopId === shopId);
      try {
        const resp = await httpsGet(GET_SESSION_URL, cookieHeader(shopCookies));
        const loginJump = resp.status === 302 && /signin/.test(resp.finalUrl || '');
        const bodyIsLogin = resp.body && /欢迎来到中国卖家中心|Login with QR/.test(resp.body);
        const ok = resp.status === 200 && !loginJump && !bodyIsLogin;

        let newCookies = shopCookies;
        if (ok) {
          // ===== 层 A：捕获 Set-Cookie，刷新会话 =====
          const sc = parseSetCookie(resp.setCookie);
          if (sc.length) {
            const map = new Map(shopCookies.map((c) => [`${c.domain}|${c.name}`, c]));
            sc.forEach((c) => {
              const key = `${c.domain || 'seller.shopee.cn'}|${c.name}`;
              const merged = { ...(map.get(key) || {}), name: c.name, value: c.value };
              if (c.maxAge) merged.maxAge = c.maxAge;
              if (c.expires) merged.expires = c.expires;
              merged.domain = c.domain || 'seller.shopee.cn';
              merged.path = c.path || '/';
              map.set(key, merged);
            });
            newCookies = [...map.values()];
          }
        }

        result.shops.push({
          shop_id: shopId,
          shop_name: shop.shop_name,
          ok,
          status: resp.status,
          cookie_refreshed: ok && newCookies.length !== shopCookies.length,
          body_snip: resp.body.slice(0, 80),
        });

        await col.doc(doc._id).update({
          cookies: newCookies,
          last_keepalive: { at: nowIso(), shop_id: shopId, ok },
        });

        if (ok) { recovered = true; break; }
      } catch (e) {
        result.shops.push({ shop_id: shopId, error: String(e.message || e) });
      }
    }

    result.overall = recovered ? 'ALIVE' : 'EXPIRED';
    if (!recovered) {
      const msg = `⚠️ Shopee 登录态保活失败（${nowIso()}）：${JSON.stringify(result.shops)}`;
      console.error(msg);
      if (FEISHU_NOTIFY) {
        // TODO: 接入现有飞书通知通道
      }
    } else {
      console.log('keepalive ok', JSON.stringify(result));
    }
    return { ok: recovered, result };
  } catch (e) {
    return { ok: false, error: String(e.message || e), result };
  }
};
