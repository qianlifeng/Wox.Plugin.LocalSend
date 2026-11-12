import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import { LocalSendDevice } from "./discovery"
import { ReceiverIdentity } from "./receiver"
import { configureSender, FileInfo, sendFiles, sendText } from "./transfer"

it("reports success only after upload and reports handled transfer failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wox-send-test-"))
  const file = path.join(root, "test.txt")
  fs.writeFileSync(file, "hello")
  let mode: "success" | "upload-fails" | "prepare-fails" | "no-upload" = "success"
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", chunk => {
      body += chunk
    })
    req.on("end", () => {
      if (req.url === "/api/localsend/v2/prepare-upload") {
        if (mode === "prepare-fails") {
          res.writeHead(403).end()
          return
        }
        if (mode === "no-upload") {
          res.writeHead(204).end()
          return
        }
        const files = (JSON.parse(body) as { files: Record<string, unknown> }).files
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId: "session", files: Object.fromEntries(Object.keys(files).map(id => [id, "token"])) }))
      } else {
        res.writeHead(mode === "upload-fails" ? 500 : 200).end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as { port: number }).port
    const device = { ip: "127.0.0.1", port, protocol: "http" } as LocalSendDevice
    configureSender({ alias: "Wox" } as ReceiverIdentity, { key: "", cert: "" })
    const progress = jest.fn().mockResolvedValue(undefined)
    const errors = jest.fn().mockResolvedValue(undefined)
    expect(await sendFiles(device, [file], progress, errors)).toBe(true)
    expect(progress).toHaveBeenCalledWith(0, 1, "test.txt")
    expect(errors).not.toHaveBeenCalled()

    mode = "upload-fails"
    expect(await sendFiles(device, [file], progress, errors)).toBe(false)
    expect(errors).toHaveBeenLastCalledWith(expect.any(Error), "test.txt")
    mode = "prepare-fails"
    expect(await sendFiles(device, [file], progress, errors)).toBe(false)
    expect(errors).toHaveBeenLastCalledWith(expect.any(Error), "")
    mode = "no-upload"
    expect(await sendFiles(device, [file], progress, errors)).toBe(true)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("wox-send-test-")) fs.rmSync(root, { recursive: true, force: true })
  }
})

it("sends native UTF-8 messages and uploads the original bytes when requested", async () => {
  const prepared: FileInfo[] = []
  const uploaded: Buffer[] = []
  let acceptPreview = true
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      if (req.url === "/api/localsend/v2/prepare-upload") {
        const file = Object.values((JSON.parse(body.toString("utf8")) as { files: Record<string, FileInfo> }).files)[0]
        prepared.push(file)
        if (file.preview !== undefined && acceptPreview) {
          res.writeHead(204).end()
        } else {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId: "session", files: { [file.id]: "token" } }))
        }
      } else {
        uploaded.push(body)
        res.writeHead(200).end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as { port: number }).port
    const device = { ip: "127.0.0.1", port, protocol: "http" } as LocalSendDevice
    configureSender({ alias: "Wox" } as ReceiverIdentity, { key: "", cert: "" })
    const message = "  剪贴板\r\nHello 🙂\n "
    expect(await sendText(device, message)).toBe(true)
    expect(prepared[0]).toMatchObject({ fileType: "text/plain", size: Buffer.byteLength(message), preview: message })
    expect(uploaded).toEqual([])

    acceptPreview = false
    expect(await sendText(device, message)).toBe(true)
    expect(uploaded[0]).toEqual(Buffer.from(message))

    acceptPreview = true
    const longMessage = "测".repeat(22_000)
    expect(await sendText(device, longMessage)).toBe(true)
    expect(prepared[2]).toMatchObject({ fileName: "message.txt", size: Buffer.byteLength(longMessage) })
    expect(prepared[2].preview).toBeUndefined()
    expect(uploaded[1]).toEqual(Buffer.from(longMessage))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
