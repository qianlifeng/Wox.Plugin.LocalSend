import { EventEmitter } from "events"
import { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { scanNetwork, startDiscovery } from "./discovery"
import { ReceiverIdentity } from "./receiver"

jest.mock("uuid", () => ({ v4: () => "local-fingerprint" }))
jest.mock("os", () => ({
  hostname: () => "Computer",
  platform: () => "win32",
  networkInterfaces: () => ({ wlan: [{ family: "IPv4", internal: false, address: "192.168.1.10" }] })
}))
jest.mock("https", () => ({
  request: () => {
    const req = new EventEmitter()
    return Object.assign(req, {
      write: () => {},
      end: () => setImmediate(() => req.emit("error", new Error("unavailable")))
    })
  }
}))
jest.mock("http", () => ({
  request: (options: { hostname: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter()
    return Object.assign(req, {
      write: () => {},
      end: () =>
        setImmediate(() => {
          if (options.hostname !== "192.168.1.20") {
            req.emit("error", new Error("unavailable"))
            return
          }
          const res = Object.assign(new EventEmitter(), { statusCode: 200 })
          callback(res)
          res.emit("data", JSON.stringify({ alias: "Phone", fingerprint: "phone", version: "2.0" }))
          res.emit("end")
        })
    })
  }
}))
jest.mock("dgram", () => ({
  createSocket: () => {
    const socket = new EventEmitter()
    return Object.assign(socket, {
      bind: (_port: number, _address: string, callback: () => void) => setImmediate(callback),
      addMembership: () => {},
      setMulticastInterface: () => {},
      send: () =>
        setImmediate(() => {
          socket.emit("message", Buffer.from(JSON.stringify({ alias: "Tablet", fingerprint: "tablet", protocol: "https", port: 53318 })), { address: "192.168.1.30" })
          socket.emit("message", Buffer.from(JSON.stringify({ alias: "Phone", fingerprint: "phone", protocol: "http", port: 53317 })), { address: "192.168.1.20" })
        }),
      close: () => {}
    })
  }
}))

it("combines and deduplicates HTTP and multicast discoveries", async () => {
  const api = { Log: jest.fn().mockResolvedValue(undefined) } as unknown as PublicAPI
  const observed = jest.fn()
  const close = await startDiscovery({ fingerprint: "local-fingerprint" } as ReceiverIdentity, { key: "key", cert: "cert" }, () => {}, observed)
  const devices = await scanNetwork({} as Context, 100, api)
  close()
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ alias: "Tablet", ip: "192.168.1.30" }))
  expect(devices.map(device => [device.alias, device.ip, device.port, device.protocol])).toEqual([
    ["Phone", "192.168.1.20", 53317, "http"],
    ["Tablet", "192.168.1.30", 53318, "https"]
  ])
})
