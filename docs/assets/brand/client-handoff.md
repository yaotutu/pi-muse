# B 企鹅移动端素材交接

B 企鹅（历史设计编号 T1）同时是 Pi Muse 品牌和内置默认形象：圆润简洁、蓝白配色，无头毛、无腮红。唯一完整视觉基准是 `previews/neutral-icon-master.png`，确认稿 SHA-256 为 `53182c9e203f7dfb5d6af30202862e851fabc2a565a276b62f79a79e96850245`；透明派生是 `mascot/transparent.png`。项目级来源为 `docs/assets/brand/`，角色与用途边界见 [品牌资产说明](README.md)。

## 内置默认八态

用户已确认 B 八态静态稿，正式产物在 [`companion/`](companion/README.md)，八张均为 512 × 512 RGBA PNG，已整包复制到当前客户端源码：

| 本目录源文件 | 移动端目标 |
| --- | --- |
| `companion/idle.png` | `assets/images/avatar/idle.png` |
| `companion/thinking.png` | `assets/images/avatar/thinking.png` |
| `companion/responding.png` | `assets/images/avatar/responding.png` |
| `companion/working.png` | `assets/images/avatar/working.png` |
| `companion/waiting-approval.png` | `assets/images/avatar/waiting-approval.png` |
| `companion/success.png` | `assets/images/avatar/success.png` |
| `companion/error.png` | `assets/images/avatar/error.png` |
| `companion/stopped.png` | `assets/images/avatar/stopped.png` |

`idle` 复用现有 `mascot/transparent.png` 派生，不另立母版；其余七态的已批准 JPEG 原图放在 `companion/sources/`。包内确定性构建脚本和 `companion/manifest.json` 负责记录来源、处理方式、尺寸与校验和，不依赖旧图标脚本或 ZIP。

同一身份、透明边缘与 64dp 显示已经过静态和 Android 真实资源检查，客户端八张图片与正式来源逐字节一致；源码接入不等于手机已安装，请核对发布版本。后续更新仍应整包检查与复制，不只换待机态，也不与旧 C 图混装。消费方保留自身资源副本及来源清单，运行时不读取兄弟仓库。

超级玛丽水管工仅为服务端可选形象，不成为品牌或内置默认，本次不改真实实例。耳机玩偶 A 保留[收藏原图](../../archive/visual-explorations/headphone-plush.png)，原 C 八态保留[字节不变归档与 SHA-256](../../archive/visual-explorations/companion-c/README.md)；A / C 均不进入新 B 包。既有 C 来源图和视频继续保留，本次只交付静态图，没有视频。

## 已接入的品牌图标

App 图标和两端 README 顶图已经使用 B，本次不再替换。以下是此前图标交付的源文件与目标关系：

| 本目录源文件 | 移动端目标 | 用途与引用边界 |
| --- | --- | --- |
| `client/icon.png` | `assets/icon.png` | iOS/通用 launcher 源图；`app.json` 引用同名目标 |
| `client/android-icon-foreground.png` | `assets/android-icon-foreground.png` | Android adaptive 前景；已引用同名目标 |
| `client/android-icon-background.png` | `assets/android-icon-background.png` | Android adaptive 背景；已引用同名目标 |
| `client/android-icon-monochrome.png` | `assets/android-icon-monochrome.png` | Android 主题单色层；已引用同名目标 |
| `client/favicon.png` | `assets/favicon.png` | Web favicon；已引用同名目标 |
| `client/splash-icon.png` | `assets/splash-icon.png` | 已复制，但 `app.json` 尚未配置 `expo-splash-screen` 插件，不能称启动页已启用 |
| `client/images/muse-companion.png` | 历史单张静态图交付槽位 | 不是 `assets/images/avatar/` 默认八态，不用于本次整包替换 |
| `client/web/icon-{16,32,192,512}.png` | 备选 `assets/web/` 同名文件 | 备选 Web 图，未接入 |

2026-11-11 起，通用图标、adaptive 三层、启动图与 favicon 已复制到客户端 `assets/`。图标接入与正式 Android 包启动器检查是过去图标工作的结果，不替代本轮默认八态原生验收。Expo 构建负责生成所需密度和平台尺寸；这些源图不是 Android/iOS 原生资源 catalog，也不是 Icon Composer `.icon`。按钮和导航图标继续由 `lucide-react-native` 维护。

Android 背景层使用协调浅色 `#F1F6FA`，`backgroundColor` 使用同色作为纯色兜底；它不是精确采样的品牌标准色。启动图与 Android 前景是字节相同的 1024 × 1024 RGBA PNG，非零 alpha 位于中央 2/3 直径圆内。若后续启用启动页插件，仍需原生构建验收，不能用 Expo Go 或 asset mock 替代。平台依据见 [Expo 图标与启动页说明](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)和 [Android 启动图安全区](https://developer.android.com/develop/ui/views/launch/splash-screen)。

## 旧 ZIP 的边界

`delivery/pi-muse-client-assets.zip` 只是过去图标与单张静态形象的交付快照，内含当时的 `assets/`、本指南旧副本 `asset-guide.md` 和 `checksums.sha256`；外部 `manifest.json` 记录当时的尺寸与包哈希。ZIP 里的指南属于历史快照，不覆盖本页当前八态说明。

新 B 八态直接从 `companion/` 交付，不在旧 ZIP 中，不重建旧 ZIP，也不新增 ZIP。`build-client-icons.py` 只属于旧图标批次，不是八态构建入口。旧 A13 图标、桃色背景 T1、失败透明草稿、A 收藏和 C 动画均保留历史边界，不进入当前 B 默认八态包。
