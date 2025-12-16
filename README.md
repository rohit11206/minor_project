# AI-Powered Smart Traffic Management System

## Overview

This project implements an intelligent traffic signal control system that uses **YOLO V8** (You Only Look Once version 8) for real-time vehicle detection and adaptive traffic light management. The system dynamically adjusts traffic signal timings based on real-time vehicle counts from four approach lanes (North, South, East, West) to optimize traffic flow and reduce congestion.

## Architecture

The system follows a client-server architecture with the following components:

### Frontend (React + Vite)
- **Location**: `traffic-management/`
- **Technology**: React 19, Vite 7
- **Features**:
  - Real-time dashboard displaying four traffic camera feeds
  - Video upload interface for each approach lane
  - Live vehicle count visualization with bounding boxes
  - Dynamic traffic signal timing display
  - Phase timeline showing signal changes

### Backend (Node.js + Express)
- **Location**: `backend-yolo/`
- **Technology**: Node.js, Express, Multer
- **Features**:
  - RESTful API for video upload and processing
  - Job queue management for YOLO processing
  - Signal timing calculation based on vehicle distribution
  - Static file serving for processed videos

### Video Processor (Python)
- **Location**: `backend-yolo/processor/process_video.py`
- **Technology**: Python, OpenCV, Ultralytics YOLO
- **Features**:
  - YOLO V8 inference on uploaded videos
  - Vehicle detection and classification
  - Bounding box annotation (blue boxes)
  - Processed video generation with overlays

## Methodology

### 1. Computer Vision Pipeline

#### YOLO V8 Model
- **Purpose**: Real-time object detection and classification
- **Classes Detected**:
  - Bicycle
  - Bus
  - Car
  - Jeep
  - Pedestrian
  - Truck

#### Object Recognition and Counting Module (ORCM)
The ORCM algorithm processes YOLO detection results to:
1. **Track vehicles** across video frames using bounding box overlap analysis
2. **Count vehicles** by monitoring entry/exit events in the detection zone
3. **Classify vehicles** into predefined categories
4. **Generate metadata** including:
   - Total vehicle count per lane
   - Per-class vehicle counts
   - Bounding box coordinates
   - Detection confidence scores

#### Video Processing Workflow
1. **Upload**: User uploads video for a specific lane (North/South/East/West)
2. **Storage**: Video is saved to `backend-yolo/uploads/<lane>/`
3. **Processing**: Python processor runs YOLO inference:
   - Processes each frame
   - Detects and classifies vehicles
   - Draws blue bounding boxes around detected vehicles
   - Tracks vehicle counts
4. **Output**: Processed video saved to `backend-yolo/processed/<lane>-<jobId>.mp4`
5. **Metadata**: JSON response with vehicle counts, detections, and timing recommendations

### 2. Traffic Signal Control Logic

#### Signal Timing Calculation
The system uses a **proportional allocation** method based on vehicle distribution:

```
Green Time (lane) = (Vehicle Count (lane) / Total Vehicles) × Cycle Time
```

Where:
- **Cycle Time**: 120 seconds (2 minutes) - configurable
- **Total Vehicles**: Sum of all vehicles across all four lanes
- **Red Time**: Cycle Time - Green Time

#### Example Calculation
Given vehicle counts:
- North: 24 vehicles
- East: 36 vehicles
- West: 20 vehicles
- South: 10 vehicles
- **Total**: 90 vehicles

Signal timings:
- **North**: (24/90) × 120 = 32 seconds green, 88 seconds red
- **East**: (36/90) × 120 = 48 seconds green, 72 seconds red
- **West**: (20/90) × 120 = 27 seconds green, 93 seconds red
- **South**: (10/90) × 120 = 13 seconds green, 107 seconds red

#### Adaptive Control Features
- **Real-time adjustment**: Signal timings update as new vehicle counts are processed
- **Priority handling**: Lanes with higher vehicle counts receive longer green phases
- **Congestion mitigation**: System automatically allocates more time to congested lanes
- **Dynamic response**: Adapts to changing traffic patterns throughout the day

### 3. Traffic Delay Time Calculation

The system can calculate junction traffic delay times using the formula:

```
Wt = (Na / (2 × Ml)) × (1 - (1 + (2 × Ml / Vn)))
```

Where:
- **Wt**: Waiting time due to traffic (seconds)
- **Na**: Number of vehicles arriving in a specific time interval
- **Ml**: Mean length of vehicles (meters)
- **Vn**: Number of vehicles passing through the junction in a given time

This formula helps predict and minimize waiting times at intersections.

### 4. Hardware Considerations

#### Raspberry Pi 4B Deployment
The system is designed to run on Raspberry Pi 4B single-board computers:
- **CPU**: Quad-core ARM Cortex-A72
- **GPU**: VideoCore VI (capable of ML acceleration)
- **Use Case**: Edge computing at traffic intersections
- **Advantages**:
  - Low power consumption
  - Cost-effective deployment
  - Suitable for IoT applications
  - Real-time processing capability

#### Camera Requirements
- **NoIR (No Infrared) Cameras** recommended for:
  - Low-light performance
  - Reduced glare from headlights
  - Better visibility in foggy/hazy conditions
  - Enhanced license plate recognition
