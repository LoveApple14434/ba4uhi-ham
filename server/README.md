# BA4UHI QSL 管理后台

给静态主页 `assets/data.js` 增加一个单用户、移动端友好的增删改后台。后台只负责写回数据文件，不引入数据库，也不改变已经发布的公开主页。

- Node.js **18+**
- 无第三方依赖，不需要 `npm install`
- 单用户密码登录
- 登录失败限流、HttpOnly 会话 Cookie、CSRF 校验
- 保存前自动备份，原子替换 `data.js`
- 桌面和手机均可操作

## 文件结构

```text
server/
├── app.js              # HTTP 服务、鉴权、API、data.js 读写
├── package.json
├── .env.example
├── README.md
├── backups/            # 自动备份（保留最近 30 份）
└── public/
    ├── index.html      # 登录页 + 管理界面
    ├── admin.css
    ├── admin.js
    └── favicon.svg
```

## 一、准备数据文件

后台默认读取：

```text
server/../assets/data.js
```

也就是主页旁边的 `assets/data.js`。部署时建议在 `.env` 里写绝对路径，例如：

```env
DATA_FILE=/www/wwwroot/ba4uhi/assets/data.js
BACKUP_DIR=/www/wwwroot/ba4uhi-admin/backups
```

要求：

1. 文件已经存在，并且包含 `window.HAM_DATA.records` 数组；
2. 运行 Node 的用户对 `DATA_FILE` 有读写权限；
3. `BACKUP_DIR` 可写；
4. 不要把这个后台目录放进公开静态目录，尤其不要公开 `.env` 和 `backups/`。

## 二、配置

在服务器上进入 `server/`：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```env
PORT=3010
HOST=127.0.0.1
BASE_PATH=/admin

DATA_FILE=/www/wwwroot/ba4uhi/assets/data.js
BACKUP_DIR=/www/wwwroot/ba4uhi-admin/backups

ADMIN_PASSWORD=请替换成至少12位的随机密码
COOKIE_SECURE=1
TRUST_PROXY=1
PUBLIC_ORIGIN=https://loveapple.space
SITE_URL=/blog/QSL-LOG/
```

说明：

- `ADMIN_PASSWORD` 至少 12 个字符，服务启动时会检查。
- 生产环境走 HTTPS 时设置 `COOKIE_SECURE=1`；本地 HTTP 调试可设为 `0`。
- Nginx 在前面时设置 `TRUST_PROXY=1`，限流才能识别真实客户端 IP。
- `PUBLIC_ORIGIN` 建议填写公开主页的完整来源（协议 + 域名）；它用于拒绝其他站点的写请求。
- `SITE_URL` 是后台右上角“查看主页”的链接，可填完整 URL 或站内路径。

## 三、启动

```bash
node app.js
```

看到类似输出即成功：

```text
[qsl-admin] listening on http://127.0.0.1:3010/admin/
[qsl-admin] data file: /www/wwwroot/ba4uhi/assets/data.js
```

本机可以先验证：

```bash
curl http://127.0.0.1:3010/admin/api/health
# {"ok":true,"service":"ba4uhi-qsl-admin"}
```

### 用 PM2 常驻

```bash
pm2 start app.js --name ba4uhi-admin
pm2 save
pm2 startup
```

### 宝塔 Node 项目

在宝塔面板新建 Node 项目：

- 项目目录：`server/`
- 启动文件：`app.js`
- 启动命令：`node app.js`
- 端口：`3010`（与 `.env` 的 `PORT` 一致）
- 运行用户需要能写 `DATA_FILE` 和 `BACKUP_DIR`

如果使用宝塔的反向代理，按下节配置；不要额外把 3010 端口暴露到公网。

## 四、Nginx 反向代理

推荐让后台与公开主页同域，路径为 `/admin/`。在站点 Nginx 配置中加入：

```nginx
location = /admin {
    return 301 /admin/;
}

location /admin/ {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
}
```

注意：

- `proxy_pass` 后面不要加路径（不要写成 `http://127.0.0.1:3010/`），否则 `/admin` 前缀会被剥掉，后台路由会 404。
- 这段配置要放在静态站点的通用 `location /` 之前。
- 保存后执行 `nginx -t`，再 reload。
- 如果使用 HTTPS，确保 `COOKIE_SECURE=1`，并且访问地址是 `https://你的域名/admin/`。

