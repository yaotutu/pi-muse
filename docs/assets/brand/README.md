# Pi Muse 项目级品牌与吉祥物

这里是整个 Pi Muse 项目的形象资产源，不是服务端专属素材。文件暂随主仓库管理，因为工作区根目录不在 Git 中；不另建资源服务、npm 包或第三个仓库。

## 唯一正式角色：B 企鹅

用户最终确认：**B 企鹅同时是品牌 LOGO 和默认虚拟形象。** 本目录历史设计编号为 T1；B 与 T1 在这里指同一张已确认母版，不是两套新角色。固定脸型、比例与蓝白配色，App 图标、两端 README 顶部及默认状态图统一从它派生。

| 用途 | 唯一基准或边界 | 当前状态 |
| --- | --- | --- |
| 角色母版 | `previews/neutral-icon-master.png`；透明派生为 `mascot/transparent.png` | 已确认，不重新选型 |
| App / README 品牌图标 | `client/icon.png` 与 Android 三层、favicon | 客户端已接入；服务端 README 直接引用同一张图 |
| 默认八状态形象包 | [`companion/`](companion/README.md)：`idle/thinking/responding/working/waiting-approval/success/error/stopped`，统一为 B | 已完成透明准备并整包接入当前客户端源码；安装版本需核对 Release |
| 超级玛丽水管工 | 仅作为服务端可选外观包；不成为品牌或内置默认 | 独立保留，不修改真实实例 |
| 耳机玩偶 A | [历史原图](../../archive/visual-explorations/headphone-plush.png) | 用户仍喜欢，保留收藏；不进入新 B 包 |
| 毛绒企鹅 C | [原八态归档](../../archive/visual-explorations/companion-c/README.md)与[旧动作素材导航](../../avatar.md) | 原图和历史视频保留，不作为 B 的状态图来源，也不与新 B 包混装 |

**整包切换规则：** 新 B 八态全部完成身份、状态辨识、透明边缘与 64dp 可读性检查后，再整体替换客户端默认图。不能只换待机图，把其他七态仍留作 C；制作中不得把新包写成已交付。视频不在本次范围。

## 当前基准

B 企鹅（历史编号 T1）是项目吉祥物和默认角色的唯一视觉基准，供客户端、网站、README、文档、宣传图及后续动作共同使用。

- [neutral-icon-master.png](previews/neutral-icon-master.png)：用户已确认满意的当前完整视觉基准，1254 × 1254、不透明 RGB PNG。后续角色与图标派生默认使用这张蓝白企鹅、浅瓷白底的图片，不再重新选形象或背景；文件保留原路径，避免不必要的改名。
- [reference.png](mascot/reference.png)：早期独立形象来源，1254 × 1254、不透明 RGB PNG。从移动端已有独立图原样复制，保留选型和生成溯源。桃色背景已被用户拒绝，不再作为当前完整视觉基准。
- [selected-concept-board.png](mascot/selected-concept-board.png)：用户选型的原始对照图，仅左上角 T1 被选定。它保留最初选型证据，不是第二份可自行修改的母版。
- [manifest.json](manifest.json)：文件职责、尺寸、校验和及交付状态。校验和只用于识别来源，不引入运行时校验或同步框架。

独立形象基准是从选型稿生成的细化图，并非原始 T1 的逐像素放大；如需判断身份差异，回看原始选型图。早期透明草稿有彩色边缘与零散透明度像素，已被拒绝；本次 `mascot/transparent.png` 是从已确认浅底图稿确定性抠出的透明母版。透明图不是 3D、矢量或可编辑分层设计源文件。

## 已确认的图稿与派生素材

![T1 中性浅底图标与尺寸预览](previews/neutral-icon-sheet.png)

- [已确认浅底图稿](previews/neutral-icon-master.png)：由早期形象来源通过内置生图工具编辑得到，用户于 2026-10-29 确认满意。生成过程可能轻微改变细节，不称为逐像素抠图；后续从本张确认稿派生，不重新生图替换。
- `exports/neutral-icon-{size}.png`：1024、512、256、128、64、32 六种正方形 RGB PNG，全部从同一张确认稿缩放。可用于头像、文档和图标尺寸评估；没有预先烘焙圆角或圆形遮罩。
- [预览排版源](neutral-icon-sheet.svg)与[生成说明](generation-brief.txt)：保留实际提示词、缩放方式和已知限制，便于后续继续制作。

