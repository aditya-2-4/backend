import os
import sys
import time
import requests
import cv2
import numpy as np

# Camera URL (local Wi-Fi IP)
CAMERA_URL = os.getenv("CAMERA_URL", "http://10.14.51.170/cam-lo.jpg")
# Primary Backend detection service URL
AI_DETECT_URL = os.getenv("AI_DETECT_URL", "https://backend-8-yt04.onrender.com/detect")
# Hugging Face Space API URL
HF_SPACE_URL = os.getenv("HF_SPACE_URL", "https://adiityamishra99-farmguard-ai-detection.hf.space/api/predict")
API_KEY = os.getenv("SHARED_API_KEY", "secure_esp32_device_shared_api_key_2026")

print("==========================================================")
print(" OpenCV Camera-to-Cloud AI Stream Bridge Active")
print(f" Camera Source: {CAMERA_URL}")
print(f" Primary Target: {AI_DETECT_URL}")
print("==========================================================")

while True:
    try:
        # Fetch image snapshot from local camera IP
        resp = requests.get(CAMERA_URL, timeout=3)
        if resp.status_code == 200 and len(resp.content) > 0:
            # Decode image with OpenCV for validation and smooth encoding
            np_arr = np.frombuffer(resp.content, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is not None:
                # Re-encode frame to clean JPEG binary
                _, encoded_jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                jpeg_bytes = encoded_jpeg.tobytes()

                # Post frame to Cloud AI Detection Service
                ai_resp = requests.post(
                    AI_DETECT_URL,
                    data=jpeg_bytes,
                    headers={
                        "x-api-key": API_KEY,
                        "Content-Type": "image/jpeg"
                    },
                    timeout=5
                )

                if ai_resp.status_code == 200:
                    data = ai_resp.json()
                    count = len(data.get("detections", []))
                    print(f"[{time.strftime('%H:%M:%S')}] Frame sent -> Cloud AI | Detections: {count}")
                else:
                    print(f"[{time.strftime('%H:%M:%S')}] AI service response: {ai_resp.status_code}")
            else:
                print(f"[{time.strftime('%H:%M:%S')}] Received invalid image frame from camera")
        else:
            print(f"[{time.strftime('%H:%M:%S')}] Camera response HTTP {resp.status_code}")

    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] Retrying camera at {CAMERA_URL}... ({e})")

    time.sleep(1.0)