## 五、使用

1. 打开 `https://你的域名/admin/`；
2. 输入 `.env` 中的 `ADMIN_PASSWORD`；
3. 右上角“新增记录”；
4. 填写日期、时间、对方呼号；其余字段按需填写；
5. 保存后刷新公开主页，即可看到新记录。

编辑和删除都在每条记录的右侧。删除前会二次确认。

每次保存：

1. 把当前 `data.js` 复制到 `BACKUP_DIR/data-YYYYMMDD-HHMMSS.js`；
2. 保留最近 30 份；
3. 先写临时文件，再用 `rename` 原子替换 `data.js`；
4. 同步更新 `sourceStats.total_qsos`、`unique_callsigns`、`last_updated`。

## 六、恢复备份

如果保存出错或内容需要回滚，停掉后台，把某个备份复制回数据文件：

```bash
cp backups/data-YYYYMMDD-HHMMSS.js /www/wwwroot/ba4uhi/assets/data.js
```

然后重新启动后台。备份文件本身就是完整的 `data.js` 内容。

## 七、安全建议

- 必须使用 HTTPS；后台登录页和 API 都带 `noindex`，但这不等于访问控制。
- `ADMIN_PASSWORD` 使用随机长密码，不要与其他网站共用。
- `.env` 权限设为 `600`，不要提交到代码仓库。
- 不要把 `server/` 放进 Nginx 的静态根目录；只代理 `/admin/`。
- 可选：在 Nginx 的 `/admin/` location 里再加一层 IP 白名单：

```nginx
allow 203.0.113.10;
deny all;
```

或使用 Cloudflare Access / 宝塔防火墙限制来源 IP。密码登录之外再加一层来源限制更稳妥。

- 会话保存在进程内存中；重启 Node 会让所有登录会话失效，这是正常现象。
- 连续 8 次输错密码会锁定该 IP 15 分钟；成功后清除计数。
- 若修改了 `.env` 中的密码，需要重启 Node 才会生效。

## 八、常见问题

**打开 `/admin/` 显示 404**

检查 Nginx 的 `proxy_pass` 是否保留了 `/admin` 前缀，以及 Node 是否监听在 `.env` 配置的端口。

**登录成功但保存时报 403**

多为 `PUBLIC_ORIGIN` 与实际访问域名不一致，或浏览器没有带上 Cookie。确认使用同一个域名访问，清掉旧 Cookie 后再试。

**保存时报 EACCES / permission denied**

给 Node 运行用户授予 `DATA_FILE` 的读写权限和 `BACKUP_DIR` 的写权限。

**保存后主页没有变化**

浏览器或 Nginx 缓存了 `assets/data.js`。强制刷新主页；如果站点设置了长缓存，给这个文件加：

```nginx
location = /blog/QSL-LOG/assets/data.js {
    add_header Cache-Control "no-cache, must-revalidate";
}
```

路径按公开主页的实际路径调整。

**忘记密码**

修改 `.env` 的 `ADMIN_PASSWORD`，重启 Node；已登录的旧会话也会随进程重启失效。

## 九、数据字段

后台表单保存的字段与公开主页的 `data.js` 兼容：

| 字段 | 说明 |
| --- | --- |
| `date` | `YYYY-MM-DD` |
| `time` | `HH:MM`（CST / UTC+8） |
| `callsign` | 对方呼号 |
| `freq_rx` / `freq_tx` | 接收 / 发射频率 |
| `mode` | 例如 FM |
| `rst_sent` / `rst_rcvd` | RST 信号报告 |
| `qth` | 对方 QTH |
| `grid` | 网格 |
| `rig` / `ant` / `pwr` | 对方设备 / 天线 / 功率 |
| `name` | 对方姓名（可选） |
| `my_rig` / `my_ant` / `my_pwr` | 本台设备 / 天线 / 功率 |
| `remarks` | 备注 |

公开主页会把 `my_rig` 中包含 `UV-K6` 的记录识别为泉盛 UV-K6，其余识别为宝锋 UV-5R；如需新增设备，可同时调整 `assets/app.js` 中的归一化逻辑。
