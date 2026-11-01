import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"

const METADATA_FILE = ".localsend.json"

export interface ReceivedFile {
  sessionId: string
  sender: string
  filePath: string
  receivedAt: string
}

export interface ReceivedTransfer {
  sessionId: string
  sender: string
  receivedAt: string
  directory: string
  files: string[]
}

type Metadata = { sessionId: string; sender: string; receivedAt: string; files: string[] }

function readMetadata(directory: string): Metadata | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(directory, METADATA_FILE), "utf8")) as Metadata
    if (
      typeof data.sessionId !== "string" ||
      typeof data.sender !== "string" ||
      typeof data.receivedAt !== "string" ||
      Number.isNaN(Date.parse(data.receivedAt)) ||
      !Array.isArray(data.files) ||
      !data.files.every(file => typeof file === "string" && file !== "." && file !== ".." && path.basename(file) === file)
    )
      return undefined
    return data
  } catch {
    return undefined
  }
}

export class ReceiveHistory {
  constructor(private readonly root: string) {}

  record(event: ReceivedFile): void {
    const directory = path.dirname(event.filePath)
    if (path.dirname(directory) !== this.root) throw new Error("Invalid receive directory")
    const previous = readMetadata(directory)
    const target = path.join(directory, METADATA_FILE)
    if (!previous && fs.existsSync(target)) throw new Error("Invalid transfer metadata")
    if (previous && previous.sessionId !== event.sessionId) throw new Error("Mismatched transfer metadata")
    const metadata: Metadata = previous || { sessionId: event.sessionId, sender: event.sender, receivedAt: event.receivedAt, files: [] }
    const filename = path.basename(event.filePath)
    if (!metadata.files.includes(filename)) metadata.files.push(filename)
    const temp = path.join(directory, `.localsend-${crypto.randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temp, JSON.stringify(metadata), { flag: "wx", mode: 0o600 })
      fs.renameSync(temp, target)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }

  list(): ReceivedTransfer[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const transfers: ReceivedTransfer[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = path.join(this.root, entry.name)
      const metadata = readMetadata(directory)
      if (!metadata) continue
      const files = metadata.files
        .map(name => path.join(directory, name))
        .filter(file => {
          try {
            return fs.statSync(file).isFile()
          } catch {
            return false
          }
        })
      transfers.push({ ...metadata, directory, files })
    }
    return transfers.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  }
}