用户已认可图稿中的浅瓷白背景，以实际图片为准，不把生成提示中的色值当作经过测量的品牌色标准。历史预览中的圆角、圆形仅用于观察裁切效果，不是 iOS 或 Android 原生验收。

## 默认八态静态包

用户已确认 B 八态静态稿；正式产物统一放在 [`companion/`](companion/README.md)，八张均为 512 × 512 RGBA PNG，已整包接入当前客户端源码。`idle` 复用现有 `mascot/transparent.png` 派生，不另立待机母版；其余七态的已批准 JPEG 原图保留在 `companion/sources/`，由包内确定性脚本处理。尺寸、来源与校验和见 [`companion/manifest.json`](companion/manifest.json)，浅深底透明检查见包内预览。文件回归与 Android 真实资源显示已核对；这不等于用户手机已更新到此源码版本。

这是内置默认八态的独立交付，不是下方旧 ZIP 的扩充，也不是视频。移动端只复制完成验收的八张 PNG 到自身 `assets/images/avatar/`；运行时不依赖本仓库路径。A 收藏与 C 归档均不进入新包，服务端可选水管工也不随本次默认图替换而修改。

## 历史图标与单张静态图交接快照

![T1 客户端图标模拟预览](previews/client-icon-sheet.png)

- [透明吉祥物](mascot/transparent.png)：1254 × 1254 RGBA，保留脸腹、短翅和双脚；从确认稿按颜色、连通区域与边缘平滑确定性抠图。透明母版可在浅色和深色表面复用。
- `client/icon.png`：1024 × 1024 RGB，不透明、无预烘焙圆角；作为 iOS 通用源图，不另存同内容副本。
- `client/android-icon-foreground.png`、`client/android-icon-background.png`、`client/android-icon-monochrome.png`：各 1024 × 1024；前景与单色层为 RGBA，背景为 RGB。单色层白色主体的 alpha 留出了眼睛与嘴部。前景和单色层的所有非零 alpha 像素均落在中央 66/108 直径安全圆内。
- `client/favicon.png`：48 × 48；`client/web/icon-{16,32,192,512}.png`：相应像素尺寸，均是不透明 RGB 图。
- `client/images/muse-companion.png`：512 × 512 真 RGBA 的 B 静态派生图，不是运行时默认八态包；由透明母版机械缩放并居中留白，不包含动作状态。
- `client/splash-icon.png`：1024 × 1024 真 RGBA，与 Android 前景**字节相同**，复用其中央安全圆构图。供后续启动页接入；当前 `app.json` 尚未启用启动页插件。
- [移动端交接指南](client-handoff.md)区分当前八态与历史图标交付；[便携 ZIP](delivery/pi-muse-client-assets.zip)仅是过去图标与单张静态形象的交付快照，包含当时的 PNG、指南副本及包内校验和，不含新 B 八态，不重建或新增 ZIP。
- [预览排版源](client-icon-sheet.svg)、[可复现脚本](build-client-icons.py)：预览模拟 iOS 圆角、Android 圆形和圆角遮罩、主题单色、多尺寸、透明形象、圆形头像和启动图构图。Android 预览将完整 108dp 图层放在居中的 72dp 可见视口后裁切；整张图都是 asset mock，不是原生验收。

`build-client-icons.py` 是过去这批图标 PNG、预览与 ZIP 的可复现脚本，不是新 B 八态构建入口；本次保留脚本和 ZIP 快照，不运行它重建旧包。脚本需本机有 ImageMagick 7 和 librsvg 的 `rsvg-convert`，Python 只编排命令、复制相同字节的启动图及制作确定性 ZIP，像素操作均由 ImageMagick 完成。它读取唯一已确认母版，不读取历史桃色来源，不调用生图服务，不修改原图。Android 纯色背景 `#F1F6FA` 是与图稿浅底协调的派生色，不替代原图背景或建立新的标准品牌色。

文件尺寸、模式、SHA-256 和静态安全区结果见 [manifest.json](manifest.json)。该清单是图标与单张静态图制作记录，不是新 B 八态清单；企鹅图标已完成客户端接入与正式 Android 包启动器检查，启动页插件仍未启用，新 B 八态的透明处理、客户端整包替换与原生显示另行验收。

