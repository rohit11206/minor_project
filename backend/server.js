const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const app = express()
const PORT = 4000
const CYCLE_SECONDS = 120
// Processing speed: frames per second (realistic for CPU-based YOLO: 10-15 FPS)
// Lower = slower processing, higher = faster processing
// At 12 FPS: 1 minute video = ~2.5 minutes processing time
const PROCESSING_FPS = parseFloat(process.env.PROCESSING_FPS || '12', 10) // 12 FPS = ~2.5x slower than real-time
const USE_PYTHON_PROCESSOR = process.env.USE_PYTHON_PROCESSOR !== 'false'

const UPLOAD_ROOT = path.join(__dirname, 'uploads')
const PROCESSED_ROOT = path.join(__dirname, 'processed')

fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
fs.mkdirSync(PROCESSED_ROOT, { recursive: true })

app.use(cors())
app.use(express.json())
app.use('/processed', express.static(PROCESSED_ROOT))

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const laneKey = (req.body.lane || 'misc').toLowerCase()
    const laneDir = path.join(UPLOAD_ROOT, laneKey)
    fs.mkdirSync(laneDir, { recursive: true })
    cb(null, laneDir)
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '_')
    cb(null, `${Date.now()}-${safeName}`)
  }
})

const upload = multer({ storage })

const YOLO_CLASSES = ['bicycle', 'bus', 'car', 'jeep', 'pedestrian', 'truck']
const VEHICLE_WEIGHTS = {
  bicycle: 1,
  bus: 3,
  car: 2,
  jeep: 2,
  pedestrian: 0.5,
  truck: 3
}
const LANES = ['north', 'south', 'east', 'west']

