import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fsPromises from 'fs/promises'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sharp = require('sharp')
import crypto from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.ico'
])

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const THUMBNAIL_CACHE_MAX_FILES = 10000
const THUMBNAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

let thumbnailCacheDir = ''
let thumbnailCacheRoot = ''
let configPath = ''
let activeImageRoot = ''
let activeScan = null

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeForCompare(localPath) {
  const normalized = path.normalize(localPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInsideRoot(localPath, rootPath) {
  if (!rootPath) return false
  const relative = path.relative(normalizeForCompare(rootPath), normalizeForCompare(localPath))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function toPicUrl(localPath) {
  return 'pic://' + encodeURIComponent(localPath)
}

async function resolveDirectoryPath(dirPath) {
  if (!isNonEmptyString(dirPath)) {
    throw new Error('Invalid folder path')
  }
  const realPath = await fsPromises.realpath(dirPath)
  const stats = await fsPromises.stat(realPath)
  if (!stats.isDirectory()) {
    throw new Error('Path is not a folder')
  }
  return realPath
}

async function resolveImageFilePath(imagePath) {
  if (!isNonEmptyString(imagePath)) {
    throw new Error('Invalid image path')
  }
  const requestedExt = path.extname(imagePath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(requestedExt)) {
    throw new Error('Unsupported image type')
  }

  const realPath = await fsPromises.realpath(imagePath)
  const stats = await fsPromises.stat(realPath)
  if (!stats.isFile()) {
    throw new Error('Path is not a file')
  }

  const realExt = path.extname(realPath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(realExt)) {
    throw new Error('Unsupported image type')
  }

  return { realPath, stats, ext: realExt }
}

async function resolveAuthorizedImagePath(imagePath, { allowCache = true } = {}) {
  const image = await resolveImageFilePath(imagePath)
  const allowedRoots = allowCache
    ? [activeImageRoot, thumbnailCacheRoot].filter(Boolean)
    : [activeImageRoot].filter(Boolean)

  if (!allowedRoots.some(root => isPathInsideRoot(image.realPath, root))) {
    throw new Error('Image path is not authorized')
  }

  return image
}

function assertTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted IPC sender')
  }
}

function sendScanError(sender, scanId, err) {
  if (sender.isDestroyed()) return
  sender.send('scan-folder-error', {
    scanId,
    error: err instanceof Error ? err.message : String(err),
  })
}

function cancelActiveScan() {
  if (activeScan) {
    activeScan.cancelled = true
    activeScan = null
  }
}

function isScanCancelled(task, sender) {
  return !task || task.cancelled || activeScan !== task || sender.isDestroyed()
}

// 加载应用配置
async function loadConfig() {
  try {
    const data = await fsPromises.readFile(configPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function saveConfig(config) {
  try {
    await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('Save config failed:', err)
  }
}

// 注册 pic:// 自定义协议（使用新标准的 protocol.handle）
function registerPicProtocol() {
  protocol.handle('pic', async (request) => {
    try {
      const url = request.url.replace(/^pic:\/\//, '')
      const decoded = decodeURIComponent(url)
      const { realPath, ext } = await resolveAuthorizedImagePath(decoded)
      const data = await fsPromises.readFile(realPath)
      return new Response(data, {
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (err) {
      console.error('pic:// read failed:', request.url, err)
      return new Response('Forbidden', { status: 403 })
    }
  })
}

// 非递归扫描目录（基于栈，避免深层嵌套栈溢出）
async function* scanDirectoryGenerator(dirPath, isCancelled = () => false) {
  const stack = [dirPath]

  while (stack.length > 0 && !isCancelled()) {
    const currentDir = stack.pop()
    let entries
    try {
      entries = await fsPromises.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    const dirs = []
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        dirs.push(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (IMAGE_EXTENSIONS.has(ext)) {
          if (isCancelled()) return
          yield fullPath
        }
      }
    }
    // 逆序入栈以保持与递归 DFS 相同的遍历顺序
    for (let i = dirs.length - 1; i >= 0; i--) {
      stack.push(dirs[i])
    }
  }
}

// 构建文件夹树（使用 Map 将子节点查找优化到 O(1)）
function buildFolderTree(rootPath, imagePaths) {
  const tree = {
    name: path.basename(rootPath),
    path: rootPath,
    children: [],
    images: [],
    // 内部 Map，构建完成后清理
    _childMap: new Map(),
  }

  for (const imgPath of imagePaths) {
    const relative = path.relative(rootPath, imgPath)
    const parts = relative.split(path.sep)
    const fileName = parts.pop()
    const dirParts = parts

    let current = tree
    for (const part of dirParts) {
      let child = current._childMap.get(part)
      if (!child) {
        child = {
          name: part,
          path: path.join(current.path, part),
          children: [],
          images: [],
          _childMap: new Map(),
        }
        current.children.push(child)
        current._childMap.set(part, child)
      }
      current = child
    }
    current.images.push({ name: fileName, path: imgPath })
  }

  // 后序遍历计算 totalCount
  function calcCounts(node) {
    let count = node.images.length
    for (const child of node.children) {
      count += calcCounts(child)
    }
    node.totalCount = count
    return count
  }
  calcCounts(tree)

  // 按名称排序
  function sortTree(node) {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of node.children) sortTree(child)
  }
  sortTree(tree)

  // 清理内部 Map，减少发送到渲染进程的数据体积
  function cleanup(node) {
    delete node._childMap
    for (const child of node.children) cleanup(child)
  }
  cleanup(tree)

  return tree
}

// 获取或生成缩略图，返回 pic:// 协议 URL
async function getThumbnailUrl(imagePath) {
  const { realPath, stats } = await resolveAuthorizedImagePath(imagePath, { allowCache: false })
  const hash = crypto
    .createHash('sha256')
    .update(`${realPath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex')
  const cachePath = path.join(thumbnailCacheDir, hash + '.jpg')

  try {
    await fsPromises.access(cachePath)
  } catch {
    try {
      await sharp(realPath)
        .resize(300, 300, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 80 })
        .toFile(cachePath)
    } catch (err) {
      console.warn('Thumbnail generation failed, falling back to original image:', realPath, err)
      return toPicUrl(realPath)
    }
  }
  return toPicUrl(cachePath)
}

// 清理过期的缩略图缓存（按文件数量和总体积限制）
async function cleanupThumbnailCache(maxFiles = THUMBNAIL_CACHE_MAX_FILES, maxBytes = THUMBNAIL_CACHE_MAX_BYTES) {
  try {
    const files = await fsPromises.readdir(thumbnailCacheDir)

    const stats = await Promise.all(
      files.map(async (f) => {
        const p = path.join(thumbnailCacheDir, f)
        try {
          const s = await fsPromises.stat(p)
          if (!s.isFile()) return null
          return { path: p, mtime: s.mtimeMs, size: s.size }
        } catch {
          return null
        }
      })
    )

    const validStats = stats.filter(Boolean)
    const totalBytes = validStats.reduce((sum, f) => sum + f.size, 0)
    if (validStats.length <= maxFiles && totalBytes <= maxBytes) return

    validStats.sort((a, b) => a.mtime - b.mtime)
    const toDelete = []
    let remainingFiles = validStats.length
    let remainingBytes = totalBytes
    for (const file of validStats) {
      if (remainingFiles <= maxFiles && remainingBytes <= maxBytes) break
      toDelete.push(file)
      remainingFiles--
      remainingBytes -= file.size
    }

    await Promise.all(toDelete.map(f => fsPromises.unlink(f.path).catch(() => {})))
    console.log(`Cleaned up ${toDelete.length} old thumbnail caches`)
  } catch (err) {
    console.error('Cleanup thumbnail cache failed:', err)
  }
}

// 将本地路径转为 pic:// URL
async function pathToPicUrl(localPath) {
  const { realPath } = await resolveAuthorizedImagePath(localPath, { allowCache: false })
  return toPicUrl(realPath)
}

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  registerPicProtocol()
  thumbnailCacheDir = path.join(app.getPath('userData'), 'thumbnails')
  configPath = path.join(app.getPath('userData'), 'config.json')
  await fsPromises.mkdir(thumbnailCacheDir, { recursive: true })
  thumbnailCacheRoot = await fsPromises.realpath(thumbnailCacheDir)
  cleanupThumbnailCache()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers
ipcMain.handle('pick-folder', async (event) => {
  assertTrustedSender(event)
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    const folder = await resolveDirectoryPath(result.filePaths[0])
    await saveConfig({ ...(await loadConfig()), lastFolder: folder })
    return folder
  }
  return null
})

ipcMain.handle('get-last-folder', async (event) => {
  assertTrustedSender(event)
  const config = await loadConfig()
  if (!isNonEmptyString(config.lastFolder)) return null
  try {
    return await resolveDirectoryPath(config.lastFolder)
  } catch {
    return null
  }
})

// 流式扫描：增量推送图片，扫描完成后推送 folderTree
const BATCH_SIZE = 500

ipcMain.on('scan-folder-stream', async (event, payload) => {
  let task = null
  const scanId = payload?.scanId

  try {
    assertTrustedSender(event)
    if (!isNonEmptyString(scanId)) {
      throw new Error('Invalid scan id')
    }
    const folderPath = await resolveDirectoryPath(payload?.folderPath)

    cancelActiveScan()
    activeImageRoot = folderPath
    task = { id: scanId, cancelled: false }
    activeScan = task

    const collectedPaths = []
    const batch = []
    let totalCount = 0

    const flushBatch = () => {
      if (batch.length === 0 || isScanCancelled(task, event.sender)) return
      event.sender.send('scan-folder-progress', {
        scanId,
        images: batch.splice(0, batch.length),
        totalSoFar: totalCount,
      })
    }

    for await (const imgPath of scanDirectoryGenerator(folderPath, () => isScanCancelled(task, event.sender))) {
      if (isScanCancelled(task, event.sender)) return
      collectedPaths.push(imgPath)
      batch.push({
        path: imgPath,
        relativePath: path.relative(folderPath, imgPath),
        name: path.basename(imgPath),
      })
      totalCount++

      if (batch.length >= BATCH_SIZE) {
        flushBatch()
      }
    }

    flushBatch()
    if (isScanCancelled(task, event.sender)) return

    // 扫描完成后本地构建 tree，然后推送 done 事件
    const folderTree = buildFolderTree(folderPath, collectedPaths)
    event.sender.send('scan-folder-done', { scanId, totalCount, folderTree, rootPath: folderPath })
  } catch (err) {
    console.error('Scan folder failed:', err)
    if (isNonEmptyString(scanId)) {
      sendScanError(event.sender, scanId, err)
    }
  } finally {
    if (activeScan === task) {
      activeScan = null
    }
  }
})

ipcMain.on('cancel-scan', (event, scanId) => {
  try {
    assertTrustedSender(event)
    if (activeScan?.id === scanId) {
      cancelActiveScan()
    }
  } catch (err) {
    console.error('Cancel scan failed:', err)
  }
})

ipcMain.handle('get-thumbnail-url', async (event, imagePath) => {
  assertTrustedSender(event)
  return await getThumbnailUrl(imagePath)
})

ipcMain.handle('get-full-image-url', async (event, imagePath) => {
  assertTrustedSender(event)
  return await pathToPicUrl(imagePath)
})
