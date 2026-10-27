// 解决 8080(前端) 请求 3000(后端) 的跨域问题
// 改完这个文件后，必须重启 npm run serve 才会生效
module.exports = {
  devServer: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000', // 你的后端地址
        changeOrigin: true,              // 伪造请求来源，骗过后端
        // pathRewrite: { '^/api': '/api' } // 若后端实际路径是 /sensor，改成 { '^/api': '' }
      }
    }
  }
}
