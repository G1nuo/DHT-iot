<template>
    <!-- 必须设置宽高，否则图表空白 -->
    <div>
      <div ref="el" style="width: 100%; height: 400px;"></div>
  
      <!-- 告警状态条 -->
      <div style="margin-top: 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <span>当前温度：<b :style="{ color: tempOver ? '#d9534f' : '#3fb950' }">{{ curTemp }}</b> ℃</span>
        <span>当前湿度：<b :style="{ color: humiOver ? '#d9534f' : '#3fb950' }">{{ curHumi }}</b> %</span>
        <span>WS：<b :style="{ color: wsConnected ? '#3fb950' : '#d9534f' }">
          {{ wsConnected ? '已连接' : '未连接' }}
        </b></span>
        <button @click="enableNotify" style="padding: 4px 12px; cursor: pointer;">
          {{ notifyGranted ? '通知已开启' : '开启浏览器通知' }}
        </button>
      </div>
    </div>
  </template>
  
  <script>
  import * as echarts from 'echarts'
  import axios from 'axios'
  
  // ===== 后端地址 =====
  const API_BASE = process.env.VUE_APP_API_BASE || 'http://localhost:3000'
  const WS_URL = process.env.VUE_APP_WS_URL || 'ws://localhost:3000'
  
  export default {
    name: 'SensorChart',
    data() {
      return {
        chart: null,
        timer: null,
        ws: null,
        wsTimer: null,
        wsConnected: false,
        threshold: { temperature: 30, humidity: 80, enabled: true },
        latest: { temperature: null, humidity: null },
        notifyGranted: false
      }
    },
    computed: {
      curTemp() {
        return this.latest.temperature ? Number(this.latest.temperature.value).toFixed(1) : '--'
      },
      curHumi() {
        return this.latest.humidity ? Number(this.latest.humidity.value).toFixed(1) : '--'
      },
      tempOver() {
        const v = this.latest.temperature && this.latest.temperature.value
        return typeof v === 'number' && v > this.threshold.temperature
      },
      humiOver() {
        const v = this.latest.humidity && this.latest.humidity.value
        return typeof v === 'number' && v > this.threshold.humidity
      }
    },
    mounted() {
      // DOM 渲染后才能 init
      this.chart = echarts.init(this.$refs.el)
      this.load()
      // 5s 自动刷新图表
      this.timer = setInterval(this.load, 5000)
      // 窗口自适应
      window.addEventListener('resize', this.onResize)
  
      this.notifyGranted = 'Notification' in window && Notification.permission === 'granted'
      this.fetchThreshold()
      this.connectWS()
    },
    beforeDestroy() {
      // 销毁定时器、WebSocket 和图表实例，防止内存泄漏
      clearInterval(this.timer)
      clearTimeout(this.wsTimer)
      if (this.ws) {
        this.ws.onclose = null // 防止销毁时触发自动重连
        this.ws.close()
      }
      window.removeEventListener('resize', this.onResize)
      this.chart && this.chart.dispose()
    },
    methods: {
      onResize() {
        this.chart && this.chart.resize()
      },
  
      async load() {
        try {
          // 请求本地接口
          const { data } = await axios.get(`${API_BASE}/api/sensor`)
  
          // 超阈值的点，用 markPoint 标红
          const overT = (data.temperature || []).filter(d => d[1] > this.threshold.temperature)
          const overH = (data.humidity || []).filter(d => d[1] > this.threshold.humidity)
  
          // 渲染图表
          this.chart.setOption({
            tooltip: { trigger: 'axis' },
            legend: { data: ['温度(℃)', '湿度(%)'] },
            xAxis: { type: 'time' },
            yAxis: [
              { type: 'value', name: '温度(℃)' },
              { type: 'value', name: '湿度(%)' }
            ],
            series: [
              {
                name: '温度(℃)',
                type: 'line',
                smooth: true,
                data: data.temperature,
                markLine: {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { color: '#d9534f', type: 'dashed' },
                  label: { formatter: '阈值 ' + this.threshold.temperature + '℃' },
                  data: [{ yAxis: this.threshold.temperature }]
                },
                markPoint: {
                  symbol: 'pin',
                  symbolSize: 45,
                  itemStyle: { color: '#d9534f' },
                  label: { color: '#fff', fontSize: 10, formatter: '超限' },
                  data: overT.map(d => ({ coord: [d[0], d[1]] }))
                }
              },
              {
                name: '湿度(%)',
                type: 'line',
                smooth: true,
                yAxisIndex: 1,
                data: data.humidity,
                markPoint: {
                  symbol: 'pin',
                  symbolSize: 45,
                  itemStyle: { color: '#d9534f' },
                  label: { color: '#fff', fontSize: 10, formatter: '超限' },
                  data: overH.map(d => ({ coord: [d[0], d[1]] }))
                }
              }
            ]
          })
        } catch (e) {
          console.error('获取传感器数据失败', e)
        }
      },
  
      async fetchThreshold() {
        try {
          const { data } = await axios.get(`${API_BASE}/api/threshold`)
          this.threshold = data
        } catch (e) {
          console.error('获取阈值失败', e)
        }
      },
  
      // ==================== WebSocket ====================
      connectWS() {
        try {
          this.ws = new WebSocket(WS_URL)
        } catch (e) {
          console.error('WebSocket 创建失败', e)
          return
        }
  
        this.ws.onopen = () => {
          this.wsConnected = true
          console.log('🔌 WebSocket 已连接')
        }
  
        this.ws.onclose = () => {
          this.wsConnected = false
          console.warn('⚠️ WebSocket 断开，5 秒后重连')
          this.wsTimer = setTimeout(() => this.connectWS(), 5000) // 自动重连
        }
  
        this.ws.onerror = (err) => {
          console.error('WebSocket 错误', err)
        }
  
        this.ws.onmessage = (evt) => {
          let msg
          try {
            msg = JSON.parse(evt.data)
          } catch (e) {
            return
          }
          const d = msg.data || {}
  
          // 连接成功 / 阈值变更
          if (msg.type === 'hello' || msg.type === 'threshold') {
            if (d.threshold) this.threshold = d.threshold
            if (d.latest) this.latest = d.latest
            this.load() // 阈值变了，重绘图表刷新红色 markPoint
          }
  
          // 每 30 秒推送的最新值
          if (msg.type === 'hello' || msg.type === 'latest') {
            const latest = d.latest || d
            if (latest && (latest.temperature || latest.humidity)) {
              this.latest = latest
            }
          }
  
          // 超阈值告警 → 弹浏览器通知
          if (msg.type === 'alarm') {
            this.notify(`🚨 ${d.label}告警`, `当前 ${Number(d.value).toFixed(1)}${d.unit}，超过阈值 ${d.threshold}${d.unit}`)
            this.$message && this.$message({ type: 'warning', message: `${d.label}超限：${Number(d.value).toFixed(1)}${d.unit}` })
            this.load() // 立刻把新的超限点画上去
          }
  
          // 恢复正常
          if (msg.type === 'recover') {
            this.notify(`✅ ${d.label}恢复`, `当前已回落至 ${Number(d.value).toFixed(1)}${d.unit}`)
            this.load()
          }
        }
      },
  
      // ==================== 浏览器通知 ====================
      enableNotify() {
        if (!('Notification' in window)) {
          alert('当前浏览器不支持 Notification')
          return
        }
        Notification.requestPermission().then(p => {
          this.notifyGranted = p === 'granted'
          if (p === 'denied') {
            alert('通知被拒绝，请点击地址栏左侧图标手动允许')
          }
        })
      },
      notify(title, body) {
        if (!('Notification' in window)) return
        if (Notification.permission !== 'granted') return // 未授权就静默跳过
        try {
          new Notification(title, { body })
        } catch (e) {
          console.warn('通知弹出失败', e)
        }
      }
    }
  }
  </script>
  
  <style scoped>
  /* 确保容器有高度 */
  </style>
  