- **CSI Protocol**: Direct connection to Raspberry Pi
- **Resolution**: Optimized for real-time processing (typically 720p)

### 5. Communication Protocol

#### Current Implementation
- **HTTP/REST**: Direct communication between frontend and backend
- **WebSocket**: Real-time updates (optional enhancement)

#### Future Enhancement: LoRaWAN
The system architecture supports integration with **Long Range Wide Area Network (LoRaWAN)**:
- **Range**: 5-10 kilometers
- **Use Case**: Connecting multiple traffic signals across a city
- **Benefits**:
  - Low power consumption
  - Long-range connectivity
  - Suitable for IoT deployments
  - Centralized traffic management

## System Design

### Data Flow

```
┌─────────────┐
│   Camera    │ (NoIR Camera captures traffic)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Video      │ (Upload to backend)
│  Upload     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  YOLO V8    │ (Object detection & classification)
│  Processor  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  ORCM       │ (Vehicle counting & tracking)
│  Module     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Traffic    │ (Signal timing calculation)
│  Management │
│  Logic      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Signal     │ (Green/Red timing allocation)
│  Controller │
└─────────────┘
```

### Component Interaction

1. **Frontend → Backend**: Video upload via `POST /api/upload-video`
2. **Backend → Processor**: Spawns Python process for YOLO inference
3. **Processor → Backend**: Returns JSON with vehicle counts and metadata
4. **Backend → Frontend**: Serves processed video and traffic state via `GET /api/traffic-state`
5. **Frontend**: Displays processed video with bounding boxes and signal timings

### Database Schema (In-Memory)

```javascript
cameraState = {
  [lane]: {
    status: 'idle' | 'processing' | 'ready' | 'error',
    phase: 'idle' | 'red' | 'amber' | 'green',
    totalVehicles: number,
    laneCounts: { [class]: count },
    detections: [{
      id: string,
      label: string,
      confidence: number,
      bbox: { top, left, width, height }
    }],
    videoUrl: string | null,
    greenSeconds: number,
    redSeconds: number,
    lastProcessedAt: ISO8601,
    startedAt: ISO8601
  }
}
```

## Installation & Setup

### Prerequisites
- Node.js 20+ and npm
- Python 3.8+
- OpenCV (`pip install opencv-python`)
- Ultralytics YOLO (`pip install ultralytics`) - optional, falls back to simulation

### Backend Setup

```bash
cd backend-yolo
npm install
```

### Frontend Setup

```bash
cd traffic-management
npm install
```

### Environment Variables

**Backend** (`backend-yolo/.env`):
```
PORT=4000
PROCESSING_DELAY_MS=120000
USE_PYTHON_PROCESSOR=true
CYCLE_SECONDS=120
```

**Frontend** (`traffic-management/.env`):
```
VITE_API_BASE=http://localhost:4000
```

## Usage

### Starting the System

1. **Start Backend**:
   ```bash
   cd backend-yolo
   npm run dev
   ```

2. **Start Frontend**:
   ```bash
   cd traffic-management
   npm run dev
   ```

3. **Access Dashboard**:
   - Open browser to `http://localhost:5173` (or port shown by Vite)

### Workflow

1. **Upload Videos**: Upload traffic videos for each of the four lanes (North, South, East, West)
2. **Processing**: Backend processes each video with YOLO (typically 2 minutes per video)
3. **View Results**: Processed videos with blue bounding boxes appear in the dashboard
4. **Signal Timing**: System automatically calculates and displays optimal green/red timings
5. **Monitor**: Track vehicle counts, signal phases, and timeline of changes

## Performance Metrics

Based on research paper benchmarks (YOLO V8 on Raspberry Pi 4B):

| Class | Accuracy | Precision | Recall | F1 Score |
|-------|----------|-----------|--------|----------|
| Bicycle | 95.38% | 95.28% | 97.37% | 96.32% |
| Bus | 94.22% | 97.80% | 96.52% | 97.15% |
| Car | 95.66% | 97.35% | 95.65% | 96.50% |
| Jeep | 95.38% | 97.87% | 96.84% | 97.35% |
| Pedestrian | 96.24% | 98.71% | 96.64% | 97.66% |
| Truck | 97.96% | 98.73% | 97.29% | 98.00% |
| **Average** | **95.81%** | **97.62%** | **96.72%** | **97.16%** |

## Future Enhancements

1. **LoRaWAN Integration**: Connect multiple intersections for city-wide traffic management
2. **Environmental Sensors**: Integrate CO2, PM 2.5, temperature, humidity sensors
3. **Emergency Vehicle Priority**: Automatic signal adjustment for emergency vehicles
4. **Machine Learning Optimization**: Learn from historical traffic patterns
5. **Real-time Streaming**: Direct camera feed processing (RTSP support)
6. **Mobile App**: Traffic monitoring and control via mobile application

## Research Reference

This implementation is based on research published in IEEE, focusing on:
- Computer vision-assisted AI-enabled smart traffic control
- YOLO V8 for real-time vehicle detection
- Raspberry Pi 4B edge computing deployment
- Adaptive signal timing optimization
- LoRaWAN for IoT traffic management

## License

This project is developed for research and educational purposes.

## Contributors

Developed as part of a smart traffic management research project.

#   m i n o r _ p r o j e c t -  
 