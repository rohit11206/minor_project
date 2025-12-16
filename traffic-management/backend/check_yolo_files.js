const fs = require('fs')
const path = require('path')

const backendRoot = __dirname
const requiredFiles = [
  { name: 'yolov4.weights', alt: 'yolov4-tiny.weights' },
  { name: 'yolov4.cfg', alt: 'yolov4-tiny.cfg' },
  { name: 'coco.names' }
]

console.log('Checking for YOLOv4 files...\n')

let allFilesExist = true

requiredFiles.forEach(file => {
  const mainPath = path.join(backendRoot, file.name)
  const altPath = file.alt ? path.join(backendRoot, file.alt) : null
  
  if (fs.existsSync(mainPath)) {
    const stats = fs.statSync(mainPath)
    console.log(`✓ Found: ${file.name} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
  } else if (altPath && fs.existsSync(altPath)) {
    const stats = fs.statSync(altPath)
    console.log(`✓ Found: ${file.alt} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
  } else {
    console.log(`✗ Missing: ${file.name}${file.alt ? ` or ${file.alt}` : ''}`)
    allFilesExist = false
  }
})

if (!allFilesExist) {
  console.log('\n⚠️  WARNING: Some YOLOv4 files are missing!')
  console.log('Please copy the required files from your working backend:')
  console.log('  - yolov4.weights or yolov4-tiny.weights')
  console.log('  - yolov4.cfg or yolov4-tiny.cfg')
  console.log('  - coco.names')
  console.log('\nThe system will use simulation mode until files are added.')
} else {
  console.log('\n✓ All YOLOv4 files found! Ready for processing.')
}

process.exit(allFilesExist ? 0 : 1)

