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

# Safe decorator fallback for ZeroGPU vs CPU Basic spaces
try:
    import spaces
    gpu_decorator = spaces.GPU
except Exception:
    def gpu_decorator(func):
        return func

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("farmguard-ai-hf")

SHARED_API_KEY = os.getenv("SHARED_API_KEY", "secure_esp32_device_shared_api_key_2026")
BACKEND_EVENT_URL = os.getenv("BACKEND_EVENT_URL", "https://backend-8-yt04.onrender.com/api/device/event")

# Load YOLO model once at startup
logger.info("Initializing high-accuracy YOLO model (yolo11n.pt)...")
model = YOLO("yolo11n.pt")
logger.info("YOLO model loaded successfully.")

latest_annotated_frame = None

HIGH_CONFIDENCE_CLASSES = {"person", "cow", "dog", "cat", "horse", "sheep", "Human", "Cow / Cattle"}

LABEL_MAPPINGS = {
    "person": "Human",
    "cow": "Cow / Cattle",
}

COCO_80_CLASSES = {
    "person": "Human",
    "bicycle": "Bicycle",
    "car": "Car",
    "motorcycle": "Motorcycle",
    "airplane": "Airplane",
    "bus": "Bus",
    "train": "Train",
    "truck": "Truck",
    "boat": "Boat",
    "traffic light": "Traffic Light",
    "fire hydrant": "Fire Hydrant",
    "stop sign": "Stop Sign",
    "parking meter": "Parking Meter",
    "bench": "Bench",
    "bird": "Bird",
    "cat": "Cat",
    "dog": "Dog",
    "horse": "Horse",
    "sheep": "Sheep",
    "cow": "Cow / Cattle",
    "elephant": "Elephant",
    "bear": "Bear",
    "zebra": "Zebra",
    "giraffe": "Giraffe",
    "backpack": "Backpack",
    "umbrella": "Umbrella",
    "handbag": "Handbag",
    "tie": "Tie",
    "suitcase": "Suitcase",
    "frisbee": "Frisbee",
    "skis": "Skis",
    "snowboard": "Snowboard",
    "sports ball": "Sports Ball",
    "kite": "Kite",
    "baseball bat": "Baseball Bat",
    "baseball glove": "Baseball Glove",
    "skateboard": "Skateboard",
    "surfboard": "Surfboard",
    "tennis racket": "Tennis Racket",
    "bottle": "Bottle",
    "wine glass": "Wine Glass",
    "cup": "Cup",
    "fork": "Fork",
    "knife": "Knife",
    "spoon": "Spoon",
    "bowl": "Bowl",
    "banana": "Banana",
    "apple": "Apple",
    "sandwich": "Sandwich",
    "orange": "Orange",
    "broccoli": "Broccoli",
    "carrot": "Carrot",
    "hot dog": "Hot Dog",
    "pizza": "Pizza",
    "donut": "Donut",
    "cake": "Cake",
    "chair": "Chair",
    "couch": "Couch",
    "potted plant": "Potted Plant",
    "bed": "Bed",
    "dining table": "Dining Table",
    "toilet": "Toilet",
    "tv": "TV / Monitor",
    "laptop": "Laptop",
    "mouse": "Computer Mouse",
    "remote": "Remote Control",
    "keyboard": "Keyboard",
    "cell phone": "Mobile Phone",
    "microwave": "Microwave",
    "oven": "Oven",
    "toaster": "Toaster",
    "sink": "Sink",
    "refrigerator": "Refrigerator",
    "book": "Book",
    "clock": "Clock",
    "vase": "Vase",
    "scissors": "Scissors",
    "teddy bear": "Teddy Bear",
    "hair drier": "Hair Drier",
    "toothbrush": "Toothbrush"
}

def process_detection(image):
    global latest_annotated_frame
    results = model(image, conf=0.35, iou=0.45)
    detections = []
    annotated_bgr = image.copy()

    if len(results) > 0:
        result = results[0]
        annotated_bgr = result.plot(conf=True, line_width=2)

        boxes = result.boxes
        if boxes is not None:
            for box in boxes:
                cls_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                raw_class_name = result.names.get(cls_id, str(cls_id)).lower()

                label = LABEL_MAPPINGS.get(raw_class_name, COCO_80_CLASSES.get(raw_class_name, raw_class_name.capitalize()))
                threshold = 0.35 if (raw_class_name in HIGH_CONFIDENCE_CLASSES or label in HIGH_CONFIDENCE_CLASSES) else 0.35

                if confidence >= threshold:
                    conf_pct = f"{round(confidence * 100, 1)}%"
                    detections.append({
                        "label": label,
                        "confidence_score": round(confidence, 4),
                        "confidence_percentage": conf_pct
                    })

                    iso_timestamp = datetime.now(timezone.utc).isoformat()
                    event_payload = {
                        "detection_type": label,
                        "confidence": conf_pct,
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
                        logger.info(f"Dispatched event '{label}' ({conf_pct}) to backend, status: {resp.status_code}")
                    except Exception as e:
                        logger.error(f"Failed to post detection event to backend: {e}")

    annotated_rgb = cv2.cvtColor(annotated_bgr, cv2.COLOR_BGR2RGB)
    latest_annotated_frame = annotated_rgb
    return detections, annotated_rgb

@gpu_decorator
def predict_gradio(input_image, api_key: str = ""):
    if api_key and api_key != SHARED_API_KEY:
        return {"error": "Unauthorized device key access"}, None

    if input_image is None:
        return {"error": "No image payload provided"}, None

    if isinstance(input_image, str):
        image = cv2.imread(input_image)
    elif isinstance(input_image, np.ndarray):
        image = cv2.cvtColor(input_image, cv2.COLOR_RGB2BGR)
    else:
        np_arr = np.frombuffer(input_image, np.uint8)
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    if image is None:
        return {"error": "Invalid JPEG image payload"}, None

    detections, annotated_rgb = process_detection(image)
    return {"total_detected": len(detections), "detections": detections}, annotated_rgb

def get_latest_frame():
    global latest_annotated_frame
    if latest_annotated_frame is None:
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        img[:] = (20, 26, 18)
        cv2.putText(img, "FARMGUARD AI - WAITING FOR CAMERA FEED", (60, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (16, 185, 129), 2)
        return img
    return latest_annotated_frame

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
    # 🛡️ FarmGuard High-Accuracy AI Detection Service
    ### High-Performance 104GB RAM Microservice
    """)

    with gr.Tabs():
        with gr.TabItem("📷 Live Latest Frame"):
            with gr.Column():
                latest_image_view = gr.Image(value=get_latest_frame, label="Latest Camera Detection Frame", interactive=False)
                refresh_btn = gr.Button("🔄 Refresh Latest Frame", variant="primary")
                refresh_btn.click(fn=get_latest_frame, outputs=latest_image_view, api_name="latest_frame")

        with gr.TabItem("🧪 Test High-Accuracy Detection"):
            with gr.Row():
                with gr.Column():
                    test_input = gr.Image(type="numpy", label="Upload JPEG Image")
                    api_key_input = gr.Textbox(value=SHARED_API_KEY, label="Device API Key", type="password")
                    detect_btn = gr.Button("🚀 Run High-Precision Detection", variant="primary")
                with gr.Column():
                    json_output = gr.JSON(label="High-Accuracy Detections Output")
                    annotated_output = gr.Image(label="Annotated Image Output")

            detect_btn.click(
                fn=predict_gradio,
                inputs=[test_input, api_key_input],
                outputs=[json_output, annotated_output],
                api_name="predict"
            )

demo.queue().launch(theme=custom_theme)
