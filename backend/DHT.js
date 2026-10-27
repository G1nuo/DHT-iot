/**
 * DHT 传感器数据服务（纯 API + WebSocket 告警）
 *
 * 依赖：npm i express @influxdata/influxdb-client dotenv ws
 * 启动：node DHT.js
 *
 * 对外只有接口，不再托管任何前端页面（前端用你自己的 Vue2 项目）
 *
 * HTTP 接口：
 *   GET  /api/sensor      历史 1 小时数据（10s 聚合），供 ECharts 画图
 *   GET  /api/latest      最新一条温湿度
 *   GET  /api/threshold   查看阈值
 *   POST /api/threshold   修改阈值 { temperature, humidity, enabled }
 *   GET  /api/health      健康检查
 *
 * WebSocket：ws://localhost:3000
 *   hello / latest / alarm / recover / threshold
 */
require('dotenv').config()

const fs = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')
const { WebSocketServer } = require('ws')
const { InfluxDB } = require('@influxdata/influxdb-client')

const app = express()
app.use(express.json())

// ==================== 跨域（Vue 开发服务器通常跑在 8080，必须开）====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// 拦截 Chrome DevTools 自动工作区探测，避免访问接口时控制台出现 404 + CSP 报错
app.use((req, res, next) => {
  if (req.path === '/.well-known/appspecific/com.chrome.devtools.json') {
    return res.status(204).end()
  }
  next()
})

// ==================== 配置 ====================
const INFLUX_URL = process.env.INFLUX_URL || 'http://127.0.0.1:8086'
const token = process.env.INFLUX_TOKEN
const org = process.env.INFLUX_ORG || 'iothub'
const bucket = process.env.INFLUX_BUCKET || 'sensor'
const measurement = process.env.MEASUREMENT || 'sensor'
const PORT = Number(process.env.PORT || 3000)
const ALARM_INTERVAL = Number(process.env.ALARM_INTERVAL || 30000) // 告警轮询间隔，默认 30 秒

// 启动自检：token 为空时 InfluxDB 会静默返回 401
if (!token) {
  console.error('❌ INFLUX_TOKEN 未读取到，请确认 .env 在项目根目录且变量名正确')
  process.exit(1)
}
console.log(`✅ token 已加载（长度 ${token.length}）org=${org} bucket=${bucket}`)

const queryApi = new InfluxDB({ url: INFLUX_URL, token }).getQueryApi(org)

// ==================== 阈值（持久化到 threshold.json）====================
const THRESHOLD_FILE = path.join(__dirname, 'threshold.json')
const DEFAULT_THRESHOLD = { temperature: 30, humidity: 80, enabled: true }

function loadThreshold() {
  try {
    if (fs.existsSync(THRESHOLD_FILE)) {
      return { ...DEFAULT_THRESHOLD, ...JSON.parse(fs.readFileSync(THRESHOLD_FILE, 'utf8')) }
    }
  } catch (e) {
    console.warn('阈值文件读取失败，使用默认值:', e.message)
  }
  return { ...DEFAULT_THRESHOLD }
}

function saveThreshold(t) {
  try {
    fs.writeFileSync(THRESHOLD_FILE, JSON.stringify(t, null, 2), 'utf8')
  } catch (e) {
    console.warn('阈值文件写入失败:', e.message)
  }
}

const threshold = loadThreshold()

// ==================== 通用查询封装 ====================
function runFlux(flux) {
  return new Promise((resolve, reject) => {
    const rows = []
    queryApi.queryRows(flux, {
      next(row, meta) {
        rows.push(meta.toObject(row))
      },
      error: reject,
      complete: () => resolve(rows),
    })
  })
}

// ==================== HTTP 接口 ====================

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), threshold })
})

