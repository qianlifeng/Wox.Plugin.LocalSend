import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"
import { findDevices, LocalSendDevice, startDiscovery } from "./discovery"
import { startReceiver } from "./receiver"
import { ReceiveHistory } from "./history"
import { spawn } from "child_process"
import * as os from "os"
import { configureSender, sendFiles } from "./transfer"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as util from "util"

let api: PublicAPI
// The packaged SDK predates Wox 2.5.0; the runtime supplies this API.
type ToastAPI = PublicAPI & {
  ShowToastMsg(ctx: Context, option: { Message: string; Title?: string; Action?: { Name: string; Action(ctx: Context): Promise<void> } }): Promise<{ Success: boolean; ErrMsg: string }>
}
let cachedDevices: LocalSendDevice[] = []
let hasScanned = false
let currentScan: Promise<void> | undefined
let visibleResult: { ctx: Context; id: string; devices: string; waiting: boolean } | undefined
let visibleHistory: { ctx: Context; id: string } | undefined
let receiveHistory: ReceiveHistory | undefined
const receiveDirectory = path.join(os.homedir(), "Downloads", "LocalSend")
const SCAN_INTERVAL_MS = 60_000
const QUERY_SCAN_INTERVAL_MS = 15_000
const DEVICE_TTL_MS = 2 * 60_000
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".svg"])
const COPYABLE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mpeg", ".mpg"])
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"])
const SUCCESS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#027A48"/><path d="M5.5 10l3 3 6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
const observedDevices = new Map<string, { device: LocalSendDevice; lastSeen: number }>()
let lastScanStartedAt = 0
let scanTimer: NodeJS.Timeout | undefined
let stopped = false

function mergeDevices(devices: LocalSendDevice[], expire: boolean): void {
  const now = Date.now()
  for (const device of devices) {
    const fingerprint = /^[a-f0-9]{64}$/i.test(device.fingerprint) ? device.fingerprint.toUpperCase() : device.fingerprint
    const key = fingerprint || device.ip
    observedDevices.set(key, {
      device: {
        alias: device.alias,
        version: device.version || "2.0",
        deviceModel: device.deviceModel || null,
        deviceType: device.deviceType || null,
        fingerprint,
        port: device.port,
        protocol: device.protocol,
        ip: device.ip,
        download: device.download === true
      },
      lastSeen: now
    })
  }
  if (expire) {
    for (const [key, entry] of Array.from(observedDevices.entries())) {
      if (now - entry.lastSeen >= DEVICE_TTL_MS) observedDevices.delete(key)
    }
  }
  cachedDevices = Array.from(observedDevices.values(), entry => entry.device).sort((a, b) => a.alias.localeCompare(b.alias) || a.ip.localeCompare(b.ip))
}

async function refreshVisibleDevices(): Promise<void> {
  const visible = visibleResult
  if (!visible || (visible.devices === JSON.stringify(cachedDevices) && !(visible.waiting && !currentScan && hasScanned))) return
  if ((await api.GetUpdatableResult(visible.ctx, visible.id)) && visibleResult === visible) {
    await api.RefreshQuery(visible.ctx, { PreserveSelectedIndex: true })
  }
}

function observeDevice(device: LocalSendDevice): void {
  if (stopped) return
  mergeDevices([device], false)
  void refreshVisibleDevices().catch(() => {})
}

function refreshDevices(ctx: Context): Promise<void> {
  if (currentScan) return currentScan
  lastScanStartedAt = Date.now()
  currentScan = (async () => {
    try {
      const devices = await findDevices(ctx, 3000, api)
      if (stopped) return
      mergeDevices(devices, true)
      hasScanned = true
    } catch (error) {
      if (!stopped) await api.Log(ctx, "Error", `Device discovery failed: ${error}`)
    } finally {
      currentScan = undefined
    }
    if (!stopped) await refreshVisibleDevices()
  })()
  return currentScan
}

function retryDiscovery(resultId: string) {
  return async (ctx: Context) => {
    try {
      await api.UpdateResult(ctx, { Id: resultId, Title: "i18n:scanning", SubTitle: "i18n:please_wait", Actions: [] })
    } catch {
      // The query may have changed before the action ran.
    }
    await refreshDevices(ctx)
    if (visibleResult?.id === resultId && (await api.GetUpdatableResult(ctx, resultId))) {
      await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
    }
  }
}

