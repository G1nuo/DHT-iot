<template>
  <div id="app">
    <h2>温湿度实时监控</h2>
    <SensorChart />
  </div>
</template>

<script>
import SensorChart from './components/SensorChart.vue'
export default {
  components: { SensorChart }
}
</script>