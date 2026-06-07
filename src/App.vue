<template>
  <div class="app-container">
    <header class="toolbar">
      <button @click="pickAndScanFolder" :disabled="scanning">
        {{ scanning ? '扫描中...' : '选择文件夹' }}
      </button>
      <button v-if="currentFolder" @click="rescanFolder" :disabled="scanning" title="重新扫描当前文件夹">
        🔄
      </button>
      <span v-if="currentFolder" class="current-path">{{ currentFolder }}</span>
      <span v-if="!currentFolder" class="current-path">请先选择一个包含图片的文件夹</span>
      <span v-if="scanning && totalCount > 0" class="loading-progress">
        已扫描 {{ allImages.length }} / {{ totalCount }} 张...
      </span>
      <span v-else-if="scanning" class="loading-progress">
        扫描中...
      </span>
      <span v-else-if="currentFolder" class="loading-progress">
        共 {{ allImages.length }} 张图片
      </span>
    </header>

    <div class="main-layout">
      <Sidebar
        v-if="folderTree"
        :tree="folderTree"
        :selectedFolder="selectedFolder"
        @select="onFolderSelect"
      />
      <div class="grid-area">
        <div v-if="scanning && allImages.length === 0" class="loading-overlay">扫描中...</div>
        <div v-else-if="scanError" class="empty-state">
          <span>扫描出错：{{ scanError }}</span>
        </div>
        <div v-else-if="filteredImages.length === 0 && currentFolder" class="empty-state">
          该文件夹下没有找到图片
        </div>
        <ThumbnailGrid
          v-else
          :images="filteredImages"
          @image-click="openSlideshow"
        />
      </div>
    </div>

    <Slideshow
      v-if="slideshowOpen"
      :images="filteredImages"
      :startIndex="slideshowIndex"
      @close="slideshowOpen = false"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ThumbnailGrid from './components/ThumbnailGrid.vue'
import Slideshow from './components/Slideshow.vue'

const currentFolder = ref(null)
const folderTree = ref(null)
const allImages = ref([])
const selectedFolder = ref(null)
const slideshowOpen = ref(false)
const slideshowIndex = ref(0)
const scanning = ref(false)
const totalCount = ref(0)
const scanError = ref(null)

let unsubProgress = null
let unsubDone = null
let unsubError = null
let flushTimer = null
let pendingBatch = []
let activeScanId = null

// 跨平台路径过滤：兼容 Windows 反斜杠和 Unix 正斜杠
const filteredImages = computed(() => {
  if (!selectedFolder.value || selectedFolder.value === currentFolder.value) {
    return allImages.value
  }
  const folder = selectedFolder.value.replace(/[\\/]+$/, '')
  return allImages.value.filter(img => {
    const imgDir = img.path.substring(0, Math.max(img.path.lastIndexOf('\\'), img.path.lastIndexOf('/')))
    return imgDir === folder || img.path.startsWith(folder + '\\') || img.path.startsWith(folder + '/')
  })
})

function flushPendingImages() {
  if (pendingBatch.length > 0) {
    allImages.value.push(...pendingBatch)
    pendingBatch = []
  }
  flushTimer = null
}

function queueImages(images) {
  pendingBatch.push(...images)
  if (!flushTimer) {
    // 使用 setTimeout 批量刷新，避免每批 IPC 消息都触发 Vue 重新渲染
    flushTimer = setTimeout(flushPendingImages, 0)
  }
}

function cleanupSubscriptions() {
  if (unsubProgress) {
    unsubProgress()
    unsubProgress = null
  }
  if (unsubDone) {
    unsubDone()
    unsubDone = null
  }
  if (unsubError) {
    unsubError()
    unsubError = null
  }
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingBatch = []
}

function createScanId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function scanFolder(folder) {
  if (!folder) return

  if (activeScanId) {
    window.fileAPI.cancelScan(activeScanId)
  }

  // 清理旧订阅和状态
  cleanupSubscriptions()

  const scanId = createScanId()
  activeScanId = scanId
  scanning.value = true
  scanError.value = null
  currentFolder.value = folder
  selectedFolder.value = folder
  allImages.value = []
  folderTree.value = null
  totalCount.value = 0

  // 订阅流式事件
  unsubProgress = window.fileAPI.onScanProgress((data) => {
    if (data.scanId !== activeScanId) return
    queueImages(data.images)
    totalCount.value = data.totalSoFar
  })

  unsubDone = window.fileAPI.onScanDone((data) => {
    if (data.scanId !== activeScanId) return
    // 先刷新剩余数据
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushPendingImages()
    scanning.value = false
    totalCount.value = data.totalCount
    folderTree.value = data.folderTree
    activeScanId = null
    cleanupSubscriptions()
  })

  unsubError = window.fileAPI.onScanError((data) => {
    if (data.scanId !== activeScanId) return
    scanning.value = false
    scanError.value = data.error || '扫描失败'
    activeScanId = null
    cleanupSubscriptions()
  })

  // 启动流式扫描
  window.fileAPI.startScanStream(scanId, folder)
}

async function pickAndScanFolder() {
  const folder = await window.fileAPI.pickFolder()
  if (!folder) return
  await scanFolder(folder)
}

async function rescanFolder() {
  if (currentFolder.value) {
    await scanFolder(currentFolder.value)
  }
}

function onFolderSelect(folderPath) {
  selectedFolder.value = folderPath
}

function openSlideshow(index) {
  slideshowIndex.value = index
  slideshowOpen.value = true
}

// 启动时尝试加载上次目录
onMounted(async () => {
  try {
    const lastFolder = await window.fileAPI.getLastFolder()
    if (lastFolder) {
      await scanFolder(lastFolder)
    }
  } catch (err) {
    console.warn('Load last folder failed:', err)
  }
})

onUnmounted(() => {
  if (activeScanId) {
    window.fileAPI.cancelScan(activeScanId)
    activeScanId = null
  }
  cleanupSubscriptions()
})
</script>
