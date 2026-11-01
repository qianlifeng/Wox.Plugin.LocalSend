import * as https from "https"
import * as http from "http"
import * as os from "os"
import * as dgram from "dgram"
import { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { ReceiverIdentity } from "./receiver"

// LocalSend default configuration
const DEFAULT_PORT = 53317
const MULTICAST_ADDRESS = "224.0.0.167"
let identity: ReceiverIdentity
let credentials: { key: string; cert: string }
let multicastSocket: dgram.Socket | undefined
const multicastDevices = new Map<string, LocalSendDevice>()
let onDeviceFound: ((device: LocalSendDevice) => void) | undefined

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

function getLocalDeviceInfo(announce: boolean): ReceiverIdentity & { announce: boolean } {
  return { ...identity, announce }
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
      ...(protocol === "https" ? credentials : {}),
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
          if (res.statusCode !== 200) return resolve(null)
          const device = JSON.parse(data) as Omit<LocalSendDevice, "ip">
          if (typeof device.alias !== "string" || typeof device.fingerprint !== "string") return resolve(null)
          resolve({
            ...device,
            protocol: device.protocol || protocol,
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

function announce(announceRequest: boolean): void {
  if (!multicastSocket) return
  const message = Buffer.from(JSON.stringify(getLocalDeviceInfo(announceRequest)))
  for (const ip of getLocalIPs()) {
    try {
      multicastSocket.setMulticastInterface(ip)
      multicastSocket.send(message, DEFAULT_PORT, MULTICAST_ADDRESS, () => {})
    } catch {
      /* An interface may not support multicast. */
    }
  }
}

export async function startDiscovery(
  localIdentity: ReceiverIdentity,
  clientCredentials: { key: string; cert: string },
  onError: (error: Error) => void,
  onDevice?: (device: LocalSendDevice) => void
): Promise<() => void> {
  identity = localIdentity
  credentials = clientCredentials
  onDeviceFound = onDevice
  multicastDevices.clear()
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
  multicastSocket = socket
  socket.on("message", (message, remote) => {
    try {
      const device = JSON.parse(message.toString()) as LocalSendDevice & { announce?: boolean }
      if (
        device.fingerprint === identity.fingerprint ||
        typeof device.alias !== "string" ||
        typeof device.fingerprint !== "string" ||
        !device.fingerprint ||
        (device.protocol !== "http" && device.protocol !== "https") ||
        !Number.isInteger(device.port) ||
        device.port < 1 ||
        device.port > 65535
      )
        return
      const { announce: shouldAnnounce, ...info } = device
      const found = { ...info, ip: remote.address }
      multicastDevices.set(device.fingerprint, found)
      onDeviceFound?.(found)
      if (shouldAnnounce === true) announce(false)
    } catch {
      /* Ignore unrelated multicast packets. */
    }
  })
  socket.on("error", onError)
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error)
      socket.once("error", fail)
      socket.bind(DEFAULT_PORT, "0.0.0.0", () => {
        socket.off("error", fail)
        for (const ip of getLocalIPs()) {
          try {
            socket.addMembership(MULTICAST_ADDRESS, ip)
          } catch {
            /* Interface may not support multicast. */
          }
        }
        resolve()
      })
    })
  } catch (error) {
    if (multicastSocket === socket) multicastSocket = undefined
    try {
      socket.close()
    } catch {
      /* Socket may not have bound. */
    }
    throw error
  }
  announce(true)
  return () => {
    if (multicastSocket === socket) multicastSocket = undefined
    socket.close()
    multicastDevices.clear()
    onDeviceFound = undefined
  }
}

export async function scanNetwork(ctx: Context, timeoutMs: number = 5000, api: PublicAPI): Promise<LocalSendDevice[]> {
  await api.Log(ctx, "Info", "Scanning network for devices...")
  const localIPs = getLocalIPs()
  const devices: LocalSendDevice[] = []
  const subnets = new Set(localIPs.map(ip => ip.split(".").slice(0, 3).join(".")))

  for (const subnet of Array.from(subnets)) {
    for (let i = 1; i <= 254; i++) {
      const targetIP = `${subnet}.${i}`
      if (localIPs.includes(targetIP)) continue
      for (const protocol of ["https", "http"] as const) {
        void registerWithDevice(targetIP, DEFAULT_PORT, protocol).then(device => {
          if (device) {
            devices.push(device)
            onDeviceFound?.(device)
          }
        })
      }
    }
  }

  multicastDevices.clear()
  announce(true)
  await new Promise(resolve => setTimeout(resolve, timeoutMs))
  const allDevices = [...devices, ...Array.from(multicastDevices.values())]
  const unique = new Map<string, LocalSendDevice>()
  for (const device of allDevices) unique.set(device.fingerprint || device.ip, device)
  return Array.from(unique.values()).sort((a, b) => a.alias.localeCompare(b.alias) || a.ip.localeCompare(b.ip))
}

export async function findDevices(ctx: Context, timeoutMs: number = 3000, api: PublicAPI): Promise<LocalSendDevice[]> {
  const devices = await scanNetwork(ctx, timeoutMs, api)
  await api.Log(ctx, "Info", "Network scan found devices: " + devices.length)
  return devices
}
