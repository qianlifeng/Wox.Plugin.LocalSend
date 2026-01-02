import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"
import { findDevices, LocalSendDevice } from "./discovery"
import { sendFiles } from "./transfer"
import * as crypto from "crypto"

let api: PublicAPI

// Cache for discovered devices
let cachedDevices: LocalSendDevice[] | null = null
let isScanning = false
let lastScanTime = 0
let lastResultId: string = ""

// Helper to update result to scanning state
async function updateResultToScanning(ctx: Context, resultId: string) {
  try {
    const updatable = await api.GetUpdatableResult(ctx, resultId)
    if (updatable) {
      updatable.Title = "Scanning for LocalSend devices..."
      updatable.SubTitle = "Please wait..."
      updatable.Actions = []
      await api.UpdateResult(ctx, updatable)
    }
  } catch {
    // Ignore error
  }
}

// Helper to update result with error and retry
async function updateResultWithError(ctx: Context, resultId: string, errorMsg: string, retryAction: (ctx: Context) => Promise<void>) {
  try {
    const updatable = await api.GetUpdatableResult(ctx, resultId)
    if (updatable) {
      updatable.Title = "Discovery failed"
      updatable.SubTitle = errorMsg
      updatable.Actions = [
        {
          Name: "Retry",
          PreventHideAfterAction: true,
          Action: retryAction
        }
      ]
      await api.UpdateResult(ctx, updatable)
    }
  } catch {
    // Ignore error
  }
}

// Helper to update result with devices
async function updateResultWithDevices(ctx: Context, resultId: string, devices: LocalSendDevice[], query: Query, filePaths: string[], retryAction: (ctx: Context) => Promise<void>) {
  try {
    const updatableResult = await api.GetUpdatableResult(ctx, resultId)

    if (devices.length === 0) {
      if (updatableResult) {
        updatableResult.Title = "No LocalSend devices found"
        updatableResult.SubTitle = "Make sure LocalSend is running on the target device"
        updatableResult.Actions = [
          {
            Name: "Retry",
            PreventHideAfterAction: true,
            Action: retryAction
          }
        ]
        await api.UpdateResult(ctx, updatableResult)
      }
    } else {
      const results = devicesToResults(devices, filePaths, api)
      if (updatableResult) {
        updatableResult.Title = results[0].Title
        updatableResult.SubTitle = results[0].SubTitle
        updatableResult.Actions = results[0].Actions
        await api.UpdateResult(ctx, updatableResult)
      }

      if (devices.length > 1) {
        await api.PushResults(ctx, query, results.slice(1))
      }
    }
  } catch (e) {
    console.error("Failed to update results:", e)
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    await api.Log(ctx, "Info", "LocalSend plugin initialized")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    if (query.Type !== "selection" || query.Selection.FilePaths.length === 0) {
      return []
    }

    // Check cache
    if (cachedDevices && Date.now() - lastScanTime < 5 * 60 * 1000) {
      return devicesToResults(cachedDevices, query.Selection.FilePaths, api)
    }

    // Generate a stable ID for this query session's main result
    lastResultId = crypto.randomUUID()
    const currentResultId = lastResultId

    // Define the discovery logic
    const runDiscovery = async (currentCtx: Context) => {
      // 1. Set to scanning (if retrying)
      if (!isScanning) {
        await updateResultToScanning(currentCtx, currentResultId)
      }

      isScanning = true
      api.Log(currentCtx, "Info", `Discovering LocalSend devices`)

      try {
        const devices = await findDevices(currentCtx, 3000, api)
        cachedDevices = devices
        lastScanTime = Date.now()
        isScanning = false

        await updateResultWithDevices(currentCtx, currentResultId, devices, query, query.Selection.FilePaths, runDiscovery)
      } catch (error) {
        console.error("Discovery failed:", error)
        isScanning = false
        cachedDevices = null
        const errorMsg = error instanceof Error ? error.message : "Unknown error"
        await updateResultWithError(currentCtx, currentResultId, errorMsg, runDiscovery)
      }
    }

    // Start discovery if not scanning
    if (!isScanning) {
      runDiscovery(ctx)
    }

    return [
      {
        Id: currentResultId,
        Title: "Scanning for LocalSend devices...",
        Icon: {
          ImageType: "relative",
          ImageData: "images/app.png"
        }
      }
    ]
  }
}

function devicesToResults(devices: LocalSendDevice[], filePaths: string[], api: PublicAPI): Result[] {
  return devices.map(device => {
    const resultId = crypto.randomUUID()

    return {
      Id: resultId,
      Title: `Send to ${device.alias}`,
      SubTitle: formatDeviceSubtitle(device),
      Icon: {
        ImageType: "relative",
        ImageData: "images/app.png"
      },
      Preview: {
        PreviewType: "text",
        PreviewData: `Files to send:\n${filePaths.map(p => `• ${p}`).join("\n")}`,
        PreviewProperties: {
          Device: device.alias,
          IP: device.ip,
          Protocol: (device.protocol || "HTTPS").toUpperCase(),
          "File Count": filePaths.length.toString()
        }
      },
      Tails: [
        {
          Type: "text",
          Text: `${filePaths.length} file(s)`
        }
      ],
      Actions: [
        {
          Name: "Send",
          ContextData: {
            device: JSON.stringify(device),
            filePaths: JSON.stringify(filePaths),
            resultId: resultId
          },
          PreventHideAfterAction: true,
          Action: async (actionCtx: Context, actionContext: ActionContext) => {
            const targetDevice = JSON.parse(actionContext.ContextData.device) as LocalSendDevice
            const files = JSON.parse(actionContext.ContextData.filePaths) as string[]
            const rId = actionContext.ContextData.resultId

            await api.Log(actionCtx, "Info", `Sending ${files.length} file(s) to ${targetDevice.alias}...`)

            // Helper to update UI
            const updateProgress = async (idx: number, total: number, currentFile: string) => {
              try {
                const result = await api.GetUpdatableResult(actionCtx, rId)
                if (result) {
                  if (idx < total) {
                    result.Title = `Sending ${idx + 1}/${total}: ${currentFile}`
                    result.SubTitle = `Target: ${targetDevice.alias}`
                    // Ideally add a progress bar in Tails or Icon if possible, but text is fine
                  } else {
                    result.Title = `Sent ${total} file(s) successfully`
                    result.SubTitle = `Target: ${targetDevice.alias}`
                  }
                  await api.UpdateResult(actionCtx, result)
                }
              } catch {
                // Ignore UI update errors
              }
            }

            try {
              // Initial status
              await updateProgress(0, files.length, "Preparing...")

              await sendFiles(targetDevice, files, async (current, total, fileName) => {
                await updateProgress(current, total, fileName)
              })

              await api.Notify(actionCtx, `Successfully sent ${files.length} file(s) to ${targetDevice.alias}`)
              await api.Log(actionCtx, "Info", `Successfully sent files to ${targetDevice.alias}`)

              // Close window after short delay or let user close it?
              // Let's hide it after success
              setTimeout(async () => {
                await api.HideApp(actionCtx)
              }, 1500)
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : "Unknown error"
              await api.Notify(actionCtx, `Failed to send files: ${errorMsg}`)
              await api.Log(actionCtx, "Error", `Failed to send files: ${errorMsg}`)

              // Show error in result
              try {
                const result = await api.GetUpdatableResult(actionCtx, rId)
                if (result) {
                  result.Title = "Failed to send"
                  result.SubTitle = errorMsg
                  await api.UpdateResult(actionCtx, result)
                }
              } catch {
                // Ignore error
              }
            }
          }
        }
      ]
    }
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
