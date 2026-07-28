import os
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Header, HTTPException, Response
from fastapi.responses import JSONResponse
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    logger.info("Loading YOLO model (yolo11n.pt)...")
    model = YOLO("yolo11n.pt")
    logger.info("YOLO model loaded successfully.")
    yield

app = FastAPI(title="FarmGuard AI Detection Service", lifespan=lifespan)

HIGH_CONFIDENCE_CLASSES = {"person", "cow", "dog", "cat", "horse", "sheep", "Human", "Cow / Cattle"}

LABEL_MAPPINGS = {
    "person": "Human",
    "cow": "Cow / Cattle",
}

@app.get("/")
def health_check():
    return {"status": "ok"}

@app.get("/latest-frame")
def get_latest_frame():
    global latest_frame_bytes
    if latest_frame_bytes is None:
        raise HTTPException(status_code=404, detail="No frame received yet")
    return Response(content=latest_frame_bytes, media_type="image/jpeg")

@app.post("/detect")
async def detect_objects(
    request: Request,
    x_api_key: str = Header(None, alias="x-api-key")
):
    global model, latest_frame_bytes

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

    if model is None:
        raise HTTPException(status_code=500, detail="YOLO model is not initialized")

    # Run YOLO detection
    results = model(image)

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
