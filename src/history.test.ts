import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ReceiveHistory } from "./history"

it("reads transfers from their folders and omits deleted directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wox-receive-history-"))
  try {
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    for (const file of [path.join(first, "one.txt"), path.join(first, "two.txt"), path.join(second, "other.txt")]) fs.writeFileSync(file, "data")
    const history = new ReceiveHistory(root)
    history.record({ sessionId: "first", sender: "Phone", filePath: path.join(first, "one.txt"), receivedAt: "2026-11-01T00:00:00.000Z" })
    history.record({ sessionId: "second", sender: "Tablet", filePath: path.join(second, "other.txt"), receivedAt: "2026-11-01T00:01:00.000Z" })
    history.record({ sessionId: "first", sender: "Phone", filePath: path.join(first, "two.txt"), receivedAt: "2026-11-01T00:02:00.000Z" })
    expect(new ReceiveHistory(root).list()).toEqual([
      { sessionId: "second", sender: "Tablet", receivedAt: "2026-11-01T00:01:00.000Z", directory: second, files: [path.join(second, "other.txt")] },
      { sessionId: "first", sender: "Phone", receivedAt: "2026-11-01T00:00:00.000Z", directory: first, files: [path.join(first, "one.txt"), path.join(first, "two.txt")] }
    ])
    expect(fs.existsSync(path.join(first, ".localsend.json"))).toBe(true)
    fs.rmSync(second, { recursive: true })
    expect(history.list().map(item => item.sessionId)).toEqual(["first"])
    fs.unlinkSync(path.join(first, "one.txt"))
    expect(history.list()[0].files).toEqual([path.join(first, "two.txt")])
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("wox-receive-history-")) fs.rmSync(root, { recursive: true, force: true })
  }
})
