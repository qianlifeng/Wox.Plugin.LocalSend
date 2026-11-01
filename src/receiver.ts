import * as https from "https"
import * as http from "http"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as tls from "tls"
import { Transform } from "stream"
import { pipeline } from "stream/promises"
import * as forge from "node-forge"
import type { DeviceType, LocalSendDevice } from "./discovery"

export interface ReceiverIdentity {
  alias: string
  version: string
  deviceModel: string
  deviceType: "desktop"
  fingerprint: string
  port: number
  protocol: "https"
  download: false
}

type IncomingFile = { id: string; fileName: string; size: number; sha256?: string | null; token: string; state: "ready" | "uploading" | "done" }
type Session = { ip: string; sender: string; directory: string; files: Map<string, IncomingFile>; timer: NodeJS.Timeout }
const SESSION_TIMEOUT_MS = 10 * 60_000
const MAX_BODY_SIZE = 1024 * 1024

function certificate(cacheDir: string): { key: string; cert: string; fingerprint: string } {
  fs.mkdirSync(cacheDir, { recursive: true })
  const keyPath = path.join(cacheDir, "localsend-key.pem")
  const certPath = path.join(cacheDir, "localsend-cert.pem")
  let key: string
  let cert: string
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    key = fs.readFileSync(keyPath, "utf8")
    cert = fs.readFileSync(certPath, "utf8")
    // Verify both the certificate and key before starting the listener.
    tlsContext(key, cert)
  } else {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const generated = forge.pki.createCertificate()
    generated.publicKey = keys.publicKey
    generated.serialNumber = crypto.randomBytes(16).toString("hex")
    generated.validity.notBefore = new Date(Date.now() - 60_000)
    generated.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000)
    generated.setSubject([{ name: "commonName", value: "Wox LocalSend" }])
    generated.setIssuer(generated.subject.attributes)
    generated.sign(keys.privateKey, forge.md.sha256.create())
    key = forge.pki.privateKeyToPem(keys.privateKey)
    cert = forge.pki.certificateToPem(generated)
    fs.writeFileSync(keyPath, key, { mode: 0o600 })
    fs.writeFileSync(certPath, cert, { mode: 0o600 })
  }
  return { key, cert, fingerprint: crypto.createHash("sha256").update(new crypto.X509Certificate(cert).raw).digest("hex").toUpperCase() }
}

function tlsContext(key: string, cert: string): void {
  tls.createSecureContext({ key, cert })
}

function sendJson(res: http.ServerResponse, status: number, body?: object): void {
  if (body) {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  } else {
    res.writeHead(status)
    res.end()
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Buffer)
    size += data.length
    if (size > MAX_BODY_SIZE) throw new Error("Request too large")
    chunks.push(data)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function safeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "file"
  const safe = base
    .split("")
    .map(char => (char.charCodeAt(0) < 32 ? "_" : char))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180)
  if (!safe || safe === "." || safe === "..") return "file"
  if (safe.toLowerCase() === ".localsend.json") return "_.localsend.json"
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? `_${safe}` : safe
}

