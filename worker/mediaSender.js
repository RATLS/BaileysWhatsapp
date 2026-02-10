const axios = require("axios")

async function sendMessageWithMedia(sock, jid, payload) {
  const { text, files = [] } = payload

  const hasText = typeof text === "string" && text.trim().length > 0

  // CASE 1: Only text
  if (!files.length) {
    if (!hasText) return // 🔒 nothing to send
    await sock.sendMessage(jid, { text: text })
    return
  }

  // CASE 2: Single media (caption)
  if (files.length === 1) {
    const file = files[0]
    const media = await fetchMedia(file)

    const message = { ...media }

    // ✅ caption only if valid
    if (hasText) {
      message.caption = text
    }

    await sock.sendMessage(jid, message)
    return
  }

  // CASE 3: Multiple media
  for (const file of files) {
    const media = await fetchMedia(file)
    await sock.sendMessage(jid, media)
  }

  // Send text separately at the end (ONLY if valid)
  if (hasText) {
    await sock.sendMessage(jid, { text: text })
  }
}

async function fetchMedia(file) {
  const response = await axios.get(file.file_url, {
    responseType: "arraybuffer"
  })

  const buffer = Buffer.from(response.data)

  if (file.mimeType.startsWith("image/")) {
    return { image: buffer }
  }

  if (file.mimeType.startsWith("video/")) {
    return { video: buffer }
  }

  return {
    document: buffer,
    mimetype: file.mimeType,
    fileName: file.filename
  }
}

module.exports = { sendMessageWithMedia }