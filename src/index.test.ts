import { Context, PluginInitParams, PublicAPI, Query } from "@wox-launcher/wox-plugin"
import { findDevices, LocalSendDevice, startDiscovery } from "./discovery"
import { startReceiver } from "./receiver"
import { sendFiles } from "./transfer"
import { ReceiveHistory } from "./history"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { EventEmitter } from "events"

jest.mock("os", () => ({ ...jest.requireActual("os"), homedir: jest.fn() }))
jest.mock("child_process", () => ({ spawn: jest.fn() }))
jest.mock("./discovery", () => ({ findDevices: jest.fn(), startDiscovery: jest.fn().mockResolvedValue(() => {}) }))
jest.mock("./receiver", () => ({ startReceiver: jest.fn().mockResolvedValue({ identity: { alias: "Wox - test", port: 53317 }, close: jest.fn() }) }))
jest.mock("./transfer", () => ({ sendFiles: jest.fn(), configureSender: jest.fn() }))

const ctx = {} as Context
const phone = { alias: "Phone", fingerprint: "phone", ip: "192.168.1.2", port: 53317, protocol: "https", version: "2.0", deviceModel: null, deviceType: "mobile" } as LocalSendDevice
const tablet = { ...phone, alias: "Tablet", fingerprint: "tablet", ip: "192.168.1.3" }
const query = (type: "input" | "selection", overrides = {}) => ({ Type: type, TriggerKeyword: "send", Search: "", ...overrides }) as Query

