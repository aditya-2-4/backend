import os
# Ensure Ultralytics uses writable temp directory on Render
os.environ["YOLO_CONFIG_DIR"] = "/tmp/Ultralytics"

import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Header, HTTPException, Response
from fastapi.responses import JSONResponse, HTMLResponse
from ultralytics import YOLO
import cv2
import numpy as np
import requests

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-service")

SHARED_API_KEY = os.getenv("SHARED_API_KEY", "secure_esp32_device_shared_api_key_2026")
BACKEND_EVENT_URL = os.getenv("BACKEND_EVENT_URL", "https://backend-8-yt04.onrender.com/api/device/event")

# Global in-memory storage for YOLO model and latest annotated frame
model = None
latest_frame_bytes = None

def get_model():
    global model
    if model is None:
        logger.info("Initializing YOLO model (yolo11n.pt)...")
        try:
            model = YOLO("yolo11n.pt")
            logger.info("YOLO model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load YOLO model: {e}")
            raise e
    return model

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Application starting up...")
    try:
        get_model()
    except Exception as e:
        logger.warning(f"Model initialization deferred to first request: {e}")
    yield

app = FastAPI(title="FarmGuard AI Detection Service", lifespan=lifespan)

HIGH_CONFIDENCE_CLASSES = {"person", "cow", "dog", "cat", "horse", "sheep", "Human", "Cow / Cattle"}

LABEL_MAPPINGS = {
    "person": "Human",
    "cow": "Cow / Cattle",
}

@app.get("/")
def health_check(request: Request):
    accept_header = request.headers.get("accept", "")
    if "application/json" in accept_header and "text/html" not in accept_header:
        return {"status": "ok"}
    
    return HTMLResponse("""
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>FarmGuard AI Detection Microservice</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0f0d; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .container { background: #121a16; border: 1px solid #1e2d24; border-radius: 16px; padding: 32px; max-width: 560px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
        .title { font-size: 22px; font-weight: 700; color: #fff; }
        .badge { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
        .pulse { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
        .card { background: #1a2620; border: 1px solid #24352b; padding: 16px; border-radius: 12px; }
        .label { font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
        .value { font-size: 15px; font-weight: 600; color: #f8fafc; font-family: monospace; }
        .actions { display: flex; flex-direction: column; gap: 12px; }
        .btn { display: flex; align-items: center; justify-content: center; text-decoration: none; padding: 14px; border-radius: 10px; font-weight: 600; font-size: 14px; transition: all 0.2s; }
        .btn-primary { background: #10b981; color: #042f1a; }
        .btn-primary:hover { background: #34d399; }
        .btn-secondary { background: #1e2d24; color: #cbd5e1; border: 1px solid #2e4336; }
        .btn-secondary:hover { background: #283c30; color: #fff; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 class="title">FarmGuard AI Service</h1>
          <div class="badge"><div class="pulse"></div>ONLINE</div>
        </div>
        <div class="grid">
          <div class="card"><div class="label">YOLO Model</div><div class="value">yolo11n.pt</div></div>
          <div class="card"><div class="label">Service Status</div><div class="value" style="color: #10b981;">HEALTHY</div></div>
          <div class="card"><div class="label">Detection Endpoint</div><div class="value">POST /detect</div></div>
          <div class="card"><div class="label">Latest Frame</div><div class="value">GET /latest-frame</div></div>
        </div>
        <div class="actions">
          <a href="/latest-frame" class="btn btn-primary" target="_blank">View Latest Frame Camera Image</a>
          <a href="https://backend-8-yt04.onrender.com" class="btn btn-secondary">Open Main Gateway API</a>
        </div>
      </div>
    </body>
    </html>
    """)

@app.get("/latest-frame")
def get_latest_frame():
    global latest_frame_bytes
    if latest_frame_bytes is None:
        return HTMLResponse("""
        <!DOCTYPE html>
        <html>
        <body style="background:#0a0f0d; color:#fff; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh;">
          <div style="text-align:center; padding:20px; border:1px solid #1e2d24; border-radius:12px; background:#121a16;">
            <h2>No Camera Frame Captured Yet</h2>
            <p style="color:#94a3b8; margin-top:10px;">Send a POST /detect request with a JPEG image payload to populate this frame buffer.</p>
          </div>
        </body>
        </html>
        """, status_code=404)
    return Response(content=latest_frame_bytes, media_type="image/jpeg")

@app.post("/detect")
async def detect_objects(
    request: Request,
    x_api_key: str = Header(None, alias="x-api-key")
):
    global latest_frame_bytes

    if not x_api_key or x_api_key != SHARED_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized device key access")

    raw_body = await request.body()
    if not raw_body:
        raise HTTPException(status_code=400, detail="Empty image body")

    # Decode raw JPEG bytes into OpenCV image matrix
    np_arr = np.frombuffer(raw_body, np.uint8)
    image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid JPEG image payload")

    try:
        active_model = get_model()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"YOLO model initialization error: {e}")

    # Run YOLO detection
    results = active_model(image)

    detections = []
    annotated_img = image.copy()

    if len(results) > 0:
        result = results[0]
        annotated_img = result.plot()

        boxes = result.boxes
        if boxes is not None:
            for box in boxes:
                cls_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                raw_class_name = result.names.get(cls_id, str(cls_id)).lower()

                label = LABEL_MAPPINGS.get(raw_class_name, raw_class_name)
                threshold = 0.55 if (raw_class_name in HIGH_CONFIDENCE_CLASSES or label in HIGH_CONFIDENCE_CLASSES) else 0.50

                if confidence >= threshold:
                    detections.append({
                        "label": label,
                        "confidence": round(confidence, 4)
                    })

                    # Dispatch event to Node.js backend
                    iso_timestamp = datetime.now(timezone.utc).isoformat()
                    event_payload = {
                        "detection_type": label,
                        "zone_name": "Camera-01",
                        "timestamp": iso_timestamp
                    }
                    try:
                        resp = requests.post(
                            BACKEND_EVENT_URL,
                            json=event_payload,
                            headers={"x-api-key": SHARED_API_KEY},
                            timeout=5
                        )
                        logger.info(f"Dispatched event '{label}' to backend, status: {resp.status_code}")
                    except Exception as e:
                        logger.error(f"Failed to post detection event to backend: {e}")

    # Store latest annotated frame in memory as JPEG bytes
    success, encoded_img = cv2.imencode(".jpg", annotated_img)
    if success:
        latest_frame_bytes = encoded_img.tobytes()

    return JSONResponse(content={"detections": detections})
