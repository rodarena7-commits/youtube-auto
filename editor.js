const ffmpeg     = require('fluent-ffmpeg')
const ffmpegPath = require('ffmpeg-static')
const fs         = require('fs')
const path       = require('path')
const os         = require('os')

ffmpeg.setFfmpegPath(ffmpegPath)

const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Mi Canal'

// Escala + recorta un clip a 1920x1080 con duración exacta
async function processClip(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .duration(duration)
      .videoFilter([
        'scale=1920:1080:force_original_aspect_ratio=increase',
        'crop=1920:1080',
        'setsar=1',
      ])
      .outputOptions(['-c:v libx264', '-preset ultrafast', '-crf 28', '-an', '-r 30'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject)
  })
}

// Concatena clips en un video sin audio
async function concatenateClips(clipPaths, outputPath) {
  const listFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`)
  fs.writeFileSync(listFile, clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .save(outputPath)
      .on('end', () => { try { fs.unlinkSync(listFile) } catch {} resolve() })
      .on('error', reject)
  })
}

// Mezcla video con audio de voz
async function mixVideoAudio(videoPath, audioPath, outputPath, title) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-map 0:v',
        '-map 1:a',
        '-c:v libx264',
        '-preset ultrafast',
        '-crf 26',
        '-c:a aac',
        '-shortest',
        '-r 30',
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject)
  })
}

// Pipeline completo: clips + audio → video final
async function buildVideo(clips, audioPath, audioDuration, outputPath, title) {
  const tmpDir    = os.tmpdir()
  const processed = []

  // 1. Procesar cada clip normalizado
  let remaining = audioDuration + 2
  for (let i = 0; i < clips.length && remaining > 0; i++) {
    const duration = Math.min(clips[i].duration, remaining)
    const out = path.join(tmpDir, `proc_${Date.now()}_${i}.mp4`)
    console.log(`  🎬 Procesando clip ${i + 1}/${clips.length} (${duration}s)`)
    await processClip(clips[i].path, out, duration)
    processed.push(out)
    remaining -= duration
  }

  // 2. Si falta duración, repetir el último clip
  while (remaining > 2 && processed.length > 0) {
    const last = clips[clips.length - 1]
    const duration = Math.min(last.duration, remaining)
    const out = path.join(tmpDir, `proc_loop_${Date.now()}.mp4`)
    await processClip(last.path, out, duration)
    processed.push(out)
    remaining -= duration
  }

  // 3. Concatenar clips
  const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
  console.log('  🔗 Concatenando clips...')
  await concatenateClips(processed, concatPath)

  // 4. Mezclar con audio + watermark
  console.log('  🎵 Mezclando audio y video...')
  await mixVideoAudio(concatPath, audioPath, outputPath, title)

  // Cleanup
  processed.forEach(p => { try { fs.unlinkSync(p) } catch {} })
  try { fs.unlinkSync(concatPath) } catch {}

  return outputPath
}

module.exports = { buildVideo }
