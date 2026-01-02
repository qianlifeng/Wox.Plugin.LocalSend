import * as https from "https"
import * as http from "http"
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { LocalSendDevice } from "./discovery"

// File information
export interface FileInfo {
  id: string
  fileName: string
  size: number
  fileType: string
  sha256?: string
  preview?: string
  metadata?: {
    modified?: string
    accessed?: string
  }
}

// Transfer session
export interface TransferSession {
  sessionId: string
  files: { [fileId: string]: string } // fileId -> token mapping
}

// Sender information
interface SenderInfo {
  alias: string
  version: string
  deviceModel: string | null
  deviceType: string
  fingerprint: string
  port: number
  protocol: string
  download: boolean
}

// Get MIME type
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: { [key: string]: string } = {
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
  return mimeTypes[ext] || "application/octet-stream"
}

// Calculate file SHA256
async function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("data", data => hash.update(data))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

// Generate unique ID
function generateId(): string {
  return crypto.randomUUID()
}

// Get sender information
function getSenderInfo(): SenderInfo {
  return {
    alias: "Wox",
    version: "2.0",
    deviceModel: "Wox",
    deviceType: "desktop",
    fingerprint: generateId(),
    port: 53317,
    protocol: "https",
    download: false
  }
}

// Create FileInfo from file path
export async function createFileInfo(filePath: string): Promise<FileInfo> {
  const stats = fs.statSync(filePath)
  const fileName = path.basename(filePath)
  const sha256 = await calculateSha256(filePath)

  return {
    id: generateId(),
    fileName,
    size: stats.size,
    fileType: getMimeType(filePath),
    sha256,
    metadata: {
      modified: stats.mtime.toISOString(),
      accessed: stats.atime.toISOString()
    }
  }
}

// HTTP request utility
function makeRequest(device: LocalSendDevice, requestPath: string, method: string, body?: string | Buffer, contentType?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": contentType || "application/json"
    }

    if (body) {
      headers["Content-Length"] = Buffer.byteLength(body)
    }

    const options: https.RequestOptions = {
      hostname: device.ip,
      port: device.port || 53317,
      path: requestPath,
      method,
      headers,
      rejectUnauthorized: false, // Ignore self-signed certificates
      timeout: 30000
    }

    const client = device.protocol === "https" ? https : http
    const req = client.request(options, res => {
      let data = ""
      res.on("data", chunk => {
        data += chunk
      })
      res.on("end", () => {
        resolve({ statusCode: res.statusCode || 0, body: data })
      })
    })

    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Request timeout"))
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

// Prepare upload (send metadata)
export async function prepareUpload(device: LocalSendDevice, files: FileInfo[]): Promise<TransferSession> {
  const filesMap: { [id: string]: FileInfo } = {}
  for (const file of files) {
    filesMap[file.id] = file
  }

  const requestBody = {
    info: getSenderInfo(),
    files: filesMap
  }

  const response = await makeRequest(device, "/api/localsend/v2/prepare-upload", "POST", JSON.stringify(requestBody))

  if (response.statusCode === 204) {
    // No transfer needed (file may already exist)
    return { sessionId: "", files: {} }
  }

  if (response.statusCode !== 200) {
    let errorMsg = "Upload rejected"
    switch (response.statusCode) {
      case 400:
        errorMsg = "Invalid request"
        break
      case 401:
        errorMsg = "PIN required"
        break
      case 403:
        errorMsg = "Request rejected by receiver"
        break
      case 409:
        errorMsg = "Receiver is busy with another transfer"
        break
      case 429:
        errorMsg = "Too many requests"
        break
      case 500:
        errorMsg = "Receiver error"
        break
    }
    throw new Error(errorMsg)
  }

  return JSON.parse(response.body) as TransferSession
}

// Upload single file
export async function uploadFile(device: LocalSendDevice, session: TransferSession, fileInfo: FileInfo, filePath: string): Promise<void> {
  const token = session.files[fileInfo.id]
  if (!token) {
    throw new Error(`No token for file: ${fileInfo.fileName}`)
  }

  const queryParams = `sessionId=${encodeURIComponent(session.sessionId)}&fileId=${encodeURIComponent(fileInfo.id)}&token=${encodeURIComponent(token)}`
  const uploadPath = `/api/localsend/v2/upload?${queryParams}`

  // Read file content
  const fileContent = fs.readFileSync(filePath)

  const response = await makeRequest(device, uploadPath, "POST", fileContent, "application/octet-stream")

  if (response.statusCode !== 200 && response.statusCode !== 204) {
    throw new Error(`Upload failed with status ${response.statusCode}: ${response.body}`)
  }
}

// Cancel transfer
export async function cancelTransfer(device: LocalSendDevice, sessionId: string): Promise<void> {
  const path = `/api/localsend/v2/cancel?sessionId=${encodeURIComponent(sessionId)}`
  await makeRequest(device, path, "POST")
}

// High-level API: Send files to device
export async function sendFiles(device: LocalSendDevice, filePaths: string[], onProgress?: (currentIndex: number, totalCount: number, fileName: string) => void): Promise<void> {
  // Create file information
  const fileInfos: FileInfo[] = []
  const filePathMap: Map<string, string> = new Map()

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }
    const info = await createFileInfo(filePath)
    fileInfos.push(info)
    filePathMap.set(info.id, filePath)
  }

  // Prepare upload
  const session = await prepareUpload(device, fileInfos)

  if (!session.sessionId) {
    // No transfer needed
    return
  }

  // Upload each file
  let completed = 0
  for (const fileInfo of fileInfos) {
    if (onProgress) {
      onProgress(completed, fileInfos.length, fileInfo.fileName)
    }

    const filePath = filePathMap.get(fileInfo.id)!
    await uploadFile(device, session, fileInfo, filePath)

    completed++
  }

  // Final progress update
  if (onProgress) {
    onProgress(fileInfos.length, fileInfos.length, "")
  }
}
