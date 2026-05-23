const gTTS  = require('gtts')
const fs    = require('fs')
const path  = require('path')
const os    = require('os')
const ffmpeg        = require('fluent-ffmpeg')
const ffmpegPath    = require('ffmpeg-static')

ffmpeg.setFfmpegPath(ffmpegPath)

// Divide texto en chunks respetando oraciones
function splitText(text, maxLen = 180) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text]
  const chunks = []
  let current = ''
  for (const s of sentences) {
    if ((current + s).length > maxLen && current) {
      chunks.push(current.trim())
      current = s
    } else {
      current += ' ' + s
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

async function saveTTS(text, filePath) {
  return new Promise((resolve, reject) => {
    const tts = new gTTS(text, 'es')
    tts.save(filePath, err => (err ? reject(err) : resolve()))
  })
}

async function textToSpeech(script, outputPath) {
  const chunks  = splitText(script)
  const tmpDir  = os.tmpdir()
  const parts   = []

  for (let i = 0; i < chunks.length; i++) {
    const p = path.join(tmpDir, `tts_chunk_${Date.now()}_${i}.mp3`)
    await saveTTS(chunks[i], p)
    parts.push(p)
  }

  if (parts.length === 1) {
    fs.renameSync(parts[0], outputPath)
    return outputPath
  }

  // Concatenar chunks con FFmpeg
  const listFile = path.join(tmpDir, `tts_list_${Date.now()}.txt`)
  fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject)
  })

  parts.forEach(p => { try { fs.unlinkSync(p) } catch {} })
  try { fs.unlinkSync(listFile) } catch {}

  return outputPath
}

// Devuelve duración en segundos de un archivo de audio
async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err)
      resolve(meta.format.duration || 0)
    })
  })
}

module.exports = { textToSpeech, getAudioDuration }
