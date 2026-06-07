<template>
  <aside class="sidebar">
    <h3>文件夹</h3>
    <ul class="folder-tree">
      <FolderNode
        :node="tree"
        :selected="selectedFolder"
        @select="$emit('select', $event)"
      />
    </ul>
  </aside>
</template>

<script setup>
import { h, computed } from 'vue'

const props = defineProps({
  tree: Object,
  selectedFolder: String,
})

defineEmits(['select'])

// 递归文件夹节点组件
const FolderNode = {
  name: 'FolderNode',
  props: {
    node: Object,
    selected: String,
  },
  emits: ['select'],
  setup(props, { emit }) {
    const isActive = computed(() => props.node.path === props.selected)

    return () => {
      const node = props.node
      const children = node.children || []

      return h('li', [
        h('div', {
          class: ['folder-item', { active: isActive.value }],
          onClick: () => emit('select', node.path),
        }, [
          h('span', { class: 'folder-icon' }, '📁'),
          h('span', { class: 'folder-name' }, node.name),
          h('span', { class: 'folder-count' }, `(${node.totalCount ?? 0})`),
        ]),
        children.length > 0
          ? h('ul', { class: 'folder-children' },
              children.map(child =>
                h(FolderNode, {
                  key: child.path,
                  node: child,
                  selected: props.selected,
                  onSelect: (path) => emit('select', path),
                })
              )
            )
          : null,
      ])
    }
  },
}
</script>
