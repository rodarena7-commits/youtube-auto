const OpenAI = require('openai')

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const NICHE = process.env.NICHE || 'finanzas personales e inversiones'

// Temas ya usados (en memoria, se resetea al reiniciar)
const usedTopics = new Set()

async function generateScript() {
  const usedList = usedTopics.size > 0
    ? `\nNO repitas estos temas ya usados: ${[...usedTopics].slice(-10).join(', ')}`
    : ''

  const prompt = `Eres un guionista profesional de YouTube en español para el nicho: "${NICHE}".
${usedList}

Generá un video educativo/informativo de exactamente 3 minutos (450 palabras aprox).
El video no tiene locutor visible ni cara, solo voz en off con imágenes de fondo.

Respondé SOLO con este JSON válido, sin markdown:
{
  "title": "Título atractivo para YouTube (máx 70 caracteres, con número o pregunta)",
  "description": "Descripción para YouTube de 3-4 oraciones con hashtags al final",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "topic": "resumen de 5 palabras del tema",
  "script": "Guión completo de 450 palabras para narrar en voz off. Empezá con un hook impactante, desarrollá el contenido con datos y ejemplos concretos, y cerrá con un llamado a la acción pidiendo suscripción."
}`

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1200,
  })

  const text = response.choices[0].message.content.trim()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    // Intentar extraer JSON si vino con markdown
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('GPT no devolvió JSON válido')
    data = JSON.parse(match[0])
  }

  usedTopics.add(data.topic)
  return data
}

module.exports = { generateScript }
