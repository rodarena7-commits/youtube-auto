const ffmpeg     = require('fluent-ffmpeg')
const ffmpegPath = require('ffmpeg-static')
const fs         = require('fs')
const path       = require('path')
const os         = require('os')

ffmpeg.setFfmpegPath(ffmpegPath)

const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Mi Canal'
const VIDEO_WIDTH = parseInt(process.env.VIDEO_WIDTH) || 960
const VIDEO_HEIGHT = parseInt(process.env.VIDEO_HEIGHT) || 540

// Escala + recorta un clip a la resolución configurada con duración exacta
async function processClip(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .duration(duration)
      .videoFilter([
        `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=increase`,
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
        'setsar=1',
      ])
      .outputOptions([
        '-c:v libx264',
        '-preset ultrafast',
        '-crf 28',
        '-an',
        '-r 30',
        '-threads 1', // Limita a 1 hilo para estabilizar el uso de CPU y evitar OOM
        '-bf 0'       // Deshabilita B-Frames para reducir el búfer de RAM a la mitad
      ])
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

// Mezcla video con audio de voz y opcionalmente quema subtítulos ASS (soporta estilos y portada)
async function mixVideoAudio(videoPath, audioPath, outputPath, title, srtPath = null) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(videoPath)
      .input(audioPath)

    const outputOptions = [
      '-map 0:v',
      '-map 1:a',
      '-c:a aac',
      '-shortest',
      '-threads 1' // Limitar hilos a 1 para evitar OOM al transcodificar en Render
    ]

    if (srtPath && fs.existsSync(srtPath)) {
      // Usamos el filtro de subtítulos de FFmpeg. Al ser un archivo ASS, respeta estilos y posiciones.
      command.videoFilters(`subtitles='${srtPath.replace(/\\/g, '/')}'`)
      // Es necesario re-codificar la pista de video para quemar los subtítulos
      outputOptions.push('-c:v libx264', '-preset ultrafast', '-crf 28', '-bf 0')
    } else {
      // Si no hay subtítulos, hacemos copia directa súper rápida sin procesar video de nuevo
      outputOptions.push('-c:v copy')
    }

    command
      .outputOptions(outputOptions)
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject)
  })
}

// Pipeline completo: clips + audio → video final
async function buildVideo(clips, audioPath, audioDuration, outputPath, title, srtPath = null, onProgress = null) {
  const tmpDir    = os.tmpdir()
  const processed = []

  // 1. Procesar cada clip normalizado
  let remaining = audioDuration + 2
  for (let i = 0; i < clips.length && remaining > 0; i++) {
    const duration = Math.min(clips[i].duration, remaining)
    const out = path.join(tmpDir, `proc_${Date.now()}_${i}.mp4`)
    const msg = `Procesando clip ${i + 1}/${clips.length} (${duration}s)`
    console.log(`  🎬 ${msg}`)
    if (onProgress) onProgress(msg, Math.round((i / clips.length) * 80))
    await processClip(clips[i].path, out, duration)
    processed.push(out)
    remaining -= duration
  }

  // 2. Si falta duración, repetir el último clip
  while (remaining > 2 && processed.length > 0) {
    const last = clips[clips.length - 1]
    const duration = Math.min(last.duration, remaining)
    const out = path.join(tmpDir, `proc_loop_${Date.now()}.mp4`)
    const msg = `Repitiendo último clip por duración restante (${duration}s)`
    console.log(`  🎬 ${msg}`)
    if (onProgress) onProgress(msg, 80)
    await processClip(last.path, out, duration)
    processed.push(out)
    remaining -= duration
  }

  // 3. Concatenar clips
  const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
  console.log('  🔗 Concatenando clips...')
  if (onProgress) onProgress('Concatenando clips normalizados...', 85)
  await concatenateClips(processed, concatPath)

  // 4. Mezclar con audio + subtítulos / portada
  console.log('  🎵 Mezclando audio y video...')
  const hasSubs = srtPath && fs.existsSync(srtPath)
  const mixMsg = hasSubs ? 'Mezclando audio y quemando subtítulos/portada...' : 'Mezclando audio y video...'
  if (onProgress) onProgress(mixMsg, 90)
  await mixVideoAudio(concatPath, audioPath, outputPath, title, srtPath)

  // Cleanup
  processed.forEach(p => { try { fs.unlinkSync(p) } catch {} })
  try { fs.unlinkSync(concatPath) } catch {}

  return outputPath
}

// Pipeline para videos musicales largos: loop infinito de video y audio con stream copy (0% CPU/RAM)
async function buildMusicVideo(clipPath, audioPath, outputPath, onProgress = null) {
  const duration = 1800 // 30 minutos
  
  if (onProgress) onProgress('Generando video de 30 minutos en bucle...', 50)
  
  return new Promise((resolve, reject) => {
    ffmpeg()
      .inputOptions(['-stream_loop', '-1'])
      .input(clipPath)
      .inputOptions(['-stream_loop', '-1'])
      .input(audioPath)
      .outputOptions([
        `-t ${duration}`,
        '-c copy',     // Stream copy (no recodifica, súper rápido y ligero)
        '-shortest'
      ])
      .save(outputPath)
      .on('end', () => {
        if (onProgress) onProgress('Video musical generado', 100)
        resolve(outputPath)
      })
      .on('error', reject)
  })
}

module.exports = { buildVideo, buildMusicVideo }