图层尺寸与安全区按 [Android adaptive icon 规范](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive) 制作；PNG、iOS 源图和 Android 三层命名参考 [Expo 图标说明](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)。

本批素材已合入主仓库 `main`，统一从 `docs/assets/brand/` 读取，不再依赖独立素材工作树。

2026-11-11 起，移动端已实际接入本包：客户端仓库把 `client/` 下的通用图标、Android 三层、启动图与 favicon 复制进 `assets/`，`app.json` 沿用同名路径并把 adaptive 背景兜底色改为 `#F1F6FA`；此前客户端一直沿用 Expo 默认启动图标，未替换过任何品牌资源。接入后的静态资源与本包字节一致，启动页插件仍未启用。

## 主线资产与后续接入

- 用户已于 2026-10-29 认可整套静态素材；T1 形象与浅瓷白配色定稿，不再重新选型或生成替代角色。
- 素材来自主仓库（`pi-muse-server`）的 `brand-assets` 分支，交付范围仅为 `docs/assets/brand/`。主线保留其他模块的当前代码；原素材分支和独立工作树在合并收尾时清理，后续工作直接使用主仓库的同路径。
- 客户端接入按 [client-handoff.md](client-handoff.md) 复制正式资源并局部更新配置；移动端改动在其独立仓库提交。静态素材完成不代表已经安装到手机，启动页插件也尚未启用；接入后由接手 Agent 完成当前版本的 Android 原生验收。
- 保留母版、透明图、正式导出、预览与 SVG 源、重建脚本、清单、生成溯源及交付 ZIP。历史选型证据与旧动作素材不属于正式包，不在本次收尾中跨模块删除。
- 本次收尾核查未发现素材目录内的临时日志、备份、缓存或未跟踪文件；不为制造清理记录删除有用途的素材。根级 `project-map.md` 不受本仓库 Git 管理，素材入口已指向主仓库路径。

## 固定形象，分离用途

固定特征：饱满蛋形身体、粉蓝色外壳、连续的暖象牙白脸腹、额头中间浅凹、深色椭圆眼睛、橙杏色小嘴和小脚、两侧短翅，以及简洁柔软的哑光质感。不加毛绒头冠、腮红、衣物或复杂羽毛，不因换背景顺带改变脸型、比例或蓝白配色。

背景、构图、安全留白、输出尺寸和平台遮罩属于派生设计，不属于吉祥物身份。当前图标沿用已确认的浅瓷白背景；其他场景可按用途适配背景，不顺带改变角色。派生动作可以变化，但仍须看得出是同一个角色；更换形象身份须由用户决定。

## 使用与派生

1. 制作前从这里读取基准图片与说明，不只凭文字描述重画企鹅。
2. 优先对同一母版做裁切、缩放、背景合成。AI 生成新姿态或动画时必须附基准图，并实际核对形象一致性；生成器无法保证逐像素相同。
3. 导出放在消费方自己的资源目录。例如移动端保存平台图标，网站保存网站用图，README 保存展示图。它们是派生文件，不是另立一套角色母版；运行时不依赖兄弟仓库路径，也不临时请求主仓库图片。
4. 在消费方已有素材说明中记录来源路径、基准文件的 SHA-256、用途和必要生成提示词即可。基准实际更换后，按需重做受影响的派生文件，不建立自动跨仓库同步系统。
5. 新基准或透明母版确认合格后，在这里统一更新文件和清单，再更新消费方。Git 保存历史，不在各端堆叠多套“最终版”母版。

## 旧素材边界

原 [avatar 动作素材](../avatar/)是 C 毛绒企鹅的历史探索，不是 B / T1 的动作扩展；移动端原有的八张 C 运行时 PNG 已[按原字节归档](../../archive/visual-explorations/companion-c/README.md)。保留已有图片、提示词和视频，不删除、不自动重做，也不声称已经符合 B 形象。移动端旧 A13 图标包同样仅供归档。

本目录不提供运行时资源端点。品牌图标与 README 顶图已经使用 B，本次不再改动；内置默认八态按上方整包切换规则交付与验收，不把角色选定、静态生成或旧图标验收等同于新八态已完成原生接入。
