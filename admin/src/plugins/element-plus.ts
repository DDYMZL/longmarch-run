// Element Plus 按需注册：仅注册用到的组件与 v-loading 指令，样式按组件引入，
// 替代 app.use(ElementPlus) 全量注册 + dist/index.css 全量样式（约省 700KB+ CSS/JS）。
// 新增组件时：在 components 与样式区各加一行即可（style/css 入口会自动带上内部依赖样式）。
import type { App } from 'vue'
import {
  ElAlert,
  ElAside,
  ElAvatar,
  ElButton,
  ElCard,
  ElCheckbox,
  ElCheckboxGroup,
  ElContainer,
  ElDatePicker,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElLoading,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTooltip,
  ElTreeSelect,
  provideGlobalConfig
} from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import 'element-plus/es/components/base/style/css'
import 'element-plus/es/components/alert/style/css'
import 'element-plus/es/components/aside/style/css'
import 'element-plus/es/components/avatar/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/card/style/css'
import 'element-plus/es/components/checkbox/style/css'
import 'element-plus/es/components/checkbox-group/style/css'
import 'element-plus/es/components/container/style/css'
import 'element-plus/es/components/date-picker/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/divider/style/css'
import 'element-plus/es/components/drawer/style/css'
import 'element-plus/es/components/empty/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/form-item/style/css'
import 'element-plus/es/components/header/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/main/style/css'
import 'element-plus/es/components/menu/style/css'
import 'element-plus/es/components/menu-item/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/pagination/style/css'
import 'element-plus/es/components/progress/style/css'
import 'element-plus/es/components/radio/style/css'
import 'element-plus/es/components/radio-button/style/css'
import 'element-plus/es/components/radio-group/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/tab-pane/style/css'
import 'element-plus/es/components/tabs/style/css'
import 'element-plus/es/components/table/style/css'
import 'element-plus/es/components/table-column/style/css'
import 'element-plus/es/components/tag/style/css'
import 'element-plus/es/components/tooltip/style/css'
import 'element-plus/es/components/tree-select/style/css'
// 程序化调用与指令的样式（ElMessage / ElMessageBox / ElNotification / v-loading）
import 'element-plus/es/components/loading/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/notification/style/css'

const components = [
  ElAlert,
  ElAside,
  ElAvatar,
  ElButton,
  ElCard,
  ElCheckbox,
  ElCheckboxGroup,
  ElContainer,
  ElDatePicker,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElHeader,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTooltip,
  ElTreeSelect
]

export function setupElementPlus(app: App): void {
  components.forEach((component) => app.use(component))
  app.use(ElLoading) // v-loading 指令
  // 中文语言包全局生效（第三个参数使 ElMessage/ElMessageBox 等程序化调用同样生效）
  provideGlobalConfig({ locale: zhCn }, app, true)
}
