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
logger.info("Initializing YOLO model (yolo11n.pt)...")
model = YOLO("yolo11n.pt")
logger.info("YOLO model loaded successfully.")

# Global storage for latest annotated camera frame
latest_annotated_frame = None

# Comprehensive 80-Class COCO mapping covering Humans, Animals, Electronics, Vehicles, and Tools
COCO_CLASSES_MAPPING = {
    "person": "Human / Person",
    "bicycle": "Bicycle",
    "car": "Car / Vehicle",
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
    "sheep": "Sheep / Livestock",
    "cow": "Cow / Cattle",
    "elephant": "Elephant",
    "bear": "Bear / Wild Animal",
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
    "cup": "Cup / Container",
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
    "couch": "Sofa / Couch",
    "potted plant": "Potted Plant",
    "bed": "Bed",
    "dining table": "Dining Table",
    "toilet": "Toilet",
    "tv": "TV / Monitor",
    "laptop": "Laptop / Computer",
    "mouse": "Computer Mouse",
    "remote": "Remote Control",
    "keyboard": "Keyboard",
    "cell phone": "Mobile Phone / Electronics",
    "microwave": "Microwave",
    "oven": "Oven",
    "toaster": "Toaster",
    "sink": "Sink",
    "refrigerator": "Refrigerator",
    "book": "Book",
    "clock": "Clock",
    "vase": "Vase",
    "scissors": "Scissors / Tool",
    "teddy bear": "Teddy Bear",
    "hair drier": "Hair Drier",
    "toothbrush": "Toothbrush"
}

@gpu_decorator
def detect_objects_api(input_image, api_key: str = "", conf_threshold: float = 0.25):
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

    # Run YOLO detection with conf threshold (supports 80 COCO categories)
    results = model(image, conf=conf_threshold)

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

                label = COCO_CLASSES_MAPPING.get(raw_class_name, raw_class_name.capitalize())

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

    return {"total_detected": len(detections), "detections": detections}, annotated_rgb

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
    # 🛡️ FarmGuard Multi-Object AI Detection Service
    ### High-Precision 80+ Category Object, Wild Animal, Human & Electronics Detection
    """)

    with gr.Tabs():
        with gr.TabItem("📷 Live Latest Frame"):
            with gr.Column():
                latest_image_view = gr.Image(value=get_latest_frame, label="Latest Camera Detection Frame", interactive=False)
                refresh_btn = gr.Button("🔄 Refresh Latest Frame", variant="primary")
                refresh_btn.click(fn=get_latest_frame, outputs=latest_image_view, api_name="latest_frame")

        with gr.TabItem("🧪 Test 80+ Category Detection"):
            with gr.Row():
                with gr.Column():
                    test_input = gr.Image(type="numpy", label="Upload JPEG Image")
                    conf_slider = gr.Slider(minimum=0.10, maximum=0.90, value=0.25, step=0.05, label="Detection Confidence Sensitivity")
                    api_key_input = gr.Textbox(value=SHARED_API_KEY, label="Device API Key", type="password")
                    detect_btn = gr.Button("🚀 Run YOLO 80+ Object Detection", variant="primary")
                with gr.Column():
                    json_output = gr.JSON(label="Detections JSON Output")
                    annotated_output = gr.Image(label="Annotated Image Output")

            detect_btn.click(
                fn=detect_objects_api,
                inputs=[test_input, api_key_input, conf_slider],
                outputs=[json_output, annotated_output],
                api_name="detect"
            )

        with gr.TabItem("📋 Supported 80 Categories"):
            gr.Markdown("""
            ### 🎯 80 Detected Object & Animal Categories:
            - 👨‍🌾 **Humans**: Person, Farmer, Visitor
            - 🐂 **Livestock & Animals**: Cow/Cattle, Sheep, Horse, Elephant, Bear, Dog, Cat, Bird, Zebra, Giraffe
            - 💻 **Electronics & Tech**: Mobile Phone, Laptop, Computer Mouse, TV/Monitor, Keyboard, Remote Control, Microwave, Oven, Toaster, Refrigerator, Clock
            - 🚗 **Vehicles & Transit**: Car, Truck, Bus, Motorcycle, Bicycle, Train, Boat, Airplane
            - 🛠️ **Tools & Outdoor Gear**: Backpack, Suitcase, Umbrella, Scissors/Tools, Potted Plant, Bottle, Cup, Chair, Sofa, Bed, Table
            """)

if __name__ == "__main__":
    demo.queue().launch(theme=custom_theme)