function startBackgroundDiscovery(ctx: Context): void {
  const scan = async () => {
    await refreshDevices(ctx)
    if (!stopped) scanTimer = setTimeout(scan, SCAN_INTERVAL_MS).unref()
  }
  void scan()
}

// Expand directories to their files recursively
function expandDirectories(paths: string[]): string[] {
  const result: string[] = []

  for (const p of paths) {
    try {
      const stat = fs.statSync(p)
      if (stat.isDirectory()) {
        // Recursively get all files in directory
        const entries = fs.readdirSync(p)
        for (const entry of entries) {
          const fullPath = path.join(p, entry)
          const expanded = expandDirectories([fullPath])
          result.push(...expanded)
        }
      } else if (stat.isFile()) {
        result.push(p)
      }
    } catch {
      // Skip files that can't be accessed
    }
  }

  return result
}

const createSendAction = (targetDevice: LocalSendDevice, files: string[], resultId: string) => {
  return async (actionCtx: Context) => {
    visibleResult = undefined
    await api.Log(actionCtx, "Info", `Sending ${files.length} file(s) to ${targetDevice.alias}...`)

    // Helper to update UI
    const updateProgress = async (idx: number, total: number, currentFile: string) => {
      await api.Log(actionCtx, "Info", `Sending ${idx + 1}/${total}: ${currentFile}`)
      await api.Log(actionCtx, "Debug", `Trying to update result with id: ${resultId}`)
      try {
        const result = await api.GetUpdatableResult(actionCtx, resultId)
        if (result) {
          if (idx < total) {
            const sendingTpl = await api.GetTranslation(actionCtx, "sending")
            const targetTpl = await api.GetTranslation(actionCtx, "target")
            result.Tails = []
            result.Title = util.format(sendingTpl, idx + 1, total, currentFile)
            result.SubTitle = util.format(targetTpl, targetDevice.alias)
          } else {
            const sentSuccessTpl = await api.GetTranslation(actionCtx, "sent_success")
            const filesUnit = await api.GetTranslation(actionCtx, "files_unit")
            const targetTpl = await api.GetTranslation(actionCtx, "target")
            result.Tails = [
              {
                Type: "image",
                Image: { ImageType: "svg", ImageData: SUCCESS_ICON },
                ImageWidth: 20,
                ImageHeight: 20,
                Tooltip: await api.GetTranslation(actionCtx, "send_complete")
              }
            ]
            result.Title = util.format(sentSuccessTpl, total, filesUnit)
            result.SubTitle = util.format(targetTpl, targetDevice.alias)
          }
          await api.UpdateResult(actionCtx, result)
        } else {
          await api.Log(actionCtx, "Error", "Failed to update result: Result not found")
        }
      } catch (error) {
        await api.Log(actionCtx, "Error", "Failed to update result: " + error)
      }
    }

    try {
      // Initial status
      await updateProgress(0, files.length, "i18n:preparing")

      const sent = await sendFiles(
        targetDevice,
        files,
        async (current, total, fileName) => {
          await updateProgress(current, total, fileName)
        },
        async (error, fileName) => {
          const errorMsg = error instanceof Error ? error.message : "Unknown error"
          try {
            const result = await api.GetUpdatableResult(actionCtx, resultId)
            if (result) {
              result.Title = "i18n:failed_to_send"
              result.Tails = []
              const errorSendingTpl = await api.GetTranslation(actionCtx, "error_sending")
              result.SubTitle = fileName ? util.format(errorSendingTpl, fileName, errorMsg) : errorMsg
              result.Actions = [
                {
                  Name: "i18n:retry_send",
                  PreventHideAfterAction: true,
                  Action: createSendAction(targetDevice, files, resultId)
                },
                {
                  Name: "i18n:refresh_devices",
                  PreventHideAfterAction: true,
                  Action: async () => {
                    await refreshDevices(actionCtx)
                    await api.RefreshQuery(actionCtx, { PreserveSelectedIndex: true })
                  }
                }
              ]
              await api.UpdateResult(actionCtx, result)
            }
          } catch {
            // Ignore error
          }
        }
      )

      if (!sent) return
      await updateProgress(files.length, files.length, "")
      try {
        const successTpl = await api.GetTranslation(actionCtx, "successfully_sent")
        const filesUnit = await api.GetTranslation(actionCtx, "files_unit")
        await api.Notify(actionCtx, util.format(successTpl, files.length, filesUnit, targetDevice.alias))
        await api.Log(actionCtx, "Info", `Successfully sent files to ${targetDevice.alias}`)
      } catch {
        // A notification failure must not change the transfer outcome.
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      await api.Notify(actionCtx, `Failed to send files: ${errorMsg}`)
      await api.Log(actionCtx, "Error", `Failed to send files: ${errorMsg}`)

      // Show error in result
      try {
        const result = await api.GetUpdatableResult(actionCtx, resultId)
        if (result) {
          result.Title = "i18n:failed_to_send"
          result.Tails = []
          result.SubTitle = errorMsg
          await api.UpdateResult(actionCtx, result)
        }
      } catch {
        // Ignore error
      }
    }
  }
}

export const plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    await api.Log(ctx, "Info", "LocalSend plugin initialized")
    stopped = false
    let closeDiscovery: (() => void) | undefined
    let closeReceiver: (() => Promise<void>) | undefined
    let receiveWatcher: fs.FSWatcher | undefined
    let notificationQueue = Promise.resolve()
    const refreshReceive = () => {
      const visible = visibleHistory
      if (!visible) return
      void api
        .GetUpdatableResult(visible.ctx, visible.id)
        .then(async result => {
          if (result && visibleHistory === visible) await api.RefreshQuery(visible.ctx, { PreserveSelectedIndex: true })
        })
        .catch(() => {})
    }
    const watchReceiveDirectory = () => {
      if (stopped || receiveWatcher || !fs.existsSync(receiveDirectory)) return
      try {
        receiveWatcher = fs.watch(receiveDirectory, { persistent: false }, () => {
          if (!fs.existsSync(receiveDirectory)) {
            receiveWatcher?.close()
            receiveWatcher = undefined
          }
          refreshReceive()
        })
        receiveWatcher.on("error", error => {
          receiveWatcher?.close()
          receiveWatcher = undefined
          void api.Log(ctx, "Error", `Receive folder watcher failed: ${error}`).catch(() => {})
        })
      } catch (error) {
        void api.Log(ctx, "Error", `Receive folder watcher failed: ${error}`).catch(() => {})
      }
    }
    await api.OnUnload(ctx, async () => {
      stopped = true
      if (scanTimer) clearTimeout(scanTimer)
      closeDiscovery?.()
      receiveWatcher?.close()
      await closeReceiver?.()
    })
    try {
      const cacheDir = await api.GetCacheFolder(ctx)
      try {
        receiveHistory = new ReceiveHistory(receiveDirectory)
        watchReceiveDirectory()
      } catch (error) {
        await api.Log(ctx, "Error", `Failed to load receive history: ${error}`)
      }
      const receiver = await startReceiver(
        cacheDir,
        receiveDirectory,
        (filePath, sessionId, sender, receivedFiles) => {
          try {
            receiveHistory?.record({ filePath, sessionId, sender, receivedAt: new Date().toISOString() })
          } catch (error) {
            void api.Log(ctx, "Error", `Failed to save receive history: ${error}`).catch(() => {})
          }
          watchReceiveDirectory()
          refreshReceive()
          notificationQueue = notificationQueue.then(async () => {
            const counts = { image: 0, video: 0, audio: 0, file: 0 }
            for (const file of receivedFiles) {
              const extension = path.extname(file).toLowerCase()
              const type = IMAGE_EXTENSIONS.has(extension) ? "image" : VIDEO_EXTENSIONS.has(extension) ? "video" : AUDIO_EXTENSIONS.has(extension) ? "audio" : "file"
              counts[type]++
            }
            const parts = await Promise.all(
              (Object.entries(counts) as Array<[keyof typeof counts, number]>).filter(([, count]) => count > 0).map(async ([type, count]) => {
                const template = await api.GetTranslation(ctx, `received_${type}_${count === 1 ? "one" : "many"}`)
                return util.format(template, count)
              })
            )
            const result = await (api as ToastAPI).ShowToastMsg(ctx, {
              Title: "i18n:received_title",
              Message: parts.join(" · "),
              Action: {
                Name: "i18n:view_receive_history",
                Action: async actionCtx => {
                  await api.ShowApp(actionCtx)
                  await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: "receive " })
                }
              }
            })
            if (!result.Success) await api.Log(ctx, "Error", `Could not show received file notification: ${result.ErrMsg}`)
          }).catch(error => {
            void api.Log(ctx, "Error", `Could not show received file notification: ${error}`).catch(() => {})
          })
        },
        53317,
        observeDevice
      )
      closeReceiver = receiver.close
      if (stopped) {
        await receiver.close()
        return
      }
      configureSender(receiver.identity, receiver.credentials)
      try {
        closeDiscovery = await startDiscovery(
          receiver.identity,
          receiver.credentials,
          error => {
            void api.Log(ctx, "Error", `LocalSend multicast failed: ${error}`).catch(() => {})
          },
          observeDevice
        )
      } catch (error) {
        await api.Log(ctx, "Error", `LocalSend multicast failed: ${error}`)
      }
      if (stopped) {
        closeDiscovery?.()
        await receiver.close()
        return
      }
      await api.Log(ctx, "Info", `LocalSend receiver listening as ${receiver.identity.alias} on port ${receiver.identity.port}`)
      startBackgroundDiscovery(ctx)
    } catch (error) {
      await api.Log(ctx, "Error", `LocalSend receiver failed: ${error}`)
      await api.Notify(ctx, `LocalSend receiver failed: ${error}`)
    }
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    if (query.Type === "input" && query.TriggerKeyword === "receive") {
      visibleResult = undefined
      return receiveHistoryResults(ctx, query.Search)
    }
    visibleHistory = undefined
    let filePaths: string[] = []
    if (query.Type === "selection") {
      if (!query.Selection?.FilePaths?.length) return []
      filePaths = expandDirectories(query.Selection.FilePaths)
      if (filePaths.length === 0) {
        return [{ Title: "i18n:no_files", SubTitle: "i18n:folders_empty", Icon: { ImageType: "relative", ImageData: "images/app.png" } }]
      }
    } else if (query.Search.trim() !== "") {
      visibleResult = undefined
      return []
    }

    if (!stopped && !currentScan && Date.now() - lastScanStartedAt >= QUERY_SCAN_INTERVAL_MS) {
      void refreshDevices(ctx)
    }
    const devices = cachedDevices
    const waiting = devices.length === 0 && (!hasScanned || !!currentScan)
    const resultId = crypto.randomUUID()
    const results: Result[] = devices.length
      ? await devicesToResults(ctx, devices, filePaths)
      : [
          {
            Id: resultId,
            Title: waiting ? "i18n:scanning" : "i18n:no_devices_found",
            SubTitle: waiting ? "i18n:please_wait" : "i18n:check_localsend",
            Icon: { ImageType: "relative", ImageData: "images/app.png" },
            Actions: !waiting
              ? [
                  {
                    Name: "i18n:retry",
                    IsDefault: true,
                    PreventHideAfterAction: true,
                    Action: retryDiscovery(resultId)
                  }
                ]
              : []
          }
        ]
    visibleResult = { ctx, id: results[0].Id!, devices: JSON.stringify(devices), waiting }
    return results
  }
} satisfies Plugin

