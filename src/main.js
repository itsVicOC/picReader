import { createApp } from 'vue'
import App from './App.vue'
import VueVirtualScroller from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import './styles/main.css'

createApp(App).use(VueVirtualScroller).mount('#app')
