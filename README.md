# 洗烘雷达

本地私有小工具，用来展示红豆斋洗衣机、负一层洗衣机和负一层烘干机的占用情况。

## 运行

```powershell
cd D:\pyitme\laundry-radar
npm start
```

然后打开：

```text
http://127.0.0.1:8787
```

也可以直接运行：

```powershell
.\start-server.ps1
```

授权 token 只在浏览器 `sessionStorage` 和本地请求内使用，不写入仓库文件。也可以通过环境变量提供：

```powershell
$env:HAIER_AUTH_TOKEN = "<AUTH>"
npm start
```

## Docker

构建镜像：

```powershell
docker build -t laundry-radar:latest .
```

运行容器：

```powershell
docker run --rm -p 8787:8787 -e HAIER_AUTH_TOKEN="<AUTH>" laundry-radar:latest
```

然后打开：

```text
http://127.0.0.1:8787
```

`auth.local.json` 已被 `.dockerignore` 排除，不会打进镜像。容器内授权请使用 `HAIER_AUTH_TOKEN` 环境变量。

使用 Compose 部署时，创建 `.env`：

```text
HAIER_AUTH_TOKEN=<AUTH>
```

然后启动：

```powershell
docker compose up -d
```

默认 `compose.yml` 只绑定服务器本机 `127.0.0.1:8787`，避免携带个人授权的服务直接暴露到公网。

## 接口

服务端代理请求：

```text
POST https://yshz-user.haier-ioc.com/position/deviceDetailPage
```

位置：

- 红豆斋洗衣机：`positionId=37142`，`categoryCode=00`
- 负一层洗衣机：`positionId=37148`，`categoryCode=00`，`floorCode=B1`
- 负一层烘干机：`positionId=37148`，`categoryCode=02`