async function receiveHistoryResults(ctx: Context, search: string): Promise<Result[]> {
  const term = search.trim().toLowerCase()
  const transfers = (receiveHistory?.list() || []).filter(
    transfer => !term || transfer.sender.toLowerCase().includes(term) || transfer.files.some(file => path.basename(file).toLowerCase().includes(term))
  )
  const [fromTemplate, countTemplate] = await Promise.all([api.GetTranslation(ctx, "receive_sender"), api.GetTranslation(ctx, "receive_count")])
  const now = new Date()
  const results: Result[] = transfers.map(transfer => {
    const received = new Date(transfer.receivedAt)
    const today = received.getFullYear() === now.getFullYear() && received.getMonth() === now.getMonth() && received.getDate() === now.getDate()
    const time = today
      ? received.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : received.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    return {
      Id: crypto.randomUUID(),
      IdentityKey: `receive:${transfer.sessionId}`,
      Title: transfer.files.length ? path.basename(transfer.files[0]) : "i18n:receive_no_files",
      SubTitle: `${util.format(fromTemplate, transfer.sender)} · ${time}`,
      Group: today ? "i18n:receive_today" : "i18n:receive_history",
      GroupScore: today ? 2 : 1,
      Score: received.getTime(),
      Tails: transfer.files.length > 1 ? [{ Type: "text", Text: util.format(countTemplate, transfer.files.length) }] : [],
      Icon: { ImageType: "relative", ImageData: "images/app.png" },
      Preview:
        transfer.files.length === 1 ? { PreviewType: "file", PreviewData: transfer.files[0] } : { PreviewType: "text", PreviewData: transfer.files.map(file => `• ${path.basename(file)}`).join("\n") },
      Actions: [
        {
          Name: "i18n:open_receive_folder",
          IsDefault: true,
          Action: async actionCtx => {
            try {
              await fs.promises.access(transfer.directory)
              const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open"
              await new Promise<void>((resolve, reject) => {
                const child = spawn(command, [transfer.directory], { detached: true, stdio: "ignore" })
                child.once("error", reject)
                child.once("spawn", () => {
                  child.unref()
                  resolve()
                })
              })
            } catch (error) {
              const template = await api.GetTranslation(actionCtx, "open_folder_failed")
              await api.Notify(actionCtx, util.format(template, String(error)))
            }
          }
        },
        ...(transfer.files.length === 1 && path.extname(transfer.files[0]).toLowerCase() === ".txt"
          ? [
              {
                Name: "i18n:copy_text",
                Icon: { ImageType: "svg" as const, ImageData: COPY_ICON },
                Action: async (actionCtx: Context) => {
                  try {
                    const text = await fs.promises.readFile(transfer.files[0], "utf8")
                    await api.Copy(actionCtx, { type: "text", text })
                  } catch (error) {
                    const template = await api.GetTranslation(actionCtx, "copy_text_failed")
                    await api.Notify(actionCtx, util.format(template, String(error)))
                  }
                }
              }
            ]
          : []),
        ...(transfer.files.length === 1 && COPYABLE_IMAGE_EXTENSIONS.has(path.extname(transfer.files[0]).toLowerCase())
          ? [
              {
                Name: "i18n:copy_image",
                Icon: { ImageType: "svg" as const, ImageData: COPY_ICON },
                Action: async (actionCtx: Context) => {
                  try {
                    await fs.promises.access(transfer.files[0], fs.constants.R_OK)
                    await api.Copy(actionCtx, { type: "image", text: "", woxImage: { ImageType: "absolute", ImageData: transfer.files[0] } })
                  } catch (error) {
                    const template = await api.GetTranslation(actionCtx, "copy_image_failed")
                    await api.Notify(actionCtx, util.format(template, String(error)))
                  }
                }
              }
            ]
          : [])
      ]
    }
  })
  if (!results.length) results.push({ Id: crypto.randomUUID(), Title: "i18n:receive_empty", Icon: { ImageType: "relative", ImageData: "images/app.png" } })
  visibleHistory = { ctx, id: results[0].Id! }
  return results
}

