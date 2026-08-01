/*
 * ======================================================================================
 * FARMGUARD SECURITY SYSTEM - ESP32-S3 FIRMWARE
 * ======================================================================================
 * Hardware: ESP32-S3
 * 
 * EXACT PIN ASSIGNMENTS:
 *  - GPIO4  : Physical Disarm Button (INPUT_PULLUP)
 *  - GPIO5  : LDR Signal (Analog ambient light reader)
 *  - GPIO16 : UART RX (Receives from ESP32-CAM TX GPIO1 @ 115200 baud)
 *  - GPIO17 : UART TX (Transmits to ESP32-CAM RX GPIO3 @ 115200 baud)
 *  - GPIO18 : LD2410 Radar TX (Hardware Serial 2 RX @ 115200 baud)
 *  - GPIO19 : LD2410 Radar RX (Hardware Serial 2 TX @ 115200 baud)
 *  - GPIO21 : LD2410 Radar OUT / Motion Trigger (Digital HIGH on motion)
 *  - GPIO23 : IR LED Transistor Base Driver (Output)
 *  - GPIO25 : Relay - Shed Lights (Active LOW: LOW = ON, HIGH = OFF)
 *  - GPIO26 : SIM800L Module TX (Connected to S3 RX GPIO26 @ 9600 baud)
 *  - GPIO27 : SIM800L Module RX (Connected to S3 TX GPIO27 @ 9600 baud)
 *  - GPIO32 : Buzzer (Active HIGH: HIGH = ON, LOW = OFF)
 *  - GPIO33 : Relay - Siren (Active LOW: LOW = ON, HIGH = OFF)
 * 
 * SITUATIONS IMPLEMENTED:
 *  - SITUATION 1 (IDLE): Polls LD2410 motion trigger (GPIO21). Keeps system idle.
 *  - SITUATION 2 (ANIMAL): Motion detected -> reads LDR (GPIO5); if dark, sends "IR_ON\n", 
 *    waits 300ms, then sends "WAKE\n" over UART. On receiving "ANIMAL\n" from CAM, returns 
 *    to idle with no alarms.
 *  - SITUATION 3 (OWNER): Receives "OWNER\n" from CAM -> sends "IR_OFF\n", logs timestamped 
 *    event locally, returns to idle with no alarms.
 *  - SITUATION 4 (INTRUDER): Receives "INTRUDER\n" from CAM -> triggers full alarm:
 *     - Buzzer ON (GPIO32 HIGH)
 *     - Siren Relay ON (GPIO33 LOW)
 *     - Shed Lights Relay ON (GPIO25 LOW)
 *     - SIM800L SMS: AT+CMGF=1, AT+CMGS to owner's phone number
 *     - Webhook HTTP POST to https://yourapp.com/alert {"type":"intruder","timestamp":millis()}
 *     - After 30,000ms (non-blocking millis()), silences Siren & Buzzer, but leaves 
 *       Shed Lights ON until manually disarmed via GPIO4 button.
 *  - SITUATION 5 (FAIL-SAFE TIMEOUT):
 *    Starts 15,000ms non-blocking timer on sending "WAKE". If no UART response ("ANIMAL", 
 *    "OWNER", or "INTRUDER") is received within 15 seconds, automatically escalates to 
 *    full INTRUDER alarm.
 *  - SITUATION 6/7 (WIFI/SIM DOWN FALLBACKS):
 *    - Checks WiFi.status() before HTTP alert POST. If offline, skips webhook but completes 
 *      local alarm + SIM800L SMS.
 *    - Checks SIM800L AT responses within 2000ms timeout. If SIM fails/unresponsive, 
 *      skips SMS but completes local alarm + WiFi alert.
 *  - SITUATION 8 (POWER ARCHITECTURE):
 *    [NOTE: Dual battery packs / isolated buck converters. SIM800L powered via 3.7V-4.2V 
 *     high-current buck converter with shared GND.]
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// --------------------------------------------------------------------------------------
// CONFIGURATION CONSTANTS (UPDATE FOR YOUR ENVIRONMENT)
// --------------------------------------------------------------------------------------
const char* WIFI_SSID           = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD       = "YOUR_WIFI_PASSWORD";
const char* OWNER_PHONE_NUMBER  = "+1234567890";
const char* alertWebhookUrl   = "https://backend-8-yt04.onrender.com/alert";

// Dark LDR Analog Threshold (0 - 4095 on ESP32-S3 ADC)
const int LDR_DARK_THRESHOLD   = 1500; 

// Timing Constants (Non-blocking millis())
const unsigned long CAM_TIMEOUT_MS     = 15000; // 15s Fail-safe timeout (SITUATION 5)
const unsigned long ALARM_DURATION_MS  = 30000; // 30s Siren/Buzzer duration

// --------------------------------------------------------------------------------------
// PIN DEFINITIONS
// --------------------------------------------------------------------------------------
#define PIN_DISARM_BTN   4
#define PIN_LDR_S3       5
#define PIN_CAM_RX      16
#define PIN_CAM_TX      17
#define PIN_LD2410_TX   18
#define PIN_LD2410_RX   19
#define PIN_RADAR_OUT   21
#define PIN_IR_BASE     23
#define PIN_RELAY_LIGHT 25
#define PIN_SIM_TX      26
#define PIN_SIM_RX      27
#define PIN_BUZZER      32
#define PIN_RELAY_SIREN 33

// --------------------------------------------------------------------------------------
// STATE MACHINE DEFINITION
// --------------------------------------------------------------------------------------
enum SystemState {
  STATE_IDLE,
  STATE_WAITING_CAM_RESPONSE,
  STATE_ALARM_ACTIVE,
  STATE_LIGHTS_ONLY
};

SystemState currentState = STATE_IDLE;

unsigned long wakeSentTimestamp  = 0;
unsigned long alarmStartTimestamp = 0;

// --------------------------------------------------------------------------------------
// HARDWARE SERIAL OBJECTS
// --------------------------------------------------------------------------------------
HardwareSerial SerialCam(1);   // Hardware Serial 1: UART to ESP32-CAM
HardwareSerial SerialRadar(2); // Hardware Serial 2: LD2410 Radar Data
HardwareSerial SerialSIM(0);   // Hardware Serial 0: SIM800L GSM Module

// --------------------------------------------------------------------------------------
// FUNCTION PROTOTYPES
// --------------------------------------------------------------------------------------
void initWiFi();
void initSIM800L();
void triggerFullAlarm();
void disarmSystem();
bool sendSIM800LSMS(const String& phoneNumber, const String& message);
bool waitForSIMResponse(const char* expected, unsigned long timeoutMs);
void sendCloudAlertWebhook();
void logEvent(const char* eventName);

// ======================================================================================
// SETUP
// ======================================================================================
void setup() {
  Serial.begin(115200);
  SerialCam.begin(115200, SERIAL_8N1, PIN_CAM_RX, PIN_CAM_TX);
  SerialRadar.begin(115200, SERIAL_8N1, PIN_LD2410_TX, PIN_LD2410_RX);
  SerialSIM.begin(9600, SERIAL_8N1, PIN_SIM_RX, PIN_SIM_TX);

  Serial.println("\n[ESP32-S3] Starting FarmGuard Master Controller Node...");

  // Output Pins & Default Safe States
  pinMode(PIN_IR_BASE, OUTPUT);
  digitalWrite(PIN_IR_BASE, LOW);

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  pinMode(PIN_RELAY_SIREN, OUTPUT);
  digitalWrite(PIN_RELAY_SIREN, HIGH); // Relay OFF (Active LOW)

  pinMode(PIN_RELAY_LIGHT, OUTPUT);
  digitalWrite(PIN_RELAY_LIGHT, HIGH); // Relay OFF (Active LOW)

  // Input Pins
  pinMode(PIN_RADAR_OUT, INPUT);
  pinMode(PIN_LDR_S3, INPUT);
  pinMode(PIN_DISARM_BTN, INPUT_PULLUP);

  // Initialize WiFi & SIM800L
  initWiFi();
  initSIM800L();

  Serial.println("[ESP32-S3] System Ready. Monitoring LD2410 Radar on GPIO21 (SITUATION 1)...");
}

// ======================================================================================
// MAIN LOOP & NON-BLOCKING STATE MACHINE
// ======================================================================================
void loop() {
  // 1. Check physical disarm button (GPIO4 - Active LOW when pressed)
  if (digitalRead(PIN_DISARM_BTN) == LOW) {
    disarmSystem();
  }

  // 2. Non-blocking State Machine
  switch (currentState) {

    // ----------------------------------------------------------------------------------
    // SITUATION 1: IDLE - Poll LD2410 Motion Pin (GPIO21)
    // ----------------------------------------------------------------------------------
    case STATE_IDLE: {
      if (digitalRead(PIN_RADAR_OUT) == HIGH) {
        Serial.println("\n[ESP32-S3] Motion triggered by LD2410 Radar on GPIO21!");

        // Read LDR on GPIO5
        int ldrVal = analogRead(PIN_LDR_S3);
        bool isDark = (ldrVal < LDR_DARK_THRESHOLD);
        Serial.printf("[ESP32-S3] LDR Reading: %d (Dark Environment: %s)\n", ldrVal, isDark ? "YES" : "NO");

        if (isDark) {
          Serial.println("[ESP32-S3] Ambient light dark. Turning ON IR illuminator & sending IR_ON to CAM...");
          digitalWrite(PIN_IR_BASE, HIGH);
          SerialCam.println("IR_ON");

          // Non-blocking 300ms pre-wake delay using millis()
          unsigned long irDelayStart = millis();
          while (millis() - irDelayStart < 300) {
            // Keep background processing alive during short delay
          }
        }

        Serial.println("[ESP32-S3] Sending WAKE command to ESP32-CAM over UART...");
        SerialCam.println("WAKE");

        // Start SITUATION 5: 15-second fail-safe timer
        wakeSentTimestamp = millis();
        currentState = STATE_WAITING_CAM_RESPONSE;
      }
      break;
    }

    // ----------------------------------------------------------------------------------
    // SITUATIONS 2, 3, 4, 5: WAITING FOR CAM RESPONSE OR 15s FAIL-SAFE TIMEOUT
    // ----------------------------------------------------------------------------------
    case STATE_WAITING_CAM_RESPONSE: {
      // Check for UART response from ESP32-CAM
      if (SerialCam.available() > 0) {
        String response = SerialCam.readStringUntil('\n');
        response.trim();
        Serial.printf("[ESP32-S3] UART Received from CAM: '%s'\n", response.c_str());

        if (response == "ANIMAL") {
          // SITUATION 2: Animal detected -> No alarm, return to IDLE
          Serial.println("[ESP32-S3] SITUATION 2: Animal confirmed by CAM. Turning OFF IR & returning to IDLE.");
          digitalWrite(PIN_IR_BASE, LOW);
          SerialCam.println("IR_OFF");
          logEvent("ANIMAL_DETECTED_NO_ALARM");
          currentState = STATE_IDLE;
        } 
        else if (response == "OWNER") {
          // SITUATION 3: Authorized Owner verified -> No alarm, return to IDLE
          Serial.println("[ESP32-S3] SITUATION 3: Owner verified by Face/RFID. Turning OFF IR & returning to IDLE.");
          digitalWrite(PIN_IR_BASE, LOW);
          SerialCam.println("IR_OFF");
          logEvent("OWNER_VERIFIED_ACCESS_GRANTED");
          currentState = STATE_IDLE;
        } 
        else if (response == "INTRUDER") {
          // SITUATION 4: Intruder detected -> Trigger full alarm
          Serial.println("[ESP32-S3] SITUATION 4: INTRUDER confirmed by CAM! Activating FULL ALARM sequence.");
          digitalWrite(PIN_IR_BASE, LOW);
          triggerFullAlarm();
        }
      } 
      else {
        // SITUATION 5 - FAIL-SAFE: Check 15,000ms UART response timeout
        if (millis() - wakeSentTimestamp >= CAM_TIMEOUT_MS) {
          Serial.println("[ESP32-S3] SITUATION 5 (FAIL-SAFE): 15s UART Timeout with no CAM response!");
          Serial.println("[ESP32-S3] Never stay silent on timeout -> Triggering FULL ALARM sequence.");
          digitalWrite(PIN_IR_BASE, LOW);
          logEvent("FAIL_SAFE_UART_TIMEOUT_ALARM_TRIGGERED");
          triggerFullAlarm();
        }
      }
      break;
    }

    // ----------------------------------------------------------------------------------
    // SITUATION 4: ALARM ACTIVE - 30 Second Timer
    // ----------------------------------------------------------------------------------
    case STATE_ALARM_ACTIVE: {
      // Non-blocking 30,000ms timer check
      if (millis() - alarmStartTimestamp >= ALARM_DURATION_MS) {
        Serial.println("[ESP32-S3] 30 seconds elapsed. Turning OFF Siren & Buzzer.");
        Serial.println("[ESP32-S3] Shed Lights remain ON until manual disarm button (GPIO4) is pressed.");

        // Silence Siren & Buzzer
        digitalWrite(PIN_BUZZER, LOW);
        digitalWrite(PIN_RELAY_SIREN, HIGH); // Relay OFF (Active LOW)

        // Keep Shed Lights Relay ON (GPIO25 LOW)
        digitalWrite(PIN_RELAY_LIGHT, LOW);  // Relay ON (Active LOW)

        currentState = STATE_LIGHTS_ONLY;
      }
      break;
    }

    // ----------------------------------------------------------------------------------
    // LIGHTS ONLY STATE: Shed lights remain ON until disarm button press
    // ----------------------------------------------------------------------------------
    case STATE_LIGHTS_ONLY: {
      // Awaiting manual disarm button press (GPIO4)
      break;
    }
  }

  // Small delay for task CPU balance
  vTaskDelay(10 / portTICK_PERIOD_MS);
}

// ======================================================================================
// ALARM & ACTION FUNCTIONS
// ======================================================================================
void triggerFullAlarm() {
  logEvent("FULL_INTRUDER_ALARM_ACTIVATED");

  // 1. Activate Hardware Relays & Buzzer
  digitalWrite(PIN_BUZZER, HIGH);      // Buzzer ON
  digitalWrite(PIN_RELAY_SIREN, LOW);  // Siren Relay ON (Active LOW)
  digitalWrite(PIN_RELAY_LIGHT, LOW);  // Shed Lights Relay ON (Active LOW)

  // 2. Send SMS via SIM800L (Situation 6/7 check inside function)
  String smsMsg = "FARMGUARD ALERT! Unknown person at your shed. Check the app.";
  sendSIM800LSMS(OWNER_PHONE_NUMBER, smsMsg);

  // 3. Send HTTP Alert Webhook (Situation 6/7 check inside function)
  sendCloudAlertWebhook();

  // 4. Start 30,000ms non-blocking timer
  alarmStartTimestamp = millis();
  currentState = STATE_ALARM_ACTIVE;
}

void disarmSystem() {
  Serial.println("\n[ESP32-S3] Manual Disarm Command Executed (GPIO4 Pressed).");

  // Turn OFF all alarm outputs
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_RELAY_SIREN, HIGH); // Relay OFF (Active LOW)
  digitalWrite(PIN_RELAY_LIGHT, HIGH); // Relay OFF (Active LOW)
  digitalWrite(PIN_IR_BASE, LOW);

  logEvent("SYSTEM_MANUALLY_DISARMED");

  currentState = STATE_IDLE;
  delay(500); // Debounce delay for physical button
}

// --------------------------------------------------------------------------------------
// SIM800L GSM SMS FUNCTION (SITUATION 6/7 FALLBACK INCLUDED)
// --------------------------------------------------------------------------------------
bool sendSIM800LSMS(const String& phoneNumber, const String& message) {
  Serial.println("[ESP32-S3] [SIM800L] Initializing SMS Transmission...");

  // Check SIM800L AT responsiveness with 2000ms timeout
  SerialSIM.println("AT");
  if (!waitForSIMResponse("OK", 2000)) {
    Serial.println("[ESP32-S3] [SIM800L] SITUATION 6/7 FALLBACK: SIM800L unresponsive. Skipping SMS alert.");
    return false;
  }

  // Set SMS Text Mode
  SerialSIM.println("AT+CMGF=1");
  if (!waitForSIMResponse("OK", 2000)) return false;

  // Specify recipient phone number
  SerialSIM.print("AT+CMGS=\"");
  SerialSIM.print(phoneNumber);
  SerialSIM.println("\"");
  delay(100);

  // Transmit text message payload
  SerialSIM.print(message);
  SerialSIM.write(26); // Ctrl+Z termination character

  if (waitForSIMResponse("+CMGS:", 10000)) {
    Serial.println("[ESP32-S3] [SIM800L] SMS sent successfully!");
    return true;
  } else {
    Serial.println("[ESP32-S3] [SIM800L] SMS transmission timeout / failure.");
    return false;
  }
}

bool waitForSIMResponse(const char* expected, unsigned long timeoutMs) {
  unsigned long start = millis();
  String response = "";
  while (millis() - start < timeoutMs) {
    while (SerialSIM.available()) {
      char c = SerialSIM.read();
      response += c;
      if (response.indexOf(expected) != -1) {
        return true;
      }
    }
  }
  return false;
}

// --------------------------------------------------------------------------------------
// CLOUD WEBHOOK HTTP ALERT (SITUATION 6/7 FALLBACK INCLUDED)
// --------------------------------------------------------------------------------------
void sendCloudAlertWebhook() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[ESP32-S3] SITUATION 6/7 FALLBACK: WiFi offline. Skipping Cloud Webhook alert.");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure(); // Bypass SSL certificate verification for placeholder domain
  HTTPClient http;

  if (http.begin(client, alertWebhookUrl)) {
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);

    StaticJsonDocument<200> doc;
    doc["type"] = "intruder";
    doc["timestamp"] = millis();
    String jsonPayload;
    serializeJson(doc, jsonPayload);

    Serial.println("[ESP32-S3] Sending HTTP POST to Cloud Alert Webhook...");
    int httpCode = http.POST(jsonPayload);

    if (httpCode > 0) {
      Serial.printf("[ESP32-S3] Cloud Alert Webhook response status: %d\n", httpCode);
    } else {
      Serial.printf("[ESP32-S3] Cloud Alert Webhook failed, error: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
  }
}

// --------------------------------------------------------------------------------------
// HARDWARE INITIALIZATION HELPERS & EVENT LOGGING
// --------------------------------------------------------------------------------------
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[ESP32-S3] Connecting to WiFi '%s'...", WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[ESP32-S3] WiFi Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[ESP32-S3] WiFi Connection Timeout! Proceeding in offline mode.");
  }
}

void initSIM800L() {
  Serial.println("[ESP32-S3] Initializing SIM800L Module...");
  SerialSIM.println("AT");
  if (waitForSIMResponse("OK", 2000)) {
    Serial.println("[ESP32-S3] SIM800L initialized and responsive.");
  } else {
    Serial.println("[ESP32-S3] WARNING: SIM800L module did not respond during setup.");
  }
}

void logEvent(const char* eventName) {
  Serial.printf("[EVENT LOG] [Timestamp: %lu ms] Event: %s\n", millis(), eventName);
}
