# CloudBase 云函数仓库（电商云化）

跨境电商自动化全链路云化代码仓库。环境：**clouddevyuwa-d0gu7horo48c7d182**（ap-shanghai）。

## 云函数清单

| 函数 | 作用 | 触发器 |
|---|---|---|
| logservice-init | 一次性开通环境 CLS 日志服务（幂等） | 手动 invoke 一次 |
| pl-listing-check | Shopee 上架合规预检（知识库规则固化，纯逻辑） | 无（选品流水线调用） |
| pl-listing-assets | 上架素材生命周期：登记/查询/14 天自动删除 | timer 每天 03:00 cleanup |
| pl-listing-template | CNSC 批量上传模板生成（规格≤2 层 + 素材直链） | 无（选品流水线调用） |

## 部署方式（业界最佳实践：仓库驱动 + CI/CD）

### 方式 A：GitHub Actions 自动部署（推荐）
1. 腾讯云控制台 → 访问管理 → API 密钥管理，新建密钥
2. GitHub 仓库 → Settings → Secrets and variables → Actions，添加：
   - `TCB_SECRET_ID` = 腾讯云 SecretId
   - `TCB_SECRET_KEY` = 腾讯云 SecretKey
3. push `main` 分支（cloudfunctions/** 或 cloudbaserc.json 变更）→ 自动部署
4. 手动触发：仓库 Actions → Deploy Cloud Functions → Run workflow

### 方式 B：CloudBase 控制台从 GitHub 导入（已连接 GitHub 时）
云开发控制台 → 云函数 → 新建 → 从 GitHub 仓库导入（选择 cloudbase 仓库）→ 环境选 clouddevyuwa-d0gu7horo48c7d182

### 方式 C：本地 CLI（备用）
```bash
tcb login
tcb fn deploy -e clouddevyuwa-d0gu7horo48c7d182
```

## 部署后动作
1. invoke logservice-init 一次 → 开通 CLS 日志服务
2. 验证：`tcb fn invoke pl-listing-check -e clouddevyuwa-d0gu7horo48c7d182`（传 listing.json 数据）
3. pl-listing-assets 的 cleanup timer（每天 03:00）由 cloudbaserc.json 自动创建

## 素材 2 周自动删除双保险
- 主机制：pl-listing-assets cleanup timer 每天扫过期记录 → app.deleteFile 删除
- 加固（可选）：控制台 → 存储 → 生命周期规则，prefix=listing-assets/，14 天过期删除
