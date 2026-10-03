import { createApp } from 'vue'
import {
  ChatLineSquare,
  Check,
  CircleCheck,
  DataAnalysis,
  Delete,
  Download,
  EditPen,
  Location,
  Lock,
  Monitor,
  Odometer,
  OfficeBuilding,
  Plus,
  Position,
  Promotion,
  Refresh,
  Search,
  TrendCharts,
  User,
  UserFilled
} from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { setupElementPlus } from './plugins/element-plus'
import './style.css'

// 模板中实际用到的图标（含 :icon="'Refresh'" 这类字符串引用），按需全局注册
const icons = {
  ChatLineSquare,
  Check,
  CircleCheck,
  DataAnalysis,
  Delete,
  Download,
  EditPen,
  Location,
  Lock,
  Monitor,
  Odometer,
  OfficeBuilding,
  Plus,
  Position,
  Promotion,
  Refresh,
  Search,
  TrendCharts,
  User,
  UserFilled
}

const app = createApp(App)
for (const [key, component] of Object.entries(icons)) {
  app.component(key, component)
}
setupElementPlus(app)
app.use(router)
app.mount('#app')