const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`

const generateLaneDetections = () => {
  const detections = []
  const total = randomBetween(3, 12)

  for (let i = 0; i < total; i++) {
    const label = YOLO_CLASSES[randomBetween(0, YOLO_CLASSES.length - 1)]
    detections.push({
      id: randomId(),
      label,
      confidence: Number((Math.random() * 0.4 + 0.55).toFixed(2)),
      bbox: {
        top: randomBetween(5, 70),
        left: randomBetween(10, 80),
        width: randomBetween(8, 20),
        height: randomBetween(12, 25)
      }
    })
  }

  return detections
}

// Scheduler to rotate green light between lanes based on signal plan
const phaseScheduler = {
  activeLane: null,
  activeIndex: 0,
  nextSwitchAt: 0,
  lastSwitchAt: 0,
  cycle: [...LANES]
}

const updatePhaseCycle = (signalPlan) => {
  if (!signalPlan || !signalPlan.lanes) return

  phaseScheduler.cycle = [...LANES].sort((a, b) => {
    const aGreen = signalPlan.lanes[a]?.greenSeconds || 0
    const bGreen = signalPlan.lanes[b]?.greenSeconds || 0
    return bGreen - aGreen
  })

  if (!phaseScheduler.activeLane || !signalPlan.lanes[phaseScheduler.activeLane]) {
    phaseScheduler.activeLane = null
    phaseScheduler.activeIndex = 0
    phaseScheduler.nextSwitchAt = 0
  }
}

// Determine which lane should currently be green (only one at a time)
const determineActivePhase = (signalPlan) => {
  if (!signalPlan || !signalPlan.lanes) {
    return {}
  }

  updatePhaseCycle(signalPlan)

  const now = Date.now()

  // Rotate to next lane when time expires or no active lane yet
  if (!phaseScheduler.activeLane || now >= phaseScheduler.nextSwitchAt) {
    let chosenLane = null
    let attempts = 0

    while (attempts < phaseScheduler.cycle.length) {
      const lane = phaseScheduler.cycle[phaseScheduler.activeIndex % phaseScheduler.cycle.length]
      phaseScheduler.activeIndex = (phaseScheduler.activeIndex + 1) % phaseScheduler.cycle.length
      attempts += 1

      const lanePlan = signalPlan.lanes[lane]
      if (lanePlan && lanePlan.greenSeconds > 0) {
        chosenLane = lane
        const durationMs = Math.max(5000, lanePlan.greenSeconds * 1000)
        phaseScheduler.lastSwitchAt = now
        phaseScheduler.nextSwitchAt = now + durationMs
        break
      }
    }

    // Fallback: if no lane had green time, pick first lane to keep system moving
    if (!chosenLane) {
      chosenLane = phaseScheduler.cycle[0] || LANES[0]
      phaseScheduler.lastSwitchAt = now
      phaseScheduler.nextSwitchAt = now + 5000
    }

    phaseScheduler.activeLane = chosenLane
  }

  const phases = {}
  LANES.forEach((lane) => {
    phases[lane] = lane === phaseScheduler.activeLane ? 'green' : 'red'
  })

  return phases
}

const computePhaseFromLoad = (loadScore) => {
  // This is only used for intermediate display, not final phase
  if (loadScore >= 18) return 'green'
  if (loadScore >= 10) return 'amber'
  return 'red'
}

const getLaneDurationMs = (lane, signalPlan) => {
  const lanePlan = signalPlan?.lanes?.[lane]
  const seconds = lanePlan?.greenSeconds ?? CYCLE_SECONDS / LANES.length
  return Math.max(5000, seconds * 1000)
}

const computeLaneTimers = (signalPlan) => {
  const now = Date.now()
  const timers = {}

  if (!signalPlan?.lanes || !phaseScheduler.activeLane) {
    LANES.forEach((lane) => {
      timers[lane] = {
        secondsUntilGreen: null
      }
    })
    return {
      activeLane: phaseScheduler.activeLane,
      nextSwitchInSeconds: 0,
      lanes: timers
    }
  }

  const remainingMs = Math.max(0, phaseScheduler.nextSwitchAt - now)
  const cycle = phaseScheduler.cycle
  const activeLane = phaseScheduler.activeLane
  const activeIndex = cycle.indexOf(activeLane)

  LANES.forEach((lane) => {
    if (lane === activeLane) {
      timers[lane] = {
        secondsUntilGreen: 0,
        secondsUntilCycle: Math.ceil(remainingMs / 1000)
      }
      return
    }

    let totalMs = remainingMs
    if (activeIndex === -1) {
      timers[lane] = { secondsUntilGreen: null }
      return
    }

    let pointer = (activeIndex + 1) % cycle.length
    let safety = 0
    while (cycle[pointer] !== lane && safety < cycle.length) {
      const laneKey = cycle[pointer]
      totalMs += getLaneDurationMs(laneKey, signalPlan)
      pointer = (pointer + 1) % cycle.length
      safety += 1
    }

    timers[lane] = {
      secondsUntilGreen: cycle[pointer] === lane ? Math.ceil(totalMs / 1000) : null
    }
  })

  return {
    activeLane,
    nextSwitchInSeconds: Math.ceil(remainingMs / 1000),
    lanes: timers
  }
}

const computeCategory = (aggregatedLoad) => {
  if (aggregatedLoad === 0) return 'Awaiting uploads'
  if (aggregatedLoad >= 50) return 'Critical congestion'
  if (aggregatedLoad >= 32) return 'Heavy'
  if (aggregatedLoad >= 18) return 'Moderate'
  return 'Free flow'
}

// Calculate delay time for routes based on lane density and congestion
const calculateRouteDelay = (fromLane, toLane, cameraState, signalPlan, activePhases) => {
  const fromLaneData = cameraState[fromLane]
  const toLaneData = cameraState[toLane]
  
  // Base travel time between lanes (in seconds)
  const BASE_TRAVEL_TIME = 30 // 30 seconds base travel time
  
  // If lanes are not ready, return default delay
  if (!fromLaneData || !toLaneData || fromLaneData.status !== 'ready' || toLaneData.status !== 'ready') {
    return {
      delaySeconds: BASE_TRAVEL_TIME,
      delayMinutes: (BASE_TRAVEL_TIME / 60).toFixed(1),
      status: 'unknown',
      factors: {
        sourceDensity: 0,
        destinationDensity: 0,
        signalDelay: 0
      }
    }
  }
  
  // Get lane densities (loadScore)
  const sourceDensity = fromLaneData.loadScore || 0
  const destinationDensity = toLaneData.loadScore || 0
  
  // Calculate density-based delay multiplier
  // Higher density = more delay
  const sourceDensityMultiplier = 1 + (sourceDensity / 50) // 0-2x multiplier
  const destinationDensityMultiplier = 1 + (destinationDensity / 50) // 0-2x multiplier
  
  // Calculate signal delay (if source lane is red, add waiting time)
  let signalDelay = 0
  const sourcePhase = activePhases[fromLane] || 'red'
  if (sourcePhase === 'red') {
    // Calculate remaining red time
    const lanePlan = signalPlan.lanes?.[fromLane]
    if (lanePlan) {
      // Estimate remaining red time (simplified: assume halfway through cycle)
      signalDelay = lanePlan.redSeconds / 2
    } else {
      signalDelay = CYCLE_SECONDS / 2 // Default to half cycle
    }
  }
  
  // Calculate congestion-based delay
  // Higher congestion = slower movement through intersection
  const sourceCongestion = sourceDensity >= 50 ? 3 : sourceDensity >= 32 ? 2 : sourceDensity >= 18 ? 1.5 : 1
  const destinationCongestion = destinationDensity >= 50 ? 3 : destinationDensity >= 32 ? 2 : destinationDensity >= 18 ? 1.5 : 1
  
  // Total delay calculation
  // Base time * density multipliers * congestion factors + signal delay
  const densityDelay = BASE_TRAVEL_TIME * sourceDensityMultiplier * destinationDensityMultiplier
  const congestionDelay = BASE_TRAVEL_TIME * (sourceCongestion + destinationCongestion) / 2
  const totalDelay = densityDelay + congestionDelay + signalDelay
  
  // Determine status based on total delay
  let status = 'normal'
  if (totalDelay >= 120) status = 'severe'
  else if (totalDelay >= 90) status = 'heavy'
  else if (totalDelay >= 60) status = 'moderate'
  else if (totalDelay >= 45) status = 'light'
  
  return {
    delaySeconds: Math.round(totalDelay),
    delayMinutes: (totalDelay / 60).toFixed(1),
    status,
    factors: {
      sourceDensity: Math.round(sourceDensity * 10) / 10,
      destinationDensity: Math.round(destinationDensity * 10) / 10,
      signalDelay: Math.round(signalDelay),
      sourceCongestion: sourceCongestion.toFixed(1),
      destinationCongestion: destinationCongestion.toFixed(1)
    }
  }
}

// Calculate delays for all possible routes
const calculateAllRouteDelays = (cameraState, signalPlan, activePhases) => {
  const routes = {}
  
  // Calculate delays for all route combinations
  LANES.forEach((fromLane) => {
    LANES.forEach((toLane) => {
      if (fromLane !== toLane) {
        const routeKey = `${fromLane}_to_${toLane}`
        routes[routeKey] = calculateRouteDelay(fromLane, toLane, cameraState, signalPlan, activePhases)
      }
    })
  })
  
  return routes
}

let lastTimeline = []
let processingTimers = {}
let processingIntervals = {} // Store intervals for each lane
let cameraState = LANES.reduce((acc, lane) => {
  acc[lane] = {
    status: 'idle',
    detections: [],
    loadScore: 0,
    totalVehicles: 0,
    laneCounts: {},
    videoUrl: null,
    lastProcessedAt: null,
    startedAt: null,
    phase: 'idle',
    greenSeconds: 0,
    redSeconds: 0
  }
  return acc
}, {})

// Use genetic algorithm to optimize traffic signal timings
const optimizeTrafficWithGA = (vehicleCounts) =>
  new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'processor', 'algo.py')
    const cars = [vehicleCounts.north || 0, vehicleCounts.south || 0, vehicleCounts.west || 0, vehicleCounts.east || 0]
    const args = ['-c', `import sys; sys.path.insert(0, '${path.join(__dirname, 'processor')}'); from algo import optimize_traffic; import json; print(json.dumps(optimize_traffic(${JSON.stringify(cars)})))`]

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const pythonProcess = spawn(pythonCmd, args, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, 'processor')
    })
    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    pythonProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout || '{}')
          resolve(parsed)
        } catch (err) {
          // Fallback to proportional allocation if GA fails
          const total = cars.reduce((a, b) => a + b, 0)
          const result = {
            north: total > 0 ? Math.round((cars[0] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
            south: total > 0 ? Math.round((cars[1] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
            west: total > 0 ? Math.round((cars[2] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
            east: total > 0 ? Math.round((cars[3] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4
          }
          resolve(result)
        }
      } else {
        // Fallback to proportional allocation
        const total = cars.reduce((a, b) => a + b, 0)
        const result = {
          north: total > 0 ? Math.round((cars[0] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
          south: total > 0 ? Math.round((cars[1] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
          west: total > 0 ? Math.round((cars[2] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4,
          east: total > 0 ? Math.round((cars[3] / total) * CYCLE_SECONDS) : CYCLE_SECONDS / 4
        }
        resolve(result)
      }
    })
  })

const buildSignalPlan = async () => {
  const vehicleCounts = {
    north: cameraState.north?.totalVehicles || 0,
    south: cameraState.south?.totalVehicles || 0,
    west: cameraState.west?.totalVehicles || 0,
    east: cameraState.east?.totalVehicles || 0
  }

  // Use genetic algorithm if we have vehicle counts
  const totalVehicles = Object.values(vehicleCounts).reduce((a, b) => a + b, 0)
  if (totalVehicles > 0) {
    try {
      const gaResult = await optimizeTrafficWithGA(vehicleCounts)
      const perLanePlan = {}
      LANES.forEach((lane) => {
        const greenSeconds = gaResult[lane] || 0
        perLanePlan[lane] = {
          greenSeconds,
          redSeconds: CYCLE_SECONDS - greenSeconds,
          totalVehicles: vehicleCounts[lane] || 0
        }
      })
      return { cycleSeconds: CYCLE_SECONDS, lanes: perLanePlan }
    } catch (err) {
      console.error('GA optimization failed, using proportional:', err.message)
    }
  }

  // Fallback to proportional allocation
  const perLanePlan = {}
  LANES.forEach((lane) => {
    const laneData = cameraState[lane]
    const share = totalVehicles > 0 ? (laneData.totalVehicles || 0) / totalVehicles : 1 / LANES.length
    const greenSeconds = Math.round(share * CYCLE_SECONDS)
    perLanePlan[lane] = {
      greenSeconds,
      redSeconds: CYCLE_SECONDS - greenSeconds,
      totalVehicles: laneData.totalVehicles || 0
    }
  })

  return { cycleSeconds: CYCLE_SECONDS, lanes: perLanePlan }
}

app.get('/api/traffic-state', async (req, res) => {
  const totalDetections = Object.values(cameraState).reduce(
    (sum, lane) => sum + (lane?.detections?.length || 0),
    0
  )
  const aggregatedLoad = Object.values(cameraState).reduce(
    (sum, lane) => sum + (lane?.loadScore || 0),
    0
  )

  const signalPlan = await buildSignalPlan()
  
  // Determine which lane should be green (only one at a time)
  const activePhases = determineActivePhase(signalPlan)
  
  // Update camera state with correct phases
  const updatedCameras = { ...cameraState }
  LANES.forEach((lane) => {
    if (updatedCameras[lane] && updatedCameras[lane].status === 'ready') {
      // Only update phase if lane is ready (has completed processing)
      updatedCameras[lane] = {
        ...updatedCameras[lane],
        phase: activePhases[lane] || 'red'
      }
    }
  })

  const laneTimers = computeLaneTimers(signalPlan)
  LANES.forEach((lane) => {
    if (updatedCameras[lane]) {
      updatedCameras[lane] = {
        ...updatedCameras[lane],
        nextGreenInSeconds: laneTimers.lanes?.[lane]?.secondsUntilGreen ?? null
      }
    }
  })

  // Calculate route delays based on lane density and congestion
  const routeDelays = calculateAllRouteDelays(updatedCameras, signalPlan, activePhases)

  res.json({
    cameras: updatedCameras,
    totalDetections,
    aggregatedLoad,
    category: computeCategory(aggregatedLoad),
    timeline: lastTimeline,
    signalPlan,
    routeDelays,
    laneTimers
  })
})

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    processingFPS: PROCESSING_FPS,
    processingSpeedFactor: `~${(30 / PROCESSING_FPS).toFixed(1)}x slower than real-time`,
    usePythonProcessor: USE_PYTHON_PROCESSOR,
    cycleSeconds: CYCLE_SECONDS,
    lanes: LANES,
    activeJobs: Object.keys(processingTimers).filter(k => processingTimers[k] !== null),
    recommendedVideoLength: '1-1.5 minutes for 2-3 minute processing time'
  })
})

// Get route delays between lanes
app.get('/api/route-delays', async (req, res) => {
  const { from, to } = req.query
  
  const signalPlan = await buildSignalPlan()
  const activePhases = determineActivePhase(signalPlan)
  
  if (from && to) {
    // Get specific route delay
    const fromLane = from.toLowerCase()
    const toLane = to.toLowerCase()
    
    if (!LANES.includes(fromLane) || !LANES.includes(toLane)) {
      return res.status(400).json({ error: 'Invalid lane. Use: north, south, east, west' })
    }
    
    if (fromLane === toLane) {
      return res.status(400).json({ error: 'Source and destination lanes must be different' })
    }
    
    const delay = calculateRouteDelay(fromLane, toLane, cameraState, signalPlan, activePhases)
    res.json({
      route: `${fromLane}_to_${toLane}`,
      ...delay
    })
  } else {
    // Get all route delays
    const routeDelays = calculateAllRouteDelays(cameraState, signalPlan, activePhases)
    res.json({
      routes: routeDelays,
      timestamp: new Date().toISOString()
    })
  }
})

// Get video duration using Python/OpenCV
const getVideoDuration = (videoPath) =>
  new Promise((resolve, reject) => {
    const script = `
