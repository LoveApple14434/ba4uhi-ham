# BA4UHI · 业余无线电 QSL 主页

呼号 **BA4UHI** 的个人业余无线电页面，采用淡粉色主题，主体为 QSL 通联记录与 QSL 卡片预览。

- QTH：中国 · 江苏省南京市栖霞区
- Maidenhead 网格：`OM92lc`
- CQ Zone 24 / ITU Zone 44
- 设备：宝锋 UV-5R、泉盛 UV-K6；部分主控记录记作 `HT`
- 公开主页数据：`assets/data.js` 中的 73 条记录、64 个呼号

## 项目结构

```text
.
├── index.html               # 公开主页
├── assets/
│   ├── style.css            # 公开主页样式
│   ├── app.js               # 搜索、年份筛选、CSV 导出、QSL 卡片切换
│   ├── data.js              # QSL 记录数据
│   ├── qsl-qrcode.png
│   └── cards/               # 6 款 QSL 正面 + 1 张背面（WebP）
├── card/                    # QSL 卡片原始图片
├── server/                  # 单用户 Node 管理后台
│   ├── app.js
│   ├── public/
│   ├── backups/
│   └── README.md            # 完整部署说明
├── preview-desktop.jpg
└── preview-qsl-card.jpg
```

## 本地预览

公开主页是纯静态页面，无构建步骤：

```bash
python -m http.server 8000
```

打开 <http://localhost:8000>。

管理后台需要 Node.js 18+：

```bash
cd server
cp .env.example .env
# 编辑 .env：ADMIN_PASSWORD、DATA_FILE、BACKUP_DIR
node app.js
```

默认后台地址：<http://127.0.0.1:3010/admin/>

部署到 VPS / 宝塔、Nginx 反向代理、HTTPS、备份恢复等内容见
[`server/README.md`](server/README.md)。

## 数据与卡片

- 通联记录集中在 `assets/data.js`；后台每次保存会先备份，再原子替换该文件。
- QSL 卡片展示图由 `card/` 中的原图生成，页面使用 `assets/cards/` 下的优化 WebP。
- `.env`、`server/.env`、`server/backups/*.js` 和日志文件不进入版本库。
- 管理密码只放在服务器环境变量 `.env` 中，不写入前端或仓库。

## 说明

页面没有外部 JavaScript 依赖。公开页面的记录统计、年份筛选和 CSV 导出均在浏览器本地完成。
