# my-chart（前端看板）

基于 Vue 2 + ECharts 的温湿度实时看板，配套后端见仓库根目录 `backend/`。

## 运行

```bash
npm install
npm run serve
```

默认访问 http://localhost:8080 。

## 环境变量（可选）

在项目根目录新建 `.env.local`：

```
VUE_APP_API_BASE=http://localhost:3000
VUE_APP_WS_URL=ws://localhost:3000
```

不配置时默认使用上述地址。开发环境也可由 `vue.config.js` 中的 `/api` 代理转发，
此时把 `VUE_APP_API_BASE` 置空即可。

## 功能

- 双 Y 轴温湿度实时曲线，5 秒自动刷新
- 温度/湿度阈值参考线，超限数据点以红色标记
- WebSocket 实时接收最新值与告警，浏览器桌面通知
- WebSocket 断线 5 秒自动重连
- 窗口尺寸变化自适应重绘，组件销毁时释放定时器与图表实例
