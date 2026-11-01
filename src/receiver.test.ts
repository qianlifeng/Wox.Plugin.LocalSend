import * as crypto from "crypto"
import * as fs from "fs"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import { startReceiver } from "./receiver"
import { ReceiveHistory } from "./history"
import { configureSender, prepareUpload } from "./transfer"

function request(port: number, method: string, route: string, body?: string | Buffer, credentials?: { key: string; cert: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path: route, method, rejectUnauthorized: false, ...credentials }, res => {
      let content = ""
      res.on("data", chunk => {
        content += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode || 0, body: content }))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

it("advertises a TLS receiver and safely saves verified files without overwriting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wox-localsend-test-"))
  const saveDir = path.join(root, "downloads")
  const history = new ReceiveHistory(saveDir)
  const notify = jest.fn((filePath: string, sessionId: string, sender: string) => history.record({ filePath, sessionId, sender, receivedAt: new Date().toISOString() }))
  const discovered = jest.fn()
  const receiver = await startReceiver(path.join(root, "cache"), saveDir, notify, 0, discovered)
  try {
    const { port, fingerprint, alias } = receiver.identity
    expect(alias).toBe(`Wox - ${os.hostname()}`)
    expect(fingerprint).toMatch(/^[A-F0-9]{64}$/)
    expect(JSON.parse((await request(port, "POST", "/api/localsend/v2/register", "{}")).body).fingerprint).toBe(fingerprint)
    const remote = await startReceiver(path.join(root, "peer-cache"), saveDir, () => {}, 0)
    try {
      const announcement = { ...remote.identity, alias: "Phone", fingerprint: "untrusted-value" }
      expect((await request(port, "POST", "/api/localsend/v2/register", JSON.stringify(announcement), remote.credentials)).status).toBe(200)
      expect(discovered).toHaveBeenCalledWith(expect.objectContaining({ alias: "Phone", fingerprint: remote.identity.fingerprint, ip: "127.0.0.1", port: remote.identity.port }))
    } finally {
      await remote.close()
    }
    const peer = https.createServer({ ...receiver.credentials, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const certificate = (req.socket as import("tls").TLSSocket).getPeerCertificate()
      const peerFingerprint = crypto.createHash("sha256").update(certificate.raw).digest("hex").toUpperCase()
      let requestBody = ""
      req.on("data", chunk => {
        requestBody += chunk
      })
      req.on("end", () => {
        const info = JSON.parse(requestBody).info as { fingerprint: string }
        expect(peerFingerprint).toBe(fingerprint)
        expect(info.fingerprint).toBe(peerFingerprint)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ sessionId: "test", files: {} }))
      })
    })
    await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve))
    try {
      configureSender(receiver.identity, receiver.credentials)
      const peerPort = (peer.address() as { port: number }).port
      const session = await prepareUpload({ ...receiver.identity, ip: "127.0.0.1", port: peerPort }, [])
      expect(session.sessionId).toBe("test")
    } finally {
      await new Promise<void>(resolve => peer.close(() => resolve()))
    }
    fs.mkdirSync(saveDir)
    fs.writeFileSync(path.join(saveDir, "hello.txt"), "original")
    const content = "new content"
    const digest = crypto.createHash("sha256").update(content).digest("hex")
    const metadata = JSON.stringify({
      info: { alias: "Phone" },
      files: {
        a: { id: "a", fileName: "../hello.txt", size: content.length, sha256: digest },
        c: { id: "c", fileName: "../hello.txt", size: content.length, sha256: digest },
        d: { id: "d", fileName: ".localsend.json", size: content.length, sha256: digest }
      }
    })
    const prepared = await request(port, "POST", "/api/localsend/v2/prepare-upload", metadata)
    expect(prepared.status).toBe(200)
    const session = JSON.parse(prepared.body) as { sessionId: string; files: Record<string, string> }
    const upload = `/api/localsend/v2/upload?sessionId=${session.sessionId}&fileId=a&token=${session.files.a}`
    expect((await request(port, "POST", upload.replace(session.files.a, "bad"), content)).status).toBe(403)
    const [firstUpload, secondUpload] = await Promise.all([
      request(port, "POST", upload, content),
      request(port, "POST", `/api/localsend/v2/upload?sessionId=${session.sessionId}&fileId=c&token=${session.files.c}`, content)
    ])
    expect(firstUpload.status).toBe(200)
    expect(secondUpload.status).toBe(200)
    expect(fs.readFileSync(path.join(saveDir, "hello.txt"), "utf8")).toBe("original")
    const firstPath = notify.mock.calls[0][0]
    const transferDir = path.dirname(firstPath)
    expect(path.dirname(transferDir)).toBe(saveDir)
    expect(fs.readFileSync(firstPath, "utf8")).toBe(content)
    expect(notify).toHaveBeenCalledWith(firstPath, session.sessionId, "Phone", expect.arrayContaining(["hello.txt"]))
    expect(notify).toHaveBeenCalledWith(path.join(transferDir, "hello.txt"), session.sessionId, "Phone", expect.arrayContaining(["hello.txt"]))
    expect(notify).toHaveBeenCalledWith(path.join(transferDir, "hello (1).txt"), session.sessionId, "Phone", expect.arrayContaining(["hello.txt"]))
    expect((await request(port, "POST", `/api/localsend/v2/upload?sessionId=${session.sessionId}&fileId=d&token=${session.files.d}`, content)).status).toBe(200)
    expect(notify).toHaveBeenCalledWith(path.join(transferDir, "_.localsend.json"), session.sessionId, "Phone", ["hello.txt", "hello.txt", "_.localsend.json"])
    expect(
      history
        .list()[0]
        .files.map(file => path.basename(file))
        .sort()
    ).toEqual(["_.localsend.json", "hello (1).txt", "hello.txt"])
    expect((await request(port, "POST", upload, content)).status).toBe(403)

    const badMeta = JSON.stringify({ info: { alias: "Phone" }, files: { b: { id: "b", fileName: "bad.txt", size: content.length, sha256: "0".repeat(64) } } })
    const bad = JSON.parse((await request(port, "POST", "/api/localsend/v2/prepare-upload", badMeta)).body) as { sessionId: string; files: Record<string, string> }
    expect((await request(port, "POST", `/api/localsend/v2/upload?sessionId=${bad.sessionId}&fileId=b&token=${bad.files.b}`, content)).status).toBe(422)
    expect(history.list()).toHaveLength(1)
  } finally {
    await receiver.close()
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("wox-localsend-test-")) fs.rmSync(root, { recursive: true, force: true })
  }
}, 20000)
