"""
传感器数据模拟器：没有 ESP32 硬件时，用来跑通整条数据链路。

用法：
    pip install paho-mqtt
    python sensor_sim.py

每 5 秒向 Mosquitto 的 sensor/data 主题发布一条温湿度数据，
JSON 结构与 ESP32 固件保持一致，后续 Telegraf / InfluxDB / 前端无需任何改动。
"""

import json
import random
import time

import paho.mqtt.client as mqtt

MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883
TOPIC = "sensor/data"
INTERVAL = 5

# paho-mqtt 2.x 需要显式指定回调 API 版本，1.x 无此参数
if hasattr(mqtt, "CallbackAPIVersion"):
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
else:
    client = mqtt.Client()

client.connect(MQTT_HOST, MQTT_PORT, 60)
client.loop_start()

try:
    while True:
        payload = {
            "device_id": "sim-01",
            "temperature": round(random.uniform(20, 32), 2),
            "humidity": round(random.uniform(40, 75), 2),
        }
        client.publish(TOPIC, json.dumps(payload))
        print(payload)
        time.sleep(INTERVAL)
except KeyboardInterrupt:
    print("\n模拟器已停止")
finally:
    client.loop_stop()
    client.disconnect()