async function devicesToResults(ctx: Context, devices: LocalSendDevice[], filePaths: string[]): Promise<Result[]> {
  const [sendToTpl, filesToSend] = filePaths.length ? await Promise.all([api.GetTranslation(ctx, "send_to"), api.GetTranslation(ctx, "files_to_send")]) : ["", ""]
  return devices.map(device => {
    const resultId = crypto.randomUUID()
    const result: Result = {
      Id: resultId,
      Title: filePaths.length ? util.format(sendToTpl, device.alias) : device.alias,
      SubTitle: formatDeviceSubtitle(device),
      Icon: { ImageType: "relative", ImageData: "images/app.png" }
    }
    if (filePaths.length) {
      result.Preview = {
        PreviewType: filePaths.length === 1 ? "file" : "text",
        PreviewData: filePaths.length === 1 ? filePaths[0] : `${filesToSend}\n${filePaths.map(p => `• ${p}`).join("\n")}`,
        PreviewProperties: {
          "i18n:device_label": device.alias,
          "i18n:ip_label": device.ip,
          "i18n:protocol_label": device.protocol.toUpperCase(),
          "i18n:file_count_label": filePaths.length.toString()
        }
      }
      result.Actions = [
        {
          Name: "i18n:send",
          PreventHideAfterAction: true,
          Action: createSendAction(device, filePaths, resultId)
        }
      ]
    }
    return result
  })
}

function formatDeviceSubtitle(device: LocalSendDevice): string {
  const parts: string[] = []
  if (device.deviceModel) {
    parts.push(device.deviceModel)
  }
  parts.push(device.ip)
  if (device.deviceType) {
    parts.push(device.deviceType)
  }
  return parts.join(" • ")
}
