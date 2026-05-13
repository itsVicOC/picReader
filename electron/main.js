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

let thumbnailCacheDir = ''
let configPath = ''

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
    const url = request.url.replace(/^pic:\/\//, '')
    const decoded = decodeURIComponent(url)
    const ext = path.extname(decoded).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await fsPromises.readFile(decoded)
      return new Response(data, {
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }
      })
    } catch (err) {
      console.error('pic:// read failed:', decoded, err)
      return new Response('Not Found', { status: 404 })
    }
  })
}

// 非递归扫描目录（基于栈，避免深层嵌套栈溢出）
async function* scanDirectoryGenerator(dirPath) {
  const stack = [dirPath]

  while (stack.length > 0) {
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
  let stats
  try {
    stats = await fsPromises.stat(imagePath)
  } catch (err) {
    console.error('Stat failed for thumbnail:', imagePath, err)
    throw new Error(`Cannot stat image: ${imagePath}`)
  }

  const hash = crypto.createHash('md5').update(imagePath + stats.mtimeMs).digest('hex')
  const cachePath = path.join(thumbnailCacheDir, hash + '.jpg')

  try {
    await fsPromises.access(cachePath)
  } catch {
    // 生成缩略图
    await sharp(imagePath)
      .resize(300, 300, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 80 })
      .toFile(cachePath)
  }
  return 'pic://' + encodeURIComponent(cachePath)
}

// 清理过期的缩略图缓存（按文件数量限制）
async function cleanupThumbnailCache(maxFiles = 10000) {
  try {
    const files = await fsPromises.readdir(thumbnailCacheDir)
    if (files.length <= maxFiles) return

    const stats = await Promise.all(
      files.map(async (f) => {
        const p = path.join(thumbnailCacheDir, f)
        try {
          const s = await fsPromises.stat(p)
          return { path: p, mtime: s.mtimeMs }
        } catch {
          return null
        }
      })
    )

    const validStats = stats.filter(Boolean)
    validStats.sort((a, b) => a.mtime - b.mtime)
    const toDelete = validStats.slice(0, validStats.length - maxFiles)

    await Promise.all(toDelete.map(f => fsPromises.unlink(f.path).catch(() => {})))
    console.log(`Cleaned up ${toDelete.length} old thumbnail caches`)
  } catch (err) {
    console.error('Cleanup thumbnail cache failed:', err)
  }
}

// 将本地路径转为 pic:// URL
function pathToPicUrl(localPath) {
  return 'pic://' + encodeURIComponent(localPath)
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
      sandbox: false,
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
  cleanupThumbnailCache()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0]
    await saveConfig({ ...(await loadConfig()), lastFolder: folder })
    return folder
  }
  return null
})

ipcMain.handle('get-last-folder', async () => {
  const config = await loadConfig()
  return config.lastFolder || null
})

// 流式扫描：增量推送图片，扫描完成后推送 folderTree
const BATCH_SIZE = 500

ipcMain.on('scan-folder-stream', async (event, folderPath) => {
  const collectedPaths = []
  const batch = []
  let totalCount = 0

  for await (const imgPath of scanDirectoryGenerator(folderPath)) {
    collectedPaths.push(imgPath)
    batch.push({
      path: imgPath,
      relativePath: path.relative(folderPath, imgPath),
      name: path.basename(imgPath),
    })
    totalCount++

    if (batch.length >= BATCH_SIZE) {
      event.sender.send('scan-folder-progress', {
        images: batch.splice(0, batch.length),
        totalSoFar: totalCount,
      })
    }
  }

  // 推送剩余不足一批的数据
  if (batch.length > 0) {
    event.sender.send('scan-folder-progress', {
      images: batch,
      totalSoFar: totalCount,
    })
  }

  // 扫描完成后本地构建 tree，然后推送 done 事件
  const folderTree = buildFolderTree(folderPath, collectedPaths)
  event.sender.send('scan-folder-done', { totalCount, folderTree, rootPath: folderPath })
})

ipcMain.handle('get-thumbnail-url', async (event, imagePath) => {
  return await getThumbnailUrl(imagePath)
})

ipcMain.handle('get-full-image-url', async (event, imagePath) => {
  return pathToPicUrl(imagePath)
})
