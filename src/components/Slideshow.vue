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
      {{ currentIndex + 1 }} / {{ images.length }}
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

const currentIndex = ref(Math.min(Math.max(props.startIndex ?? 0, 0), props.images.length - 1))
const isPlaying = ref(true)
const currentImageURL = ref(null)
const imageError = ref(false)
let intervalId = null
const SLIDESHOW_INTERVAL = 3000
const PRELOAD_COUNT = 2 // 前后各预加载 2 张

const currentImage = computed(() => props.images[currentIndex.value])

async function loadImage(imagePath) {
  currentImageURL.value = null
  imageError.value = false
  try {
    const url = await window.fileAPI.getFullImageUrl(imagePath)
    currentImageURL.value = url
  } catch {
    imageError.value = true
  }
}

function next() {
  currentIndex.value = (currentIndex.value + 1) % props.images.length
}

function prev() {
  currentIndex.value = (currentIndex.value - 1 + props.images.length) % props.images.length
}

function togglePlay() {
  isPlaying.value = !isPlaying.value
  if (isPlaying.value) startInterval()
  else stopInterval()
}

function startInterval() {
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
  if (img) loadImage(img.path)
})

onMounted(() => {
  if (currentImage.value) {
    loadImage(currentImage.value.path)
  }
  if (isPlaying.value) startInterval()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  stopInterval()
  window.removeEventListener('keydown', handleKeydown)
  preloadedPaths.clear()
})
</script>
