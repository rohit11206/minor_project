import cv2
import numpy as np
import sys
import json
import os

# Load YOLO model - look in parent directory (backend-yolo root)
backend_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
weights_path = os.path.join(backend_root, "yolov4.weights")
cfg_path = os.path.join(backend_root, "yolov4.cfg")
names_path = os.path.join(backend_root, "coco.names")

# Fallback to tiny if full weights don't exist
if not os.path.exists(weights_path):
    weights_path = os.path.join(backend_root, "yolov4-tiny.weights")
    cfg_path = os.path.join(backend_root, "yolov4-tiny.cfg")

# Check if files exist
if not os.path.exists(weights_path):
    raise Exception(f"YOLO weights not found at {weights_path}. Please copy yolov4.weights or yolov4-tiny.weights to backend-yolo directory.")
if not os.path.exists(cfg_path):
    raise Exception(f"YOLO config not found at {cfg_path}. Please copy yolov4.cfg or yolov4-tiny.cfg to backend-yolo directory.")
if not os.path.exists(names_path):
    raise Exception(f"COCO names file not found at {names_path}. Please copy coco.names to backend-yolo directory.")

try:
    net = cv2.dnn.readNet(weights_path, cfg_path)
    layer_names = net.getLayerNames()
    output_layers = [layer_names[i - 1] for i in net.getUnconnectedOutLayers()]
except Exception as e:
    raise Exception(f"Failed to load YOLO model: {str(e)}")

# Load COCO class labels
try:
    with open(names_path, "r") as f:
        classes = [line.strip() for line in f.readlines()]
except Exception as e:
    raise Exception(f"Failed to load COCO names: {str(e)}")

def detect_cars(video_path, output_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Error: Could not open video {video_path}")

    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps == 0:
        fps = 20.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Setup video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    total_cars = 0
    vehicle_counts = {"car": 0, "bus": 0, "truck": 0, "motorbike": 0}
    sample_detections = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        height_frame, width_frame, _ = frame.shape

        # Create blob from frame
        blob = cv2.dnn.blobFromImage(frame, 0.00392, (416, 416), (0, 0, 0), True, crop=False)
        net.setInput(blob)
        outs = net.forward(output_layers)

        class_ids, confidences, boxes = [], [], []

        for out in outs:
            for detection in out:
                scores = detection[5:]
                class_id = np.argmax(scores)
                confidence = scores[class_id]

                # Detect vehicles: car, bus, truck, motorbike with confidence > 0.5
                if class_id < len(classes) and classes[class_id] in ["car", "bus", "truck", "motorbike"] and confidence > 0.5:
                    try:
                        center_x = int(detection[0] * width_frame)
                        center_y = int(detection[1] * height_frame)
                        w = int(detection[2] * width_frame)
                        h = int(detection[3] * height_frame)

                        if any([np.isnan(center_x), np.isnan(center_y), np.isnan(w), np.isnan(h),
                                np.isinf(center_x), np.isinf(center_y), np.isinf(w), np.isinf(h)]):
                            continue

                        x = int(center_x - w / 2)
                        y = int(center_y - h / 2)

                        boxes.append([x, y, w, h])
                        confidences.append(float(confidence))
                        class_ids.append(class_id)
                    except Exception:
                        continue

        indexes = cv2.dnn.NMSBoxes(boxes, confidences, 0.5, 0.4)

        for i in range(len(boxes)):
            if i in indexes:
                x, y, w, h = boxes[i]
                label = str(classes[class_ids[i]])
                confidence = confidences[i]
                color = (255, 0, 0)  # Blue boxes as requested

                cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
                cv2.putText(frame, f"{label} {int(confidence * 100)}%",
                            (x, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

                # Count vehicles
                if label in vehicle_counts:
                    vehicle_counts[label] += 1
                total_cars += 1

                # Store sample detections
                if len(sample_detections) < 20:
                    sample_detections.append({
                        "label": label,
                        "confidence": round(confidence, 2),
                        "bbox": {
                            "top": round(y / height_frame * 100, 2),
                            "left": round(x / width_frame * 100, 2),
                            "width": round(w / width_frame * 100, 2),
                            "height": round(h / height_frame * 100, 2)
                        }
                    })

        writer.write(frame)

    cap.release()
    writer.release()
    
    return total_cars, vehicle_counts, sample_detections

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lane", required=True)
    args = parser.parse_args()

    try:
        if not os.path.exists(args.input):
            raise Exception(f"Input video not found: {args.input}")
        
        print(f"Processing video: {args.input}", file=sys.stderr)
        print(f"Output will be saved to: {args.output}", file=sys.stderr)
        
        total_cars, vehicle_counts, detections = detect_cars(args.input, args.output)
        
        if not os.path.exists(args.output):
            raise Exception(f"Output video was not created: {args.output}")
        
        data = {
            "lane": args.lane,
            "processed_video": os.path.basename(args.output),
            "vehicle_counts": vehicle_counts,
            "total_vehicles": total_cars,
            "load_score": total_cars,
            "phase": "green" if total_cars >= 15 else "amber" if total_cars >= 8 else "red",
            "sample_detections": detections
        }
        
        print(json.dumps(data))
        print(f"Successfully processed: {total_cars} vehicles detected", file=sys.stderr)
    except Exception as e:
        error_msg = f"Error in YOLOv4 detection: {str(e)}"
        print(error_msg, file=sys.stderr)
        print(json.dumps({"error": error_msg}), file=sys.stderr)
        sys.exit(1)

