'use strict';
/**
 * logservice-init — 一次性开通环境 CLS 日志服务（幂等）
 *
 * 背景：CloudBase MCP queryLogs 只有 checkLogService/searchLogs，无开通接口；
 * 官方开通路径：Manager SDK app.log.createLogService()（v5.0.0+）。
 * 本函数部署后 invoke 一次即开通；重复执行幂等返回当前状态。
 */
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

exports.main = async (event = {}) => {
  const t0 = Date.now();
  try {
    await app.log.createLogService();
    const enabled = await app.log.checkLogServiceEnabled();
    return { ok: true, enabled, cost_ms: Date.now() - t0, time: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), cost_ms: Date.now() - t0, time: new Date().toISOString() };
  }
};
