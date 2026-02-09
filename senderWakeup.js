const { startSenderLoop } = require("./worker/socketManager")

function wakeSender(clientId) {
  startSenderLoop(clientId)
}

module.exports = { wakeSender }