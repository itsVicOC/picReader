<template>
  <div class="slideshow-overlay" @click.self="close">
    <img
      v-if="currentImageURL"
      :src="currentImageURL"
      class="slideshow-image"
      :alt="currentImage?.name"
      @load="onImageLoad"
      @error="onImageError"
    />
    <div v-else-if="imageError" class="slideshow-image" style="display:flex;align-items:center;justify-content:center;color:#c44;">
      图片加载失败
    </div>
    <div v-else class="slideshow-image" style="display:flex;align-items:center;justify-content:center;color:#666;">
      加载中...
    </div>
    <div class="slideshow-controls">
      <button @click="prev">◀</button>
      <button @click="togglePlay">{{ isPlaying ? '⏸' : '▶' }}</button>
      <button @click="next">▶</button>
      <button @click="close">✕</button>
    </div>
    <div class="slideshow-counter">
      {{ displayIndex }} / {{ images.length }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps({
  images: Array,
  startIndex: Number,
})

const emit = defineEmits(['close'])

function normalizeIndex(index, length) {
  if (length <= 0) return 0
  return Math.min(Math.max(index ?? 0, 0), length - 1)
}

const currentIndex = ref(normalizeIndex(props.startIndex, props.images.length))
const isPlaying = ref(false)
const currentImageURL = ref(null)
const imageError = ref(false)
let intervalId = null
let loadGeneration = 0
const SLIDESHOW_INTERVAL = 3000
const PRELOAD_COUNT = 2 // 前后各预加载 2 张

const currentImage = computed(() => props.images[currentIndex.value])
const displayIndex = computed(() => (props.images.length > 0 ? currentIndex.value + 1 : 0))

async function loadImage(imagePath, generation = loadGeneration) {
  currentImageURL.value = null
  imageError.value = false
  if (!imagePath) return

  try {
    const url = await window.fileAPI.getFullImageUrl(imagePath)
    if (generation !== loadGeneration) return
    currentImageURL.value = url
  } catch {
    if (generation !== loadGeneration) return
    imageError.value = true
  }
}

function next() {
  if (props.images.length === 0) return
  currentIndex.value = (currentIndex.value + 1) % props.images.length
}

function prev() {
  if (props.images.length === 0) return
  currentIndex.value = (currentIndex.value - 1 + props.images.length) % props.images.length
}

function togglePlay() {
  if (props.images.length <= 1) {
    isPlaying.value = false
    stopInterval()
    return
  }
  isPlaying.value = !isPlaying.value
}

function startInterval() {
  if (props.images.length <= 1) return
  stopInterval()
  intervalId = setInterval(next, SLIDESHOW_INTERVAL)
}

function stopInterval() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

function close() {
  stopInterval()
  emit('close')
}

function handleKeydown(e) {
  switch (e.key) {
    case 'ArrowRight':
      next()
      break
    case 'ArrowLeft':
      prev()
      break
    case ' ':
      e.preventDefault()
      togglePlay()
      break
    case 'Escape':
      close()
      break
  }
}

function onImageLoad() {
  // 图片加载成功后，继续预加载周围的图片
  preloadSurroundingImages()
}

function onImageError() {
  imageError.value = true
}

// 预加载当前图片周围的几张图片
async function preloadSurroundingImages() {
  const len = props.images.length
  if (len <= 1) return

  for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
    const nextIdx = (currentIndex.value + offset) % len
    const prevIdx = (currentIndex.value - offset + len) % len
    preloadImage(props.images[nextIdx]?.path)
    preloadImage(props.images[prevIdx]?.path)
  }
}

const preloadedPaths = new Set()

async function preloadImage(imagePath) {
  if (!imagePath || preloadedPaths.has(imagePath)) return
  try {
    const url = await window.fileAPI.getFullImageUrl(imagePath)
    const img = new Image()
    img.src = url
    preloadedPaths.add(imagePath)
  } catch {
    // 预加载失败不影响当前显示
  }
}

watch(currentImage, (img) => {
  loadGeneration++
  if (img) {
    loadImage(img.path, loadGeneration)
  } else {
    currentImageURL.value = null
    imageError.value = false
  }
})

watch(
  () => props.images.length,
  (length) => {
    currentIndex.value = normalizeIndex(currentIndex.value, length)
    if (length <= 1) {
      isPlaying.value = false
      stopInterval()
    }
  }
)

watch(isPlaying, (playing) => {
  if (playing) {
    startInterval()
  } else {
    stopInterval()
  }
})

onMounted(() => {
  if (currentImage.value) {
    loadGeneration++
    loadImage(currentImage.value.path, loadGeneration)
  }
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  stopInterval()
  window.removeEventListener('keydown', handleKeydown)
  preloadedPaths.clear()
})
</script>