// 历史数据：过去 1 小时，10 秒聚合均值（供 ECharts 画图）
app.get('/api/sensor', async (req, res) => {
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -1h)
      |> filter(fn: (r) => r["_measurement"] == "${measurement}")
      |> filter(fn: (r) => r["_field"] == "temperature" or r["_field"] == "humidity")
      |> aggregateWindow(every: 10s, fn: mean, createEmpty: false)
      |> yield(name: "mean")`
  try {
    const rows = await runFlux(flux)
    const out = { temperature: [], humidity: [] }
    for (const o of rows) {
      if (out[o._field]) out[o._field].push([o._time, o._value])
    }
    res.json(out)
  } catch (e) {
    console.error('历史查询失败:', e.statusCode || '', e.body || e.message)
    res.status(500).json({ error: String(e.message || e), statusCode: e.statusCode, body: e.body })
  }
})

// 最新一条
app.get('/api/latest', async (req, res) => {
  try {
    res.json(await queryLatest())
  } catch (e) {
    console.error('最新值查询失败:', e.statusCode || '', e.body || e.message)
    res.status(500).json({ error: String(e.message || e), statusCode: e.statusCode })
  }
})

// 查看阈值
app.get('/api/threshold', (req, res) => {
  res.json(threshold)
})

// 修改阈值  body: { "temperature": 30, "humidity": 80, "enabled": true }
app.post('/api/threshold', (req, res) => {
  const b = req.body || {}
  if (b.temperature !== undefined) threshold.temperature = Number(b.temperature)
  if (b.humidity !== undefined) threshold.humidity = Number(b.humidity)
  if (b.enabled !== undefined) threshold.enabled = !!b.enabled
  saveThreshold(threshold)
  console.log('⚙️ 阈值已更新:', threshold)
  broadcast({ type: 'threshold', data: threshold }) // 实时同步给所有前端
  res.json(threshold)
})

// ==================== 查询最新值（告警轮询专用）====================
async function queryLatest() {
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r["_measurement"] == "${measurement}")
      |> filter(fn: (r) => r["_field"] == "temperature" or r["_field"] == "humidity")
      |> last()
      |> yield(name: "last")`
  const rows = await runFlux(flux)
  const latest = {}
  for (const r of rows) {
    latest[r._field] = { time: r._time, value: r._value }
  }
  return latest
}

// ==================== WebSocket ====================
// WebSocket 必须挂在 http server 上，所以下面用 server.listen 而不是 app.listen
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

function broadcast(payload) {
  const msg = JSON.stringify(payload)
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg) // 1 === WebSocket.OPEN
  }
}

let lastLatest = {} // 缓存最新值，前端刚连上时能立刻拿到

wss.on('connection', (ws) => {
  console.log('🔌 前端已连接，当前连接数:', wss.clients.size)
  ws.send(JSON.stringify({ type: 'hello', data: { threshold, latest: lastLatest } }))
  ws.on('close', () => console.log('🔌 前端断开，剩余连接数:', wss.clients.size))
  ws.on('error', (err) => console.warn('WebSocket 异常:', err.message))
})

// ==================== 每 30 秒轮询 + 告警判定 ====================
const alarmState = {} // 记录上一次是否超限，用于去重，避免每 30 秒重复弹窗

async function checkAlarm() {
  try {
    const latest = await queryLatest()
    lastLatest = latest

    // 无论是否超限都推最新值，前端可用来刷新数字
    broadcast({ type: 'latest', data: latest })

    if (!threshold.enabled) return

    const rules = [
      ['temperature', threshold.temperature, '℃', '温度'],
      ['humidity', threshold.humidity, '%', '湿度'],
    ]

    for (const [field, limit, unit, label] of rules) {
      const item = latest[field]
      if (!item || typeof item.value !== 'number') continue

      const over = item.value > limit
      const prev = alarmState[field]

      if (over && prev !== true) {
        // 首次超限 → 推告警
        broadcast({
          type: 'alarm',
          data: { field, label, value: item.value, threshold: limit, unit, time: item.time },
        })
        console.warn(`🚨 ${label}超限: ${item.value}${unit} > ${limit}${unit}`)
      } else if (!over && prev === true) {
        // 从超限恢复正常 → 推解除
        broadcast({
          type: 'recover',
          data: { field, label, value: item.value, threshold: limit, unit },
        })
        console.log(`✅ ${label}恢复正常: ${item.value}${unit}`)
      }
      alarmState[field] = over
    }
  } catch (e) {
    console.error('轮询失败:', e.statusCode || '', e.body || e.message)
  }
}

setInterval(checkAlarm, ALARM_INTERVAL)
checkAlarm() 

// ==================== 启动（只监听接口，不托管页面）====================
server.listen(PORT, () => {
  console.log(`🚀 历史数据: http://localhost:${PORT}/api/sensor`)
  console.log(`🚀 最新数据: http://localhost:${PORT}/api/latest`)
  console.log(`🚀 阈值接口: http://localhost:${PORT}/api/threshold`)
  console.log(`🔔 WebSocket: ws://localhost:${PORT}`)
  console.log(`⏱  每 ${ALARM_INTERVAL / 1000} 秒轮询一次告警`)
})