it("lists cached devices and refreshes visible results after background scans", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8")) as { Features: Array<{ Name: string }>; I18n: Record<string, Record<string, string>> }
  expect(manifest.Features).toContainEqual({ Name: "ignoreAutoScore" })
  jest.useFakeTimers()
  jest.setSystemTime(new Date(2026, 10, 1, 12, 0, 0))
  let finishScan!: (devices: LocalSendDevice[]) => void
  const scan = jest.mocked(findDevices)
  scan.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishScan = resolve
      })
  )
  scan.mockResolvedValueOnce([tablet])
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wox-index-test-"))
  jest.mocked(os.homedir).mockReturnValue(cacheDir)
  const { plugin } = await import("./index")
  let chinese = false
  const api = {
    Log: jest.fn().mockResolvedValue(undefined),
    OnUnload: jest.fn().mockResolvedValue(undefined),
    GetCacheFolder: jest.fn().mockResolvedValue(cacheDir),
    GetTranslation: jest
      .fn()
      .mockImplementation(
        async (_ctx: Context, key: string) =>
          (({ send_to: "Send to %s", files_to_send: chinese ? "待发送文件:" : "Files to send:", receive_sender: "From %s", receive_count: "%d files" }) as Record<string, string>)[
            key
          ] || (key.startsWith("received_") ? manifest.I18n[chinese ? "zh_CN" : "en_US"][key] : undefined) || key
      ),
    Notify: jest.fn().mockResolvedValue(undefined),
    Copy: jest.fn().mockResolvedValue(undefined),
    ShowToastMsg: jest.fn().mockResolvedValue({ Success: true, ErrMsg: "" }),
    ShowApp: jest.fn().mockResolvedValue(undefined),
    ChangeQuery: jest.fn().mockResolvedValue(undefined),
    GetUpdatableResult: jest.fn().mockResolvedValue({}),
    RefreshQuery: jest.fn().mockResolvedValue(undefined),
    UpdateResult: jest.fn().mockResolvedValue(true)
  } as unknown as PublicAPI

  await plugin.init(ctx, { API: api } as PluginInitParams)
  const initial = await plugin.query(ctx, query("input"))
  expect(initial[0].Title).toBe("i18n:scanning")
  expect(scan).toHaveBeenCalledTimes(1)

  finishScan([phone, tablet])
  await jest.advanceTimersByTimeAsync(0)
  expect(api.RefreshQuery).toHaveBeenCalledTimes(1)
  const listed = await plugin.query(ctx, query("input"))
  expect(listed.map(result => result.Title)).toEqual(["Phone", "Tablet"])
  expect(scan).toHaveBeenCalledTimes(1)
  expect((await plugin.query(ctx, query("input", { TriggerKeyword: "custom" }))).length).toBe(2)
  expect(await plugin.query(ctx, query("input", { Search: "phone" }))).toEqual([])

  const selected = await plugin.query(ctx, query("selection", { Selection: { FilePaths: [__filename] } }))
  expect(selected.map(result => result.Title)).toEqual(["Send to Phone", "Send to Tablet"])
  expect(selected.every(result => result.Actions?.length === 1)).toBe(true)
  expect(selected[0].Preview).toMatchObject({ PreviewType: "file", PreviewData: __filename })
  const secondFile = path.join(__dirname, "index.ts")
  const multiple = await plugin.query(ctx, query("selection", { Selection: { FilePaths: [__filename, secondFile] } }))
  expect(multiple[0].Preview).toMatchObject({ PreviewType: "text", PreviewData: `Files to send:\n• ${__filename}\n• ${secondFile}` })
  chinese = true
  const translated = await plugin.query(ctx, query("selection", { Selection: { FilePaths: [__filename, secondFile] } }))
  expect(translated[0].Preview?.PreviewData).toBe(`待发送文件:\n• ${__filename}\n• ${secondFile}`)
  chinese = false
  const updates: Array<{ Title?: string; Tails?: unknown[] }> = []
  jest.mocked(api.UpdateResult).mockImplementation(async (_ctx, result) => {
    updates.push(JSON.parse(JSON.stringify(result)))
    return true
  })
  const send = selected[0].Actions![0]
  if (!("Action" in send)) throw new Error("Expected a send action")
  jest.mocked(sendFiles).mockImplementationOnce(async (_device, _files, progress) => {
    await progress?.(0, 1, "file.txt")
    return true
  })
  await send.Action(ctx, {} as never)
  expect(updates[updates.length - 1].Tails).toEqual([expect.objectContaining({ Type: "image", Image: expect.objectContaining({ ImageType: "svg" }), Tooltip: "send_complete" })])
  const successNotifications = jest.mocked(api.Notify).mock.calls.length
  jest.mocked(sendFiles).mockImplementationOnce(async (_device, _files, _progress, onError) => {
    await onError?.(new Error("rejected"), "")
    return false
  })
  await send.Action(ctx, {} as never)
  expect(updates[updates.length - 1]).toMatchObject({ Title: "i18n:failed_to_send", Tails: [] })
  expect(jest.mocked(api.Notify).mock.calls.length).toBe(successNotifications)
  await jest.advanceTimersByTimeAsync(60_000)
  expect(scan).toHaveBeenCalledTimes(2)
  expect((await plugin.query(ctx, query("input"))).map(result => result.Title)).toEqual(["Phone", "Tablet"])
  scan.mockResolvedValueOnce([])
  await jest.advanceTimersByTimeAsync(60_000)
  expect((await plugin.query(ctx, query("input"))).map(result => result.Title)).toEqual(["Tablet"])
  scan.mockResolvedValueOnce([])
  await jest.advanceTimersByTimeAsync(60_000)
  const empty = (await plugin.query(ctx, query("input")))[0]
  expect(empty.Title).toBe("i18n:no_devices_found")
  expect(empty.Actions?.[0]).toMatchObject({ Name: "i18n:retry", IsDefault: true, PreventHideAfterAction: true })
  let finishRetry!: (devices: LocalSendDevice[]) => void
  scan.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishRetry = resolve
      })
  )
  const action = empty.Actions![0]
  if (!("Action" in action)) throw new Error("Expected a retry action")
  const firstRetry = action.Action(ctx, {} as never)
  const secondRetry = action.Action(ctx, {} as never)
  await jest.advanceTimersByTimeAsync(0)
  expect(api.UpdateResult).toHaveBeenCalledWith(ctx, expect.objectContaining({ Id: empty.Id, Title: "i18n:scanning", Actions: [] }))
  expect(scan).toHaveBeenCalledTimes(5)
  finishRetry([])
  await Promise.all([firstRetry, secondRetry])
  expect((await plugin.query(ctx, query("input")))[0].Title).toBe("i18n:no_devices_found")
  await jest.advanceTimersByTimeAsync(16_000)
  let finishAutomatic!: (devices: LocalSendDevice[]) => void
  scan.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishAutomatic = resolve
      })
  )
  expect((await plugin.query(ctx, query("input")))[0].Title).toBe("i18n:scanning")
  await jest.advanceTimersByTimeAsync(0)
  expect(scan).toHaveBeenCalledTimes(6)
  const discovered = jest.mocked(startDiscovery).mock.calls[0][3]!
  discovered(phone)
  await jest.advanceTimersByTimeAsync(0)
  expect((await plugin.query(ctx, query("input"))).map(result => result.Title)).toEqual(["Phone"])
  finishAutomatic([])
  await jest.advanceTimersByTimeAsync(0)
  expect((await plugin.query(ctx, query("input"))).map(result => result.Title)).toEqual(["Phone"])
  discovered(tablet)
  await jest.advanceTimersByTimeAsync(0)
  expect((await plugin.query(ctx, query("input"))).map(result => result.Title)).toEqual(["Phone", "Tablet"])
  const receive = jest.mocked(startReceiver).mock.calls[0][2]
  const root = path.join(cacheDir, "Downloads", "LocalSend")
  const transfer1 = path.join(root, "transfer-1")
  const transfer2 = path.join(root, "transfer-2")
  fs.mkdirSync(transfer1, { recursive: true })
  fs.mkdirSync(transfer2, { recursive: true })
  for (const file of [path.join(transfer1, "one.txt"), path.join(transfer1, "two.txt"), path.join(transfer2, "three.txt")]) fs.writeFileSync(file, "data")
  fs.writeFileSync(path.join(transfer2, "three.txt"), "可口可乐\n第二行")
  receive(path.join(transfer1, "one.txt"), "transfer-1", "Phone", ["one.txt"])
  receive(path.join(transfer1, "two.txt"), "transfer-1", "Phone", ["one.txt", "two.txt"])
  await jest.advanceTimersByTimeAsync(1000)
  receive(path.join(transfer2, "three.txt"), "transfer-2", "Tablet", ["photo.JPG", "photo.heic", "clip.mp4", "sound.mp3", "three.txt"])
  await jest.advanceTimersByTimeAsync(0)
  const toastCalls = (api as unknown as { ShowToastMsg: jest.Mock }).ShowToastMsg.mock.calls
  const toast = toastCalls[toastCalls.length - 1][1]
  expect(toast.Title).toBe("i18n:received_title")
  expect(toastCalls[0][1].Message).toBe("1 file")
  expect(toastCalls[1][1].Message).toBe("2 files")
  expect(toast.Message).toBe("2 images · 1 video · 1 audio file · 1 file")
  chinese = true
  receive(path.join(transfer2, "three.txt"), "transfer-2", "Tablet", ["photo.jpg", "photo.heic", "three.txt"])
  await jest.advanceTimersByTimeAsync(0)
  expect(toastCalls[toastCalls.length - 1][1].Message).toBe("2 张图片 · 1 个文件")
  chinese = false
  expect(toast.Action.Name).toBe("i18n:view_receive_history")
  await toast.Action.Action(ctx)
  expect(api.ShowApp).toHaveBeenCalledWith(ctx)
  expect(api.ChangeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "receive " })
  const old = path.join(root, "old-transfer")
  fs.mkdirSync(old)
  fs.writeFileSync(path.join(old, "older.jpg"), "data")
  new ReceiveHistory(root).record({ sessionId: "old-transfer", sender: "Laptop", filePath: path.join(old, "older.jpg"), receivedAt: new Date(2026, 9, 31, 23, 59).toISOString() })
  const history = await plugin.query(ctx, query("input", { TriggerKeyword: "receive" }))
  expect(history.map(result => result.Title)).toEqual(["three.txt", "one.txt", "older.jpg"])
  expect(history.map(result => result.Group)).toEqual(["i18n:receive_today", "i18n:receive_today", "i18n:receive_history"])
  expect(history.map(result => result.GroupScore)).toEqual([2, 2, 1])
  expect(history[0].Score!).toBeGreaterThan(history[1].Score!)
  expect(history[1].Score!).toBeGreaterThan(history[2].Score!)
  expect(history[0].SubTitle).toContain("From Tablet")
  expect(history[0].Tails).toEqual([])
  expect(history[1].Tails).toEqual([{ Type: "text", Text: "2 files" }])
  expect(history[0].Preview).toMatchObject({ PreviewType: "file", PreviewData: path.join(transfer2, "three.txt") })
  expect(history[1].Preview?.PreviewType).toBe("text")
  expect(history[1].SubTitle).toContain("From Phone")
  expect(history[1].Preview?.PreviewData).toContain("one.txt")
  expect(history[1].Preview?.PreviewData).toContain("two.txt")
  expect(history[1].Actions?.[0]).toMatchObject({ Name: "i18n:open_receive_folder", IsDefault: true })
  expect(history[1].Actions).toHaveLength(1)
  expect(history[2].Actions?.[0]).toMatchObject({ Name: "i18n:open_receive_folder", IsDefault: true })
  expect(history[0].Actions?.[0]).toMatchObject({ Name: "i18n:open_receive_folder", IsDefault: true })
  const copy = history[0].Actions![1]
  expect(copy.Name).toBe("i18n:copy_text")
  if (!("Action" in copy)) throw new Error("Expected a copy action")
  await copy.Action(ctx, {} as never)
  expect(api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: "可口可乐\n第二行" })
  fs.unlinkSync(path.join(transfer2, "three.txt"))
  await copy.Action(ctx, {} as never)
  expect(api.Copy).toHaveBeenCalledTimes(1)
  expect(api.Notify).toHaveBeenCalledWith(ctx, expect.stringContaining("copy_text_failed"))
  fs.writeFileSync(path.join(transfer2, "three.txt"), "data")
  const copyImage = history[2].Actions![1]
  expect(copyImage.Name).toBe("i18n:copy_image")
  if (!("Action" in copyImage)) throw new Error("Expected a copy image action")
  await copyImage.Action(ctx, {} as never)
  expect(api.Copy).toHaveBeenCalledWith(ctx, { type: "image", text: "", woxImage: { ImageType: "absolute", ImageData: path.join(old, "older.jpg") } })
  fs.unlinkSync(path.join(old, "older.jpg"))
  await copyImage.Action(ctx, {} as never)
  expect(api.Copy).toHaveBeenCalledTimes(2)
  expect(api.Notify).toHaveBeenCalledWith(ctx, expect.stringContaining("copy_image_failed"))
  fs.writeFileSync(path.join(old, "older.jpg"), "data")
  const access = jest.spyOn(fs.promises, "access").mockResolvedValue(undefined)
  jest.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: jest.fn() })
    setImmediate(() => child.emit("spawn"))
    return child as never
  })
  const open = history[1].Actions![0]
  if (!("Action" in open)) throw new Error("Expected an open-folder action")
  const opening = open.Action(ctx, {} as never)
  await jest.advanceTimersByTimeAsync(0)
  await opening
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open"
  expect(spawn).toHaveBeenCalledWith(command, [transfer1], { detached: true, stdio: "ignore" })
  access.mockRestore()
  const filtered = await plugin.query(ctx, query("input", { TriggerKeyword: "receive", Search: "two" }))
  expect(filtered.map(result => result.Title)).toEqual(["one.txt"])
  if (path.dirname(transfer1) === root && path.basename(transfer1) === "transfer-1") fs.rmSync(transfer1, { recursive: true, force: true })
  const afterRemoval = await plugin.query(ctx, query("input", { TriggerKeyword: "receive" }))
  expect(afterRemoval.map(result => result.Title)).toEqual(["three.txt", "older.jpg"])
  const unload = jest.mocked(api.OnUnload).mock.calls[0][1]
  await unload(ctx)
  await jest.advanceTimersByTimeAsync(60_000)
  expect(scan).toHaveBeenCalledTimes(6)
  jest.useRealTimers()
  if (path.dirname(cacheDir) === os.tmpdir() && path.basename(cacheDir).startsWith("wox-index-test-")) fs.rmSync(cacheDir, { recursive: true, force: true })
})
