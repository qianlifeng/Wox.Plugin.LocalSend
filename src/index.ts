import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result } from "@wox-launcher/wox-plugin"
import { findDevices, LocalSendDevice } from "./discovery"
import { sendFiles } from "./transfer"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as util from "util"

let api: PublicAPI

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

const createDiscoveryAction = (currentCtx: Context, resultId: string, filePaths: string[]) => {
  return async () => {
    api.Log(currentCtx, "Info", `Discovering LocalSend devices`)
    await updateResultToScanning(currentCtx, resultId)
    try {
      const devices = await findDevices(currentCtx, 3000, api)
      await updateResultWithDevices(currentCtx, resultId, devices, filePaths)
    } catch (error) {
      console.error("Discovery failed:", error)
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      await updateResultWithError(currentCtx, resultId, errorMsg, filePaths)
    }
  }
}

const createSendAction = (targetDevice: LocalSendDevice, files: string[], resultId: string) => {
  return async (actionCtx: Context) => {
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
            result.Title = util.format(sendingTpl, idx + 1, total, currentFile)
            result.SubTitle = util.format(targetTpl, targetDevice.alias)
          } else {
            const sentSuccessTpl = await api.GetTranslation(actionCtx, "sent_success")
            const filesUnit = await api.GetTranslation(actionCtx, "files_unit")
            const targetTpl = await api.GetTranslation(actionCtx, "target")
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

      await sendFiles(
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
                  Action: createDiscoveryAction(actionCtx, resultId, files)
                }
              ]
              await api.UpdateResult(actionCtx, result)
            }
          } catch {
            // Ignore error
          }
        }
      )

      const successTpl = await api.GetTranslation(actionCtx, "successfully_sent")
      const filesUnit = await api.GetTranslation(actionCtx, "files_unit")
      await api.Notify(actionCtx, util.format(successTpl, files.length, filesUnit, targetDevice.alias))
      await api.Log(actionCtx, "Info", `Successfully sent files to ${targetDevice.alias}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      await api.Notify(actionCtx, `Failed to send files: ${errorMsg}`)
      await api.Log(actionCtx, "Error", `Failed to send files: ${errorMsg}`)

      // Show error in result
      try {
        const result = await api.GetUpdatableResult(actionCtx, resultId)
        if (result) {
          result.Title = "i18n:failed_to_send"
          result.SubTitle = errorMsg
          await api.UpdateResult(actionCtx, result)
        }
      } catch {
        // Ignore error
      }
    }
  }
}

// Helper to update result to scanning state
async function updateResultToScanning(ctx: Context, resultId: string) {
  try {
    const updatable = await api.GetUpdatableResult(ctx, resultId)
    if (updatable) {
      updatable.Title = "i18n:scanning"
      updatable.SubTitle = "i18n:please_wait"
      updatable.Actions = []
      await api.UpdateResult(ctx, updatable)
    }
  } catch {
    // Ignore error
  }
}

// Helper to update result with error and retry
async function updateResultWithError(ctx: Context, resultId: string, errorMsg: string, filePaths: string[]) {
  try {
    const updatable = await api.GetUpdatableResult(ctx, resultId)
    if (updatable) {
      updatable.Title = "i18n:discovery_failed"
      updatable.SubTitle = errorMsg
      updatable.Actions = [
        {
          Name: "i18n:retry",
          PreventHideAfterAction: true,
          Action: createDiscoveryAction(ctx, resultId, filePaths)
        }
      ]
      await api.UpdateResult(ctx, updatable)
    }
  } catch {
    // Ignore error
  }
}

async function updateResultWithDevices(ctx: Context, resultId: string, devices: LocalSendDevice[], filePaths: string[]) {
  try {
    const updatableResult = await api.GetUpdatableResult(ctx, resultId)

    if (devices.length === 0) {
      if (updatableResult) {
        updatableResult.Title = "i18n:no_devices_found"
        updatableResult.SubTitle = "i18n:check_localsend"
        updatableResult.Actions = [
          {
            Name: "i18n:retry",
            PreventHideAfterAction: true,
            Action: createDiscoveryAction(ctx, resultId, filePaths)
          }
        ]
        await api.UpdateResult(ctx, updatableResult)
      }
    } else {
      const device = devices[0] // we only show the first device
      const results = await devicesToResults(ctx, [device], filePaths)
      if (updatableResult) {
        updatableResult.Title = results[0].Title
        updatableResult.SubTitle = results[0].SubTitle
        updatableResult.Actions = [
          {
            Name: "i18n:send",
            PreventHideAfterAction: true,
            Action: createSendAction(device, filePaths, resultId)
          }
        ]
        await api.UpdateResult(ctx, updatableResult)
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

    const resultId = crypto.randomUUID()
    const filePaths = expandDirectories(query.Selection.FilePaths)

    if (filePaths.length === 0) {
      return [
        {
          Id: resultId,
          Title: "i18n:no_files",
          SubTitle: "i18n:folders_empty",
          Icon: {
            ImageType: "relative",
            ImageData: "images/app.png"
          }
        }
      ]
    }

    // scan for devices
    createDiscoveryAction(ctx, resultId, filePaths)()

    return [
      {
        Id: resultId,
        Title: "i18n:scanning",
        Icon: {
          ImageType: "relative",
          ImageData: "images/app.png"
        }
      }
    ]
  }
}

async function devicesToResults(ctx: Context, devices: LocalSendDevice[], filePaths: string[]): Promise<Result[]> {
  return Promise.all(
    devices.map(async device => {
      const resultId = crypto.randomUUID()
      const sendToTpl = await api.GetTranslation(ctx, "send_to")

      return {
        Id: resultId,
        Title: util.format(sendToTpl, device.alias),
        SubTitle: formatDeviceSubtitle(device),
        Icon: {
          ImageType: "relative",
          ImageData: "images/app.png"
        },
        Preview: {
          PreviewType: "text",
          PreviewData: `i18n:files_to_send\n${filePaths.map(p => `• ${p}`).join("\n")}`,
          PreviewProperties: {
            "i18n:device_label": device.alias,
            "i18n:ip_label": device.ip,
            "i18n:protocol_label": (device.protocol || "HTTPS").toUpperCase(),
            "i18n:file_count_label": filePaths.length.toString()
          }
        },
        Tails: [
          {
            Type: "text",
            Text: `${filePaths.length} i18n:files_unit`
          }
        ],
        Actions: [
          {
            Name: "i18n:send",
            PreventHideAfterAction: true,
            Action: createSendAction(device, filePaths, resultId)
          }
        ]
      }
    })
  )
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
