import os
os.environ["YOLO_CONFIG_DIR"] = "/tmp"

import time
import logging
from datetime import datetime, timezone

import requests
import cv2
import numpy as np
from ultralytics import YOLO
import gradio as gr
import spaces

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("farmguard-ai-hf")

SHARED_API_KEY = os.getenv("SHARED_API_KEY", "secure_esp32_device_shared_api_key_2026")
BACKEND_EVENT_URL = os.getenv("BACKEND_EVENT_URL", "https://backend-8-yt04.onrender.com/api/device/event")

# Load YOLO model once at startup
logger.info("Initializing YOLO model (yolo11n.pt)...")
model = YOLO("yolo11n.pt")
logger.info("YOLO model loaded successfully.")

# Global storage for latest annotated camera frame
latest_annotated_frame = None

HIGH_CONFIDENCE_CLASSES = {"person", "cow", "dog", "cat", "horse", "sheep", "Human", "Cow / Cattle"}

LABEL_MAPPINGS = {
    "person": "Human",
    "cow": "Cow / Cattle",
}

@spaces.GPU
def detect_objects_api(input_image, api_key: str = ""):
    global latest_annotated_frame

    if api_key and api_key != SHARED_API_KEY:
        return {"error": "Unauthorized device key access"}, None

    if input_image is None:
        return {"error": "No image payload provided"}, None

    # Handle image format input (numpy array, string path, or file bytes)
    if isinstance(input_image, str):
        image = cv2.imread(input_image)
    elif isinstance(input_image, np.ndarray):
        # Gradio passes RGB numpy array, convert to BGR for OpenCV
        image = cv2.cvtColor(input_image, cv2.COLOR_RGB2BGR)
    else:
        np_arr = np.frombuffer(input_image, np.uint8)
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    if image is None:
        return {"error": "Invalid JPEG image payload"}, None

    # Run YOLO detection
    results = model(image)

    detections = []
    annotated_bgr = image.copy()

    if len(results) > 0:
        result = results[0]
        annotated_bgr = result.plot()

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
                            timeout=4
                        )
                        logger.info(f"Dispatched event '{label}' to backend, status: {resp.status_code}")
                    except Exception as e:
                        logger.error(f"Failed to post detection event to backend: {e}")

    # Convert annotated frame back to RGB for Gradio UI display
    annotated_rgb = cv2.cvtColor(annotated_bgr, cv2.COLOR_BGR2RGB)
    latest_annotated_frame = annotated_rgb

    return {"detections": detections}, annotated_rgb

def get_latest_frame():
    global latest_annotated_frame
    if latest_annotated_frame is None:
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        img[:] = (20, 26, 18)
        cv2.putText(img, "FARMGUARD AI - WAITING FOR CAMERA FEED", (60, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (16, 185, 129), 2)
        return img
    return latest_annotated_frame

# Gradio Custom Interface Theme
custom_theme = gr.themes.Soft(
    primary_hue="emerald",
    neutral_hue="slate",
).set(
    body_background_fill="#0a0f0d",
    block_background_fill="#121a16",
    block_border_color="#1e2d24",
)

with gr.Blocks() as demo:
    gr.Markdown("""
    # 🛡️ FarmGuard AI Detection Service
    ### High-Performance ZeroGPU YOLO11 Object & Face Detection Microservice
    """)

    with gr.Tabs():
        with gr.TabItem("📷 Live Latest Frame"):
            with gr.Column():
                latest_image_view = gr.Image(value=get_latest_frame, label="Latest Camera Detection Frame", interactive=False)
                refresh_btn = gr.Button("🔄 Refresh Latest Frame", variant="primary")
                refresh_btn.click(fn=get_latest_frame, outputs=latest_image_view, api_name="latest_frame")

        with gr.TabItem("🧪 Test Object Detection"):
            with gr.Row():
                with gr.Column():
                    test_input = gr.Image(type="numpy", label="Upload JPEG Image")
                    api_key_input = gr.Textbox(value=SHARED_API_KEY, label="Device API Key", type="password")
                    detect_btn = gr.Button("🚀 Run YOLO Detection", variant="primary")
                with gr.Column():
                    json_output = gr.JSON(label="Detections JSON Output")
                    annotated_output = gr.Image(label="Annotated Image Output")

            detect_btn.click(
                fn=detect_objects_api,
                inputs=[test_input, api_key_input],
                outputs=[json_output, annotated_output],
                api_name="detect"
            )

        with gr.TabItem("⚙️ API Integration Guide"):
            gr.Markdown("""
            ### 📡 ESP32-CAM & Client Device Access

            - **Space URL**: `https://adiityamishra99-farmguard-ai-detection.hf.space`
            - **Detection Endpoint**: `api_name="detect"`
            - **Latest Frame Endpoint**: `api_name="latest_frame"`

            #### Python Client Example:
            ```python
            from gradio_client import Client, handle_file

            client = Client("adiityamishra99/farmguard-ai-detection")
            result = client.predict(
                input_image=handle_file('camera_snapshot.jpg'),
                api_key="secure_esp32_device_shared_api_key_2026",
                api_name="/detect"
            )
            print(result)
            ```
            """)

if __name__ == "__main__":
    demo.queue().launch(theme=custom_theme)