async function createFile(directory: string, name: string): Promise<{ file: fs.promises.FileHandle; filePath: string }> {
  await fs.promises.mkdir(directory, { recursive: true })
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let i = 0; i < 10000; i++) {
    const filePath = path.join(directory, `${stem}${i ? ` (${i})` : ""}${extension}`)
    try {
      return { file: await fs.promises.open(filePath, "wx", 0o600), filePath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  throw new Error("Could not choose a unique filename")
}

function parseFiles(body: unknown): { alias: string; files: IncomingFile[] } {
  if (!body || typeof body !== "object") throw new Error("Invalid request")
  const request = body as { info?: { alias?: unknown }; files?: Record<string, unknown> }
  if (!request.files || typeof request.files !== "object" || Array.isArray(request.files)) throw new Error("Invalid files")
  const entries = Object.entries(request.files)
  if (!entries.length || entries.length > 100) throw new Error("Invalid file count")
  const files = entries.map(([id, value]) => {
    if (!value || typeof value !== "object") throw new Error("Invalid file")
    const file = value as { id?: unknown; fileName?: unknown; size?: unknown; sha256?: unknown }
    if (
      !id ||
      file.id !== id ||
      typeof file.fileName !== "string" ||
      !file.fileName ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (file.sha256 != null && (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)))
    )
      throw new Error("Invalid file")
    return { id, fileName: safeFilename(file.fileName), size: file.size, sha256: file.sha256 as string | null | undefined, token: crypto.randomBytes(24).toString("hex"), state: "ready" as const }
  })
  return { alias: typeof request.info?.alias === "string" ? request.info.alias.slice(0, 100) : "LocalSend", files }
}

export async function startReceiver(
  cacheDir: string,
  directory: string,
  notify: (filePath: string, sessionId: string, sender: string, receivedFiles: string[]) => void,
  preferredPort = 53317,
  onDevice?: (device: LocalSendDevice) => void
): Promise<{ identity: ReceiverIdentity; credentials: { key: string; cert: string }; close: () => Promise<void> }> {
  const { key, cert, fingerprint } = certificate(cacheDir)
  const identity: ReceiverIdentity = {
    alias: `Wox - ${os.hostname()}`,
    version: "2.2",
    deviceModel: os.platform(),
    deviceType: "desktop",
    fingerprint,
    port: preferredPort,
    protocol: "https",
    download: false
  }
  const sessions = new Map<string, Session>()
  const server = https.createServer({ key, cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500)
      else res.destroy()
    })
  })
  server.requestTimeout = 5 * 60_000

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || "/", "https://localhost")
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "")
    if (req.method === "GET" && url.pathname === "/api/localsend/v2/info") return sendJson(res, 200, identity)
    if (req.method === "POST" && url.pathname === "/api/localsend/v2/register") {
      try {
        const info = (await readJson(req)) as Partial<LocalSendDevice>
        const cert = (req.socket as tls.TLSSocket).getPeerCertificate()
        const fingerprint = cert?.raw ? crypto.createHash("sha256").update(cert.raw).digest("hex").toUpperCase() : info.fingerprint
        if (
          typeof info.alias === "string" &&
          typeof fingerprint === "string" &&
          fingerprint &&
          fingerprint !== identity.fingerprint &&
          (info.protocol === "http" || info.protocol === "https") &&
          Number.isInteger(info.port) &&
          info.port! > 0 &&
          info.port! <= 65535
        ) {
          onDevice?.({
            alias: info.alias,
            fingerprint,
            version: typeof info.version === "string" ? info.version : "2.0",
            deviceModel: typeof info.deviceModel === "string" ? info.deviceModel : null,
            deviceType: typeof info.deviceType === "string" ? (info.deviceType as DeviceType) : null,
            port: info.port!,
            protocol: info.protocol,
            ip,
            download: info.download === true
          })
        }
      } catch {
        /* Ignore invalid registrations while still returning our device info. */
      }
      return sendJson(res, 200, identity)
    }
    if (req.method === "POST" && url.pathname === "/api/localsend/v2/prepare-upload") {
      let parsed: ReturnType<typeof parseFiles>
      try {
        parsed = parseFiles(await readJson(req))
      } catch {
        return sendJson(res, 400)
      }
      const sessionId = crypto.randomUUID()
      const timer = setTimeout(() => sessions.delete(sessionId), SESSION_TIMEOUT_MS)
      timer.unref()
      const now = new Date()
      const pad = (value: number) => String(value).padStart(2, "0")
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
      const name = `${stamp} - ${safeFilename(parsed.alias).slice(0, 60)} - ${sessionId}`
      const transferDirectory = path.join(directory, name)
      sessions.set(sessionId, { ip, sender: parsed.alias, directory: transferDirectory, files: new Map(parsed.files.map(file => [file.id, file])), timer })
      const tokens = Object.fromEntries(parsed.files.map(file => [file.id, file.token]))
      return sendJson(res, 200, { sessionId, files: tokens })
    }
    if (req.method === "POST" && url.pathname === "/api/localsend/v2/cancel") {
      const id = url.searchParams.get("sessionId") || ""
      const session = sessions.get(id)
      if (!session || session.ip !== ip) return sendJson(res, 403)
      clearTimeout(session.timer)
      sessions.delete(id)
      return sendJson(res, 200)
    }
    if (req.method === "POST" && url.pathname === "/api/localsend/v2/upload") {
      const sessionId = url.searchParams.get("sessionId") || ""
      const session = sessions.get(sessionId)
      const file = session?.files.get(url.searchParams.get("fileId") || "")
      if (!session || session.ip !== ip || !file || file.token !== url.searchParams.get("token") || file.state !== "ready") return sendJson(res, 403)
      file.state = "uploading"
      let filePath: string | undefined
      try {
        const target = await createFile(session.directory, file.fileName)
        filePath = target.filePath
        const hash = crypto.createHash("sha256")
        let size = 0
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > file.size) return callback(new Error("File exceeds declared size"))
            hash.update(chunk)
            callback(null, chunk)
          }
        })
        await pipeline(req, verify, target.file.createWriteStream())
        if (size !== file.size || (file.sha256 && hash.digest("hex") !== file.sha256.toLowerCase())) {
          await fs.promises.unlink(filePath)
          file.state = "ready"
          return sendJson(res, 422)
        }
        file.state = "done"
        if (Array.from(session.files.values()).every(item => item.state === "done")) {
          clearTimeout(session.timer)
          sessions.delete(sessionId)
        }
        try {
          notify(filePath, sessionId, session.sender, Array.from(session.files.values()).filter(item => item.state === "done").map(item => item.fileName))
        } catch {
          /* A notification must not undo a completed transfer. */
        }
        return sendJson(res, 200)
      } catch {
        if (filePath) await fs.promises.unlink(filePath).catch(() => {})
        file.state = "ready"
        if (!res.destroyed) return sendJson(res, 500)
        return
      }
    }
    return sendJson(res, 404)
  }

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListen)
        reject(error)
      }
      const onListen = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListen)
      server.listen(port, "0.0.0.0")
    })
  try {
    await listen(preferredPort)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    await listen(0)
  }
  identity.port = (server.address() as { port: number }).port
  return {
    identity,
    credentials: { key, cert },
    close: async () => {
      for (const session of Array.from(sessions.values())) clearTimeout(session.timer)
      sessions.clear()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
