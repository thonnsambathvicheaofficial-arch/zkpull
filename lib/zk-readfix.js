// ── Runtime fix for node-zklib's multi-chunk read ───────────────────────────
//
// WHY THIS IS HERE INSTEAD OF A patch-package PATCH:
// This started life as patches/node-zklib+1.3.0.patch. That approach failed
// repeatedly in production for two reasons, both of which cost us weeks of
// silently-missing punches:
//
//   1. node_modules drifted from the patch. Someone hand-edited node_modules
//      locally and never regenerated the patch, so the fix existed ONLY on one
//      machine. Local worked, Vercel ran pristine upstream, and every "works on
//      my machine" test was misleading.
//   2. patch-package can't survive Vercel's build cache. The cache restores
//      node_modules with the PREVIOUS patch already applied, so a newly-changed
//      patch (a diff against pristine) no longer matches and the build fails.
//
// Overriding the method at runtime from our own tracked source removes both
// failure modes: there is exactly one copy of this code, it's version
// controlled, and local and production are guaranteed identical.
//
// WHAT THE FIX ACTUALLY IS:
// Upstream detects a completed chunk with STRICT EQUALITY on buffer length
// (`realTotalBuffer.length === MAX_CHUNK + 8`). TCP guarantees no such
// alignment — all chunk requests are sent in one burst, so responses can
// coalesce and a single packet can straddle a chunk boundary, overshooting the
// exact length. Once it overshoots, that condition can never be true again:
// totalPackets never decrements and the read hangs until the timeout. A LAN
// delivers tidy aligned packets (works); a long-haul WAN link does not (hangs).
// It's also why K40 was fine — 718 records is a single chunk, which never
// reaches this path — while B3-C (3.5k+ records, multi-chunk) always hung.
//
// Below, chunks are consumed by LENGTH with the remainder carried forward.
// That is byte-for-byte identical when the length matches exactly (the path
// that already worked), and recovers instead of hanging when it overshoots —
// so it can only turn a hang into a success, never corrupt a good read.

const ZKLibTCP = require('node-zklib/zklibtcp')
const { MAX_CHUNK, COMMANDS } = require('node-zklib/constants')
const { createTCPHeader, checkNotEventTCP, decodeTCPHeader } = require('node-zklib/utils')

// Upstream hardcodes 10s here, which is too tight for a large buffer over the
// WAN. lib/zkpull.js also wraps every read in its own outer timeout well under
// Vercel's 60s function ceiling, so this is just a backstop.
const RECEIVE_TIMEOUT_MS = 40000

ZKLibTCP.prototype.readWithBuffer = function (reqData, cb = null) {
  return new Promise(async (resolve, reject) => {
    this.replyId++
    const buf = createTCPHeader(COMMANDS.CMD_DATA_WRRQ, this.sessionId, this.replyId, reqData)
    let reply = null

    try {
      reply = await this.requestData(buf)
    } catch (err) {
      return reject(err)
    }

    const header = decodeTCPHeader(reply.subarray(0, 16))
    switch (header.commandId) {
      case COMMANDS.CMD_DATA: {
        resolve({ data: reply.subarray(16), mode: 8 })
        break
      }
      case COMMANDS.CMD_ACK_OK:
      case COMMANDS.CMD_PREPARE_DATA: {
        // Data is prepared — `reply` carries the total size of what follows.
        const recvData = reply.subarray(16)
        const size = recvData.readUIntLE(1, 4)

        const remain = size % MAX_CHUNK
        const numberChunks = Math.round(size - remain) / MAX_CHUNK
        let totalPackets = numberChunks + (remain > 0 ? 1 : 0)
        let replyData = Buffer.from([])

        let totalBuffer = Buffer.from([])
        let realTotalBuffer = Buffer.from([])

        let timer = setTimeout(() => {
          internalCallback(replyData, new Error('TIMEOUT WHEN RECEIVING PACKET'))
        }, RECEIVE_TIMEOUT_MS)

        const internalCallback = (data, err = null) => {
          timer && clearTimeout(timer)
          resolve({ data, err })
        }

        const handleOnData = (chunk) => {
          if (checkNotEventTCP(chunk)) return
          clearTimeout(timer)
          timer = setTimeout(() => {
            internalCallback(replyData, new Error(`TIME OUT !! ${totalPackets} PACKETS REMAIN !`))
          }, RECEIVE_TIMEOUT_MS)

          totalBuffer = Buffer.concat([totalBuffer, chunk])

          // Peel complete TCP-framed packets off the stream.
          while (totalBuffer.length >= 8) {
            const packetLength = totalBuffer.readUIntLE(4, 2)
            if (totalBuffer.length < 8 + packetLength) break

            realTotalBuffer = Buffer.concat([realTotalBuffer, totalBuffer.subarray(16, 8 + packetLength)])
            totalBuffer = totalBuffer.subarray(8 + packetLength)

            // Consume completed chunks by length (see header comment) — handles
            // a packet straddling a chunk boundary instead of hanging on it.
            let expected = (totalPackets > 1 ? MAX_CHUNK : remain) + 8
            while (totalPackets > 0 && realTotalBuffer.length >= expected) {
              replyData = Buffer.concat([replyData, realTotalBuffer.subarray(8, expected)])
              realTotalBuffer = realTotalBuffer.subarray(expected)

              totalPackets -= 1
              cb && cb(replyData.length, size)

              if (totalPackets <= 0) {
                internalCallback(replyData)
                return
              }
              expected = (totalPackets > 1 ? MAX_CHUNK : remain) + 8
            }
          }
        }

        this.socket.once('close', () => {
          internalCallback(replyData, new Error('Socket is disconnected unexpectedly'))
        })

        this.socket.on('data', handleOnData)

        for (let i = 0; i <= numberChunks; i++) {
          if (i === numberChunks) {
            this.sendChunkRequest(numberChunks * MAX_CHUNK, remain)
          } else {
            this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK)
          }
        }

        break
      }
      default: {
        reject(new Error('ERROR_IN_UNHANDLE_CMD ' + header.commandId))
      }
    }
  })
}

module.exports = { RECEIVE_TIMEOUT_MS }
