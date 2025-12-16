# Backend Setup Instructions

## Required Files

You need to copy the following files from your working backend to this directory:

1. **YOLOv4 Weights** (choose one):
   - `yolov4.weights` (246MB) - Full model, more accurate
   - `yolov4-tiny.weights` (23MB) - Faster, less accurate

2. **YOLOv4 Config** (already copied):
   - `yolov4.cfg` or `yolov4-tiny.cfg`

3. **COCO Names** (already copied):
   - `coco.names`

## Copy Commands

From your working backend directory, run:

```bash
# Copy weights (choose one)
copy yolov4.weights C:\Users\Rohit\Downloads\minor\backend-yolo\
# OR
copy yolov4-tiny.weights C:\Users\Rohit\Downloads\minor\backend-yolo\
```

Or manually copy:
- `yolov4.weights` or `yolov4-tiny.weights` → `backend-yolo/`
- The config and names files are already copied

## Python Dependencies

Install required packages:

```bash
pip install opencv-python numpy scipy
```

## Testing

After copying the weights, test the detection:

```bash
cd backend-yolo
python processor/yolov4_detect.py --input test_video.mp4 --output output.mp4 --lane north
```

## Notes

- The system will automatically use `yolov4-tiny.weights` if `yolov4.weights` is not found
- Processing time depends on video length and model size
- Full YOLOv4 is more accurate but slower
- Tiny YOLOv4 is faster but less accurate

