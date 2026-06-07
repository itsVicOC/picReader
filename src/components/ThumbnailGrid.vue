<template>
  <RecycleScroller
    ref="scrollerRef"
    class="thumbnail-scroller"
    :items="images"
    :item-size="CARD_HEIGHT"
    :grid-items="gridItems"
    :item-secondary-size="itemSecondarySize"
    key-field="path"
    :emit-update="true"
    @update="onVisibleRangeChange"
    v-slot="{ item: img, index }"
  >
    <div
      class="thumbnail-card"
      @click="$emit('image-click', index)"
    >
      <img
        v-if="thumbnailUrls[img.path]"
        :src="thumbnailUrls[img.path]"
        :alt="img.name"
        loading="lazy"
      />
      <div v-else class="thumbnail-placeholder">
        {{ loadingStates[img.path] ? '生成中...' : '待加载' }}
      </div>
      <div class="thumbnail-name">{{ img.name }}</div>
    </div>
  </RecycleScroller>
</template>

<script setup>
import { ref, watch, onUnmounted, onMounted, nextTick } from 'vue'

const props = defineProps({
  images: Array,
})

const emit = defineEmits(['image-click'])
const scrollerRef = ref(null)

// 网格布局参数
const MIN_CARD_WIDTH = 200
const CARD_HEIGHT = 220
const gridItems = ref(1)
const itemSecondarySize = ref(MIN_CARD_WIDTH)

// 使用响应式对象存储已加载的缩略图 URL，避免直接修改 props
const thumbnailUrls = ref({})

let cancelLoading = false
let loadGeneration = 0
// 使用响应式对象跟踪加载状态，template 中可正确响应
const loadingStates = ref({})
const CONCURRENCY = 8
const BUFFER = 16 // 可见区域上下各预加载 16 个（grid 模式下范围更大）
const INITIAL_BATCH = 48 // grid 模式下初始加载更多
const CACHE_LIMIT = 2000
const thumbnailUrlCache = new Map()

let visibleStart = 0
let visibleEnd = 0

function onVisibleRangeChange(startIndex, endIndex) {
  // 扩展可见范围以预加载缓冲区
  visibleStart = Math.max(0, startIndex - BUFFER)
  visibleEnd = Math.min(props.images.length - 1, endIndex + BUFFER)
  scheduleLoad()
}

let loadTimer = null
function scheduleLoad() {
  if (loadTimer) return
  loadTimer = setTimeout(() => {
    loadTimer = null
    loadVisibleThumbnails()
  }, 50)
}

function countLoading() {
  return Object.keys(loadingStates.value).length
}

function isLoading(path) {
  return !!loadingStates.value[path]
}

function rememberThumbnailUrl(imagePath, url) {
  if (thumbnailUrlCache.has(imagePath)) {
    thumbnailUrlCache.delete(imagePath)
  }
  thumbnailUrlCache.set(imagePath, url)

  while (thumbnailUrlCache.size > CACHE_LIMIT) {
    const oldestPath = thumbnailUrlCache.keys().next().value
    thumbnailUrlCache.delete(oldestPath)
  }
}

function hydrateThumbnailUrls(images) {
  const urls = {}
  for (const img of images) {
    const cachedUrl = thumbnailUrlCache.get(img.path)
    if (cachedUrl) {
      thumbnailUrlCache.delete(img.path)
      thumbnailUrlCache.set(img.path, cachedUrl)
      urls[img.path] = cachedUrl
    }
  }
  thumbnailUrls.value = urls
}

async function loadVisibleThumbnails(generation = loadGeneration) {
  if (cancelLoading) return

  let end = visibleEnd
  // 如果 visibleEnd 为 0（初始状态或 emitUpdate 尚未触发），先加载一批初始图片
  if (end === 0 && props.images.length > 1) {
    end = Math.min(INITIAL_BATCH, props.images.length - 1)
  }

  const toLoad = []
  for (let i = visibleStart; i <= end && i < props.images.length; i++) {
    const img = props.images[i]
    if (!thumbnailUrls.value[img.path] && !thumbnailUrlCache.has(img.path) && !isLoading(img.path)) {
      toLoad.push(img)
    }
  }

  const running = countLoading()
  const available = CONCURRENCY - running
  const batch = toLoad.slice(0, available)

  for (const img of batch) {
    if (cancelLoading) return
    loadingStates.value[img.path] = true
    loadThumbnail(img, generation).finally(() => {
      if (generation !== loadGeneration) return
      delete loadingStates.value[img.path]
      // 加载完成后继续检查是否需要加载更多
      loadVisibleThumbnails(generation)
    })
  }
}

async function loadThumbnail(img, generation) {
  try {
    const url = await window.fileAPI.getThumbnailUrl(img.path)
    if (cancelLoading || generation !== loadGeneration) return
    rememberThumbnailUrl(img.path, url)
    thumbnailUrls.value[img.path] = url
  } catch (e) {
    console.warn('Thumbnail failed:', img.name, e)
  }
}

// ResizeObserver 监听容器宽度，动态计算 grid 列数
let rafId = null
const resizeObserver = new ResizeObserver(() => {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    updateGridLayout()
  })
})

function updateGridLayout() {
  const el = scrollerRef.value?.$el
  if (!el) return
  const width = el.clientWidth
  if (width <= 0) return
  const items = Math.max(1, Math.floor(width / MIN_CARD_WIDTH))
  const newSize = Math.floor(width / items)
  // 避免无意义更新，防止 ResizeObserver 循环
  if (gridItems.value === items && itemSecondarySize.value === newSize) return
  gridItems.value = items
  itemSecondarySize.value = newSize
}

onMounted(() => {
  if (scrollerRef.value?.$el) {
    resizeObserver.observe(scrollerRef.value.$el)
  }
  nextTick(() => updateGridLayout())
})

watch(
  () => props.images,
  async (newImages) => {
    if (!newImages) return

    cancelLoading = true
    loadGeneration++
    if (loadTimer) {
      clearTimeout(loadTimer)
      loadTimer = null
    }
    await nextTick()

    hydrateThumbnailUrls(newImages)
    loadingStates.value = {}
    visibleStart = 0
    visibleEnd = 0

    cancelLoading = false
    if (newImages.length > 0) {
      loadVisibleThumbnails(loadGeneration)
    }

    // 图片变化后重新计算布局
    nextTick(() => updateGridLayout())
  },
  { immediate: true }
)

onUnmounted(() => {
  cancelLoading = true
  loadGeneration++
  if (loadTimer) {
    clearTimeout(loadTimer)
    loadTimer = null
  }
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  resizeObserver.disconnect()
})
</script>
