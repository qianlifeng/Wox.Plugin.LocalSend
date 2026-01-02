import * as https from "https"
import * as http from "http"
import * as os from "os"
import { v4 as uuidv4 } from "uuid"
import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

// LocalSend default configuration
const DEFAULT_PORT = 53317

// Device type
export type DeviceType = "mobile" | "desktop" | "web" | "headless" | "server"

// LocalSend device information
export interface LocalSendDevice {
  alias: string
  version: string
  deviceModel: string | null
  deviceType: DeviceType | null
  fingerprint: string
  port: number
  protocol: "http" | "https"
  ip: string
  download?: boolean
}

// Local device information
interface DeviceInfo {
  alias: string
  version: string
  deviceModel: string | null
  deviceType: DeviceType
  fingerprint: string
  port: number
  protocol: "http" | "https"
  download: boolean
  announce: boolean
}

// Generate local device info
function getLocalDeviceInfo(announce: boolean): DeviceInfo {
  return {
    alias: os.hostname() || "Wox User",
    version: "2.0",
    deviceModel: os.platform(),
    deviceType: "desktop",
    fingerprint: uuidv4(),
    port: DEFAULT_PORT,
    protocol: "https",
    download: false,
    announce
  }
}

// Get local IP address list
function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces()
  const ips: string[] = []
  for (const name in interfaces) {
    const iface = interfaces[name]
    if (iface) {
      for (const info of iface) {
        if (info.family === "IPv4" && !info.internal) {
          ips.push(info.address)
        }
      }
    }
  }
  return ips
}

// Get device info via HTTP registration
async function registerWithDevice(ip: string, port: number, protocol: "http" | "https"): Promise<LocalSendDevice | null> {
  return new Promise(resolve => {
    const deviceInfo = getLocalDeviceInfo(false)
    const postData = JSON.stringify(deviceInfo)

    const options = {
      hostname: ip,
      port: port,
      path: "/api/localsend/v2/register",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      rejectUnauthorized: false, // Ignore self-signed certificates
      timeout: 1000
    }

    const client = protocol === "https" ? https : http
    const req = client.request(options, res => {
      let data = ""
      res.on("data", chunk => {
        data += chunk
      })
      res.on("end", () => {
        try {
          const device = JSON.parse(data) as Omit<LocalSendDevice, "ip">
          resolve({
            ...device,
            protocol: device.protocol || "https",
            port: device.port || port || 53317,
            ip
          })
        } catch {
          resolve(null)
        }
      })
    })

    req.on("error", () => {
      resolve(null)
    })

    req.on("timeout", () => {
      req.destroy()
      resolve(null)
    })

    req.write(postData)
    req.end()
  })
}

export async function scanNetwork(ctx: Context, timeoutMs: number = 5000, api: PublicAPI): Promise<LocalSendDevice[]> {
  await api.Log(ctx, "Info", "Scanning network for devices...")
  const localIPs = getLocalIPs()
  const devices: LocalSendDevice[] = []
  const promises: Promise<void>[] = []

  for (const localIP of localIPs) {
    const subnet = localIP.split(".").slice(0, 3).join(".")

    // Scan common IP range
    for (let i = 1; i <= 254; i++) {
      const targetIP = `${subnet}.${i}`
      if (localIPs.includes(targetIP)) continue

      // Try HTTPS and HTTP
      for (const protocol of ["https", "http"] as const) {
        promises.push(
          registerWithDevice(targetIP, DEFAULT_PORT, protocol).then(device => {
            if (device) {
              devices.push(device)
            }
          })
        )
      }
    }
  }

  await Promise.race([Promise.all(promises), new Promise(resolve => setTimeout(resolve, timeoutMs))])

  return devices
}

export async function findDevices(ctx: Context, timeoutMs: number = 3000, api: PublicAPI): Promise<LocalSendDevice[]> {
  await api.Log(ctx, "Info", "Discovering devices...")
  const devices = await scanNetwork(ctx, timeoutMs, api)
  await api.Log(ctx, "Info", "HTTP network scan found devices: " + devices.length)
  return devices
}