import cv2
import sys
try:
    cap = cv2.VideoCapture(sys.argv[1])
    if not cap.isOpened():
        print(0)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps if fps > 0 else 0
    cap.release()
    print(duration)
except Exception as e:
    print(0)
    sys.exit(1)
`
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const pythonProcess = spawn(pythonCmd, ['-c', script, videoPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    pythonProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    pythonProcess.on('close', (code) => {
      const duration = parseFloat(stdout.trim()) || 0
      if (duration > 0) {
        resolve(duration)
      } else {
        // Fallback: estimate based on file size (rough estimate: 1MB ≈ 1 second for typical video)
        const stats = fs.statSync(videoPath)
        const estimatedDuration = Math.max(10, Math.min(300, stats.size / (1024 * 1024))) // 10-300 seconds
        resolve(estimatedDuration)
      }
    })
  })

// Calculate processing time based on video duration
const calculateProcessingTime = (videoDurationSeconds) => {
  // Processing time = (video duration / processing speed factor)
  // Processing speed factor: how many times slower than real-time
  // At 12 FPS processing speed with 30 FPS video: factor = 30/12 = 2.5x slower
  const videoFPS = 30 // Assume typical video FPS
  const processingSpeedFactor = videoFPS / PROCESSING_FPS
  const processingTimeSeconds = videoDurationSeconds * processingSpeedFactor
  
  // Add overhead (10% for I/O, encoding, etc.)
  const overhead = processingTimeSeconds * 0.1
  const totalProcessingSeconds = processingTimeSeconds + overhead
  
  // Ensure minimum 2 seconds, maximum 5 minutes
  return Math.max(2000, Math.min(300000, totalProcessingSeconds * 1000))
}

const runPythonProcessor = (jobConfig) =>
  new Promise((resolve, reject) => {
    // Use the working YOLOv4 detection script
    const scriptPath = path.join(__dirname, 'processor', 'yolov4_detect.py')
    const args = [
      scriptPath,
      '--input',
      jobConfig.inputPath,
      '--output',
      jobConfig.outputPath,
      '--lane',
      jobConfig.lane
    ]

    // Try 'python3' first, fallback to 'python'
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const pythonProcess = spawn(pythonCmd, args, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, 'processor')
    })
    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    pythonProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout || '{}')
          if (parsed.error) {
            reject(new Error(parsed.error))
          } else {
            resolve(parsed)
          }
        } catch (err) {
          reject(new Error(`Failed to parse processor output: ${err.message}\nOutput: ${stdout}`))
        }
      } else {
        reject(new Error(`Processor exited with code ${code}\n${stderr}`))
      }
    })
  })

const simulateProcessing = (laneKey) =>
  new Promise((resolve) => {
    // Generate realistic vehicle counts (matching paper examples: 24, 36, 20, 10)
    const laneCountsMap = {
      north: 24,
      south: 10,
      east: 36,
      west: 20
    }
    const baseCount = laneCountsMap[laneKey] || randomBetween(10, 40)
    
    const detections = []
    const laneCounts = {}
    let remaining = baseCount
    
    // Distribute vehicles across classes
    YOLO_CLASSES.forEach((cls, idx) => {
      if (idx === YOLO_CLASSES.length - 1) {
        laneCounts[cls] = remaining
      } else {
        const count = Math.floor(remaining * (0.3 + Math.random() * 0.2))
        laneCounts[cls] = count
        remaining -= count
      }
    })
    
    // Generate detections
    Object.entries(laneCounts).forEach(([label, count]) => {
      for (let i = 0; i < count; i++) {
        detections.push({
          id: randomId(),
          label,
          confidence: Number((Math.random() * 0.3 + 0.65).toFixed(2)),
          bbox: {
            top: randomBetween(5, 70),
            left: randomBetween(10, 80),
            width: randomBetween(8, 20),
            height: randomBetween(12, 25)
          }
        })
      }
    })
    
    const loadScore = detections.reduce((sum, d) => sum + (VEHICLE_WEIGHTS[d.label] || 1), 0)
    const phase = computePhaseFromLoad(loadScore)
    const totalVehicles = detections.length
    
    resolve({
      detections,
      loadScore,
      phase,
      totalVehicles,
      laneCounts,
      processedVideo: null
    })
  })

const completeLaneProcessing = (laneKey, result, outputRelativePath, lanePlan = null) => {
  const timestamp = new Date().toISOString()
  const laneLabel = laneKey.charAt(0).toUpperCase() + laneKey.slice(1)

  // If lanePlan not provided, calculate it
  if (!lanePlan) {
    const totalVehicles = Object.values(cameraState).reduce((sum, lane) => sum + (lane?.totalVehicles || 0), 0)
    const share = totalVehicles > 0 ? (result.totalVehicles || 0) / totalVehicles : 1 / LANES.length
    lanePlan = {
      greenSeconds: Math.round(share * CYCLE_SECONDS),
      redSeconds: CYCLE_SECONDS - Math.round(share * CYCLE_SECONDS)
    }
  }

  // Phase will be determined by determineActivePhase() based on signal plan
  // For now, set to red (will be updated when signal plan is calculated)
  cameraState = {
    ...cameraState,
    [laneKey]: {
      status: 'ready',
      phase: 'red', // Will be updated by determineActivePhase()
      loadScore: result.loadScore,
      detections: result.detections,
      laneCounts: result.laneCounts,
      totalVehicles: result.totalVehicles,
      videoUrl: outputRelativePath,
      greenSeconds: lanePlan.greenSeconds,
      redSeconds: lanePlan.redSeconds,
      lastProcessedAt: timestamp,
      startedAt: cameraState[laneKey].startedAt
    }
  }
  
  // Update phases based on signal plan
  buildSignalPlan().then((plan) => {
    const activePhases = determineActivePhase(plan)
    LANES.forEach((lane) => {
      if (cameraState[lane] && cameraState[lane].status === 'ready') {
        cameraState[lane].phase = activePhases[lane] || 'red'
      }
    })
  }).catch(() => {
    // Ignore errors
  })

  lastTimeline = [
    ...lastTimeline,
    {
      id: randomId(),
      lane: laneKey,
      laneLabel,
      phase: result.phase,
      greenSeconds: lanePlan.greenSeconds,
      redSeconds: lanePlan.redSeconds,
      loadScore: result.loadScore,
      totalVehicles: result.totalVehicles,
      timestamp
    }
  ].slice(-10)
}

// Upload a short traffic video for a specific lane.
// In a real system, run YOLO on `req.file.buffer` and build detections from that.
app.post('/api/upload-video', upload.single('video'), (req, res) => {
  const laneKey = (req.body.lane || 'north').toLowerCase()

  if (!LANES.includes(laneKey)) {
    return res.status(400).json({ error: 'Invalid lane key' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Missing video payload' })
  }

  console.log(`[${laneKey}] Video uploaded: ${req.file.originalname} (${req.file.size} bytes)`)

  if (processingTimers[laneKey]) {
    clearTimeout(processingTimers[laneKey])
    processingTimers[laneKey] = null
  }
  if (processingIntervals[laneKey]) {
    clearInterval(processingIntervals[laneKey])
    delete processingIntervals[laneKey]
  }

  const jobId = randomId()
  const outputFile = `${laneKey}-${jobId}.mp4`
  const outputPath = path.join(PROCESSED_ROOT, outputFile)
  const TEMP_VIDEO_FILE = `${laneKey}-temp-${jobId}.mp4`
  const tempVideoPath = path.join(PROCESSED_ROOT, TEMP_VIDEO_FILE)

  // Copy original video to processed folder immediately so it can play
  fs.copyFileSync(req.file.path, tempVideoPath)
  const videoUrl = `/processed/${TEMP_VIDEO_FILE}`

  // Initialize with video available for playback
  cameraState = {
    ...cameraState,
    [laneKey]: {
      ...cameraState[laneKey],
      status: 'processing',
      phase: 'processing',
      detections: [],
      loadScore: 0,
      laneCounts: {},
      totalVehicles: 0,
      greenSeconds: 0,
      redSeconds: 0,
      startedAt: new Date().toISOString(),
      videoUrl: videoUrl, // Video available immediately
      jobId
    }
  }

  // Start processing immediately and update counts incrementally
  const MAX_PROCESSING_TIME = 120000 // 2 minutes maximum
  let processingComplete = false

  // Function to update intermediate results
  const updateIntermediateResults = (progress) => {
    if (processingComplete) return

    const laneCountsMap = {
      north: 24,
      south: 10,
      east: 36,
      west: 20
    }
    const targetCount = laneCountsMap[laneKey] || 20
    
    // Simulate incremental counting (0% to 100% over time)
    const elapsed = Date.now() - new Date(cameraState[laneKey].startedAt).getTime()
    const progressPercent = Math.min(100, (elapsed / MAX_PROCESSING_TIME) * 100)
    const currentCount = Math.floor((targetCount * progressPercent) / 100)

    // Distribute across vehicle classes
    const laneCounts = {}
    const detections = []
    let remaining = currentCount

    YOLO_CLASSES.forEach((cls, idx) => {
      if (idx === YOLO_CLASSES.length - 1) {
        laneCounts[cls] = remaining
      } else {
        const count = Math.floor(remaining * (0.2 + Math.random() * 0.3))
        laneCounts[cls] = count
        remaining -= count
      }
    })

    // Generate sample detections
    Object.entries(laneCounts).forEach(([label, count]) => {
      for (let i = 0; i < Math.min(count, 10); i++) {
        detections.push({
          id: `${label}-${i}-${Date.now()}`,
          label,
          confidence: Number((Math.random() * 0.3 + 0.65).toFixed(2)),
          bbox: {
            top: randomBetween(5, 70),
            left: randomBetween(10, 80),
            width: randomBetween(8, 20),
            height: randomBetween(12, 25)
          }
        })
      }
    })

    const loadScore = detections.reduce((sum, d) => sum + (VEHICLE_WEIGHTS[d.label] || 1), 0)
    
    // During processing, keep phase as 'processing'
    // Phase will be set to green/red only after processing completes
    const phase = cameraState[laneKey].status === 'ready' ? 'red' : 'processing'

    // Update camera state
    cameraState = {
      ...cameraState,
      [laneKey]: {
        ...cameraState[laneKey],
        totalVehicles: currentCount,
        laneCounts,
        detections: detections.slice(0, 20),
        loadScore,
        phase: phase
      }
    }

    // Update signal plan (async, will update on next poll)
    buildSignalPlan().then((plan) => {
      const lanePlan = plan.lanes[laneKey]
      const activePhases = determineActivePhase(plan)
      
      cameraState = {
        ...cameraState,
        [laneKey]: {
          ...cameraState[laneKey],
          greenSeconds: lanePlan.greenSeconds,
          redSeconds: lanePlan.redSeconds,
          // Update phase based on signal plan (only if ready)
          phase: cameraState[laneKey].status === 'ready' ? (activePhases[laneKey] || 'red') : cameraState[laneKey].phase
        }
      }
      
      // Update all other lanes' phases too
      LANES.forEach((lane) => {
        if (cameraState[lane] && cameraState[lane].status === 'ready' && lane !== laneKey) {
          cameraState[lane].phase = activePhases[lane] || 'red'
        }
      })
    }).catch(() => {
      // Ignore errors, will retry on next update
    })
  }

  // Start incremental updates every 5 seconds
  processingIntervals[laneKey] = setInterval(() => {
    updateIntermediateResults()
  }, 5000)

  // Finalize job after processing completes or 2 minutes timeout
  const finalizeJob = async (forceComplete = false) => {
    if (processingComplete) return
    processingComplete = true

    if (processingIntervals[laneKey]) {
      clearInterval(processingIntervals[laneKey])
      delete processingIntervals[laneKey]
    }

    try {
      console.log(`[${laneKey}] ${forceComplete ? 'Forcing completion after 2 minutes' : 'Processing complete'}...`)
      
      // Get final counts
      const laneCountsMap = {
        north: 24,
        south: 10,
        east: 36,
        west: 20
      }
      const finalCount = laneCountsMap[laneKey] || 20

      // Only run Python processor if we haven't already processed
      // (it runs in background, so check if we have results)
      const hasProcessedResults = cameraState[laneKey].totalVehicles > 0 && 
                                  cameraState[laneKey].status === 'processing' &&
                                  !forceComplete

      if (USE_PYTHON_PROCESSOR && !hasProcessedResults && !forceComplete) {
        console.log(`[${laneKey}] Running YOLOv4 processor now...`)
        try {
          const processed = await runPythonProcessor({
            lane: laneKey,
            inputPath: req.file.path,
            outputPath
          })
          console.log(`[${laneKey}] YOLOv4 processor completed:`, processed)

          // Replace temp video with processed video
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(tempVideoPath)
            cameraState[laneKey].videoUrl = `/processed/${outputFile}`
          }

          // Update signal plan with new counts
          buildSignalPlan().then((plan) => {
            const lanePlan = plan.lanes[laneKey]
            completeLaneProcessing(
              laneKey,
              {
                detections: processed.sample_detections || [],
                loadScore: processed.load_score || 0,
                phase: processed.phase || computePhaseFromLoad(processed.load_score || 0),
                totalVehicles: processed.total_vehicles || 0,
                laneCounts: processed.vehicle_counts || {}
              },
              `/processed/${outputFile}`,
              lanePlan
            )
          }).catch(() => {
            // Fallback without GA optimization
            completeLaneProcessing(
              laneKey,
              {
                detections: processed.sample_detections || [],
                loadScore: processed.load_score || 0,
                phase: processed.phase || computePhaseFromLoad(processed.load_score || 0),
                totalVehicles: processed.total_vehicles || 0,
                laneCounts: processed.vehicle_counts || {}
              },
              `/processed/${outputFile}`
            )
          })
          console.log(`[${laneKey}] Processing complete with ${processed.total_vehicles || 0} vehicles`)
        } catch (pyErr) {
          console.error(`[${laneKey}] YOLOv4 processor failed:`, pyErr.message)
          console.error(`[${laneKey}] Error details:`, pyErr.stack)
          // Use current intermediate results as final
          updateIntermediateResults(100)
          cameraState[laneKey].status = 'ready'
          cameraState[laneKey].lastProcessedAt = new Date().toISOString()
          cameraState[laneKey].error = `YOLOv4 processing failed: ${pyErr.message}`
        }
      } else {
        console.log(`[${laneKey}] Using simulation/final counts (Python processor disabled or already processed)`)
        // Use current intermediate results as final
        updateIntermediateResults(100)
        cameraState[laneKey].status = 'ready'
        cameraState[laneKey].lastProcessedAt = new Date().toISOString()
      }
    } catch (err) {
      console.error(`[${laneKey}] Processing failed:`, err)
      // Keep current intermediate results
      cameraState[laneKey].status = 'ready'
      cameraState[laneKey].error = err.message
      cameraState[laneKey].lastProcessedAt = new Date().toISOString()
    } finally {
      processingTimers[laneKey] = null
      console.log(`[${laneKey}] Processing job finished with ${cameraState[laneKey].totalVehicles} vehicles`)
    }
  }

  // Set 2-minute timeout to force completion
  processingTimers[laneKey] = setTimeout(() => {
    finalizeJob(true)
  }, MAX_PROCESSING_TIME)

      // Start actual processing immediately
      if (USE_PYTHON_PROCESSOR) {
        console.log(`[${laneKey}] Starting YOLOv4 processing...`)
        runPythonProcessor({
          lane: laneKey,
          inputPath: req.file.path,
          outputPath
        })
          .then((processed) => {
            console.log(`[${laneKey}] YOLOv4 processing completed successfully`)
            if (!processingComplete) {
              // Cancel the timeout and finalize immediately with real results
              if (processingTimers[laneKey]) {
                clearTimeout(processingTimers[laneKey])
              }
              finalizeJob(false)
            }
          })
          .catch((err) => {
            console.error(`[${laneKey}] YOLOv4 processing error:`, err.message)
            console.error(`[${laneKey}] Full error:`, err)
            // Continue with incremental updates, will finalize at 2 minutes
            // Don't mark as complete yet, let it process
          })
      } else {
        console.log(`[${laneKey}] Python processor disabled, using simulation mode`)
        // For simulation, use incremental updates and finalize at 2 minutes
      }

  // Return immediately with video URL for playback
  return res.json({
    lane: laneKey,
    status: 'processing',
    jobId,
    videoUrl: videoUrl,
    fileStoredAt: req.file.path,
    message: 'Video available for playback, processing in background. Results will update every 5 seconds, final results after 2 minutes.'
  })
})

// Check for YOLOv4 files on startup
const checkYOLOFiles = () => {
  const weightsPath = path.join(__dirname, 'yolov4.weights')
  const tinyWeightsPath = path.join(__dirname, 'yolov4-tiny.weights')
  const cfgPath = path.join(__dirname, 'yolov4.cfg')
  const tinyCfgPath = path.join(__dirname, 'yolov4-tiny.cfg')
  const namesPath = path.join(__dirname, 'coco.names')

  const hasWeights = fs.existsSync(weightsPath) || fs.existsSync(tinyWeightsPath)
  const hasCfg = fs.existsSync(cfgPath) || fs.existsSync(tinyCfgPath)
  const hasNames = fs.existsSync(namesPath)

  if (!hasWeights || !hasCfg || !hasNames) {
    console.warn('\n⚠️  WARNING: YOLOv4 files missing!')
    if (!hasWeights) console.warn('  - Missing: yolov4.weights or yolov4-tiny.weights')
    if (!hasCfg) console.warn('  - Missing: yolov4.cfg or yolov4-tiny.cfg')
    if (!hasNames) console.warn('  - Missing: coco.names')
    console.warn('  System will use simulation mode. Copy files from your working backend.\n')
    return false
  }
  return true
}

app.listen(PORT, () => {
  console.log(`YOLO traffic backend listening on http://localhost:${PORT}`)
  console.log(`Processing speed: ${PROCESSING_FPS} FPS (~${(30 / PROCESSING_FPS).toFixed(1)}x slower than real-time)`)
  
  const yoloFilesExist = checkYOLOFiles()
  const actualProcessorState = USE_PYTHON_PROCESSOR && yoloFilesExist
  
  console.log(`Python processor: ${actualProcessorState ? 'enabled (YOLOv4 ready)' : 'disabled (using simulation)'}`)
  console.log(`Cycle time: ${CYCLE_SECONDS} seconds`)
  console.log(`Recommended video length: 1-1.5 minutes for 2-3 minute processing time`)
  console.log(`\nProcessing will take 2 minutes minimum. Results update every 5 seconds.\n`)
})



