#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>

// ------ WIFI CONFIG ------
const char* ssid = "Nothing Phone (3a) Lite 3411 2";
const char* password = "adii1234";

// ------ BACKEND CONFIG ------
const char* heartbeatUrl       = "https://backend-8-yt04.onrender.com/api/device/status";
const char* rfidScanUrl        = "https://backend-8-yt04.onrender.com/rfid/scan";
const char* objectDetectionUrl = "https://backend-8-yt04.onrender.com/detect";
const char* deviceId            = "ESP32-FG-001";
const char* apiKey              = "secure_esp32_device_shared_api_key_2026";

unsigned long lastHeartbeat = 0;
const unsigned long heartbeatInterval = 4000; // Send heartbeat every 4s to stay 100% SOLID ONLINE

unsigned long lastDetection = 0;
const unsigned long detectionInterval = 2500; // Smooth 2.5s detection frame upload window

WiFiClientSecure secureClient;

// ------ BUZZER (Exact 2-Second Non-Blocking Duration) ------
#define BUZZER_PIN 2
bool buzzerActive = false;
unsigned long buzzerStartTime = 0;
const unsigned long buzzerDuration = 2000; // Exactly 2 seconds (2000ms)

// ------ AI-THINKER CAMERA PIN CONFIG ------
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ------ RFID PINS ------
#define RFID_SS_PIN   12
#define RFID_RST_PIN  -1
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);

WebServer server(80);

void setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  if (psramFound()) {
    config.fb_count = 2;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
  } else {
    Serial.println("Camera ready");
  }
}

void handleCamLo() {
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    server.send(500, "text/plain", "Camera capture failed");
    return;
  }
  server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

void handleRoot() {
  server.send(200, "text/html",
    "<h2>ESP32-CAM + RFID is running</h2><p>Snapshot: <a href='/cam-lo.jpg'>/cam-lo.jpg</a></p>");
}

void checkWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi dropped, reconnecting instantly...");
    WiFi.disconnect();
    WiFi.begin(ssid, password);
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 6000) {
      delay(200);
      Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nWiFi reconnected: " + WiFi.localIP().toString());
    }
  }
}

void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setReuse(true); // Reuse connection for speed
  http.setTimeout(3000);

  if (!http.begin(secureClient, heartbeatUrl)) {
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", apiKey);
  http.addHeader("Connection", "keep-alive");

  StaticJsonDocument<200> doc;
  doc["device_id"] = deviceId;
  doc["battery_level"] = 95;
  doc["signal_strength"] = map(WiFi.RSSI(), -100, -50, 1, 5);
  doc["is_armed"] = 1;

  String payload;
  serializeJson(doc, payload);

  int responseCode = http.POST(payload);
  if (responseCode > 0) {
    Serial.printf("[ONLINE] Heartbeat status: %d\n", responseCode);
    lastHeartbeat = millis(); // Refresh timestamp on success
  } else {
    Serial.printf("Heartbeat failed: %s\n", http.errorToString(responseCode).c_str());
  }
  http.end();
}

void sendForObjectDetection() {
  if (WiFi.status() != WL_CONNECTED) return;

  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    return;
  }

  HTTPClient http;
  http.setReuse(true);
  http.setTimeout(4000);

  if (!http.begin(secureClient, objectDetectionUrl)) {
    esp_camera_fb_return(fb);
    return;
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-API-Key", apiKey);
  http.addHeader("Connection", "keep-alive");

  int code = http.POST(fb->buf, fb->len);

  if (code > 0) {
    Serial.printf("[FRAME SENT] Object detection response: %d\n", code);
    // Successful frame upload also acts as live heartbeat!
    lastHeartbeat = millis();
  } else {
    Serial.printf("Object detection upload failed: %s\n", http.errorToString(code).c_str());
  }

  http.end();
  esp_camera_fb_return(fb);
}

void checkRFID() {
  // Update buzzer state (non-blocking 2-second auto turn-off)
  if (buzzerActive && millis() - buzzerStartTime >= buzzerDuration) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerActive = false;
  }

  if (!rfid.PICC_IsNewCardPresent()) {
    return;
  }
  if (!rfid.PICC_ReadCardSerial()) {
    return;
  }

  String cardId = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    cardId += String(rfid.uid.uidByte[i], HEX);
  }
  cardId.toUpperCase();
  Serial.println("Card detected: " + cardId);

  // ---- BUZZER STARTS IMMEDIATELY FOR EXACTLY 2 SECONDS ----
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerActive = true;
  buzzerStartTime = millis();
  // ---------------------------------------------------------

  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(secureClient, rfidScanUrl)) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", apiKey);
  String payload = "{\"cardId\":\"" + cardId + "\"}";
  int httpCode = http.POST(payload);

  if (httpCode > 0) {
    Serial.println("RFID scan response: " + http.getString());
  }

  http.end();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // High-reliability Wi-Fi auto reconnect
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(ssid, password);

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Camera Ready! Use 'http://");
  Serial.print(WiFi.localIP());
  Serial.println("' to connect");

  secureClient.setInsecure();

  setupCamera();

  SPI.begin(14, 13, 15, 12);
  rfid.PCD_Init();
  Serial.println("RFID reader ready");

  server.on("/", handleRoot);
  server.on("/cam-lo.jpg", handleCamLo);
  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
  checkRFID();
  checkWiFi();

  // Send regular heartbeat every 4s
  if (millis() - lastHeartbeat >= heartbeatInterval) {
    sendHeartbeat();
  }

  // Send camera detection frames every 2.5s
  if (millis() - lastDetection >= detectionInterval) {
    sendForObjectDetection();
    lastDetection = millis();
  }
}
