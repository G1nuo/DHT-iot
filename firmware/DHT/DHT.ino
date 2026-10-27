/**
 * ESP32 + DHT22 温湿度采集节点
 *
 * 每 5 秒采集一次温湿度，封装为 JSON 后通过 MQTT 发布到 sensor/data。
 *
 * 接线：
 *   DHT22 VCC  -> ESP32 3.3V
 *   DHT22 DATA -> GPIO4
 *   DHT22 GND  -> GND
 *
 * 依赖库（Arduino IDE 库管理器）：
 *   PubSubClient / DHT sensor library (Adafruit) / ArduinoJson
 *
 * 注意：
 *   1. ESP32 仅支持 2.4GHz WiFi
 *   2. mqtt_host 必须填运行 Mosquitto 的那台电脑的局域网 IP，不能是 127.0.0.1
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>

#define DHTPIN 4
#define DHTTYPE DHT22

// ====== 修改为你的实际环境 ======
const char* ssid      = "YOUR_WIFI_SSID";        // 仅支持 2.4GHz
const char* password  = "YOUR_WIFI_PASSWORD";
const char* mqtt_host = "192.168.1.100";         // 运行 Mosquitto 的电脑局域网 IP
const uint16_t mqtt_port = 1883;

WiFiClient espClient;
PubSubClient client(espClient);
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n===== 启动 =====");
  Serial.printf("芯片: %s  PSRAM: %u bytes\n", ESP.getChipModel(), ESP.getPsramSize());

  dht.begin();
  Serial.println("DHT22 已初始化 (GPIO4)");

  Serial.printf("连接 WiFi: %s\n", ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 40) {  // 最多等 20 秒
    delay(500);
    Serial.print(".");
    retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi 已连接, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi 连接失败! 检查账号/密码/是否 2.4G");
  }

  client.setServer(mqtt_host, mqtt_port);
  client.setBufferSize(256);   // 默认 256 字节刚好够本项目 JSON，显式声明避免截断
}

void reconnect() {
  while (!client.connected()) {
    Serial.printf("连接 MQTT %s:%d ... ", mqtt_host, mqtt_port);
    if (client.connect("esp32-sensor-01")) {
      Serial.println("成功");
    } else {
      Serial.printf("失败 rc=%d，2秒后重试\n", client.state());
      delay(2000);
    }
  }
}

void loop() {
  // WiFi 掉线时优先重连，避免拿着断网状态继续发布
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi 断开，重连中...");
    WiFi.reconnect();
    delay(3000);
    return;
  }
  if (!client.connected()) reconnect();
  client.loop();

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  // DHT22 读取间隔过短会返回 NaN，必须跳过本次上报，避免脏数据入库
  if (isnan(h) || isnan(t)) {
    Serial.println("DHT22 读取失败(NaN)：检查接线/上拉电阻/供电");
    delay(2000);
    return;
  }

  StaticJsonDocument<256> doc;
  doc["device_id"] = "esp32-01";
  doc["temperature"] = t;
  doc["humidity"] = h;
  char buf[256];
  serializeJson(doc, buf);

  bool ok = client.publish("sensor/data", buf);
  Serial.printf("温度 %.1f°C  湿度 %.1f%%  | %s | publish %s\n",
                t, h, buf, ok ? "成功" : "失败");
  delay(5000);
}
