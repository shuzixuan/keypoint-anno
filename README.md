# Keypoint Annotation Tool

标注工具用于纠正 ViTPose 生成的动物姿态关键点预测。ViTPose 原生输出 17 关键点（AP-10K 格式），本工具将其转换为 22 关键点（DANNCE 格式）后提供 Web GUI 供人工拖拽修正。

## 管线流程

```
ViTPose 17kp 预测 → convert_17_to_22.py → 22kp 初始标注 → 浏览器标注工具 → 纠正后数据集
```

## 安装

```bash
pip install -r requirements.txt
```

## 使用方式

### 1. 转换 17kp → 22kp

```bash
python convert_17_to_22.py -i viTPose_predictions.json -o dannce_22kp.json
```

`-i` 必须是 ViTPose 17 关键点（AP-10K 格式）的 COCO JSON。输出 `-o` 为 22 关键点（DANNCE 格式），包含逐点状态标记和插值估算。

### 2. 启动标注工具

```bash
python run.py \
  --images-dir data/images \
  --input dannce_22kp.json \
  --config config/dannce.json \
  --output corrected.json
```

然后浏览器打开 `http://127.0.0.1:8000`。

**参数说明**：

| 参数 | 说明 |
|---|---|
| `--images-dir` | 图片目录 |
| `--input` / `-i` | 输入的 COCO JSON（ViTPose 预测或上次纠正结果） |
| `--config` | 关键点配置文件（22kp 用 `config/dannce.json`，17kp 用 `config/ap10k.json`） |
| `--output` / `-o` | 纠正结果输出路径 |
| `--resume` / `-r` | 中断恢复，等价于 `--input X --output X` |
| `--host` | 绑定 IP，默认 `127.0.0.1` |
| `--port` | 绑定端口，默认 `8000` |

### 3. 中断恢复

```bash
python run.py --images-dir data/images --resume corrected.json --config config/dannce.json
```

所有进度（关键点位置、状态标记、已审核标记）都会持久化到文件，重启后恢复。

## 界面说明

### 顶部工具栏
- `Save` / `Export` — 保存到文件 / 下载 JSON
- `Zoom + / - / Fit` — 缩放画布
- `Skeleton` / `Labels` — 切换骨架线和标签显示
- `Reviewed` — 标记当前图为已审核
- `Pred. / Est. / Corr.` — 图例：P=ViTPose预测，E=估算需确认，C=已手动修正
- `Annotate / Review` — 模式切换

### 左侧图片列表
- 搜索框过滤文件名
- 已审核图片显示 ✓ 前缀和绿色高亮
- 每张图显示标注实例数

### 右侧关键点边栏
- 显示当前实例所有关键点
- 每行：颜色圆点 + 名称 + 状态徽标(P/E/C) + 标注状态(绿=已标/灰=未标) + 置信度
- **点击某行** → 画布上该关键点高亮锁定，鼠标移动不会切换选中
- 锁定后双击画布直接放置该点
- 悬停可查看各字段含义

### 底部栏
- 翻图按钮 + 跳转未审核
- 实例选择、新增、删除
- 置信度滑块（Review 模式下低置信度关键点变灰）
- 待审核计数：当前实例还有几个 interpolated 点

## 关键点状态

每个关键点有三种状态，标注界面中有对应的视觉标记：

| 状态 | 显示 | 含义 | 画布标记 |
|---|---|---|---|
| `predicted` | P（蓝） | ViTPose 直接预测，未动过 | 正常显示 |
| `interpolated` | E（橙） | 插值估算，需人工确认 | 橙色虚线外环 |
| `corrected` | C（绿） | 已手动拖拽/放置修正 | 绿色外环 + ✓ |

## 标注工作流

1. 在右侧边栏点击要标注的关键点（未标的 v=0 点显示灰色圆点，状态为 E）
2. 画布上该点对应的十字标记会高亮显示
3. 双击画布目标位置 → 关键点放置到该位置，状态变为 C（已修正）
4. 也可直接拖拽已有的关键点调整位置，状态自动变为 C
5. 按 `Delete` 键隐藏当前选中的关键点（重置 v=0）
6. 按 `M` 标记图片为已审核，`N` 跳转下一张未审核图

## 快捷键

| 快捷键 | 操作 |
|---|---|
| `←` `→` | 上一张 / 下一张 |
| `0`–`9` | 选择实例 |
| `Tab` | 循环选中下一个已标注关键点 |
| `Delete` | 隐藏当前悬停的关键点 |
| `Ctrl+S` | 保存 |
| `Ctrl+Z` | 撤销 |
| `+` / `-` | 缩放 |
| `R` | 适应窗口 |
| `M` | 标记已审核 |
| `N` | 跳转下一张未审核 |
| 拖拽关键点 | 移动位置 |
| 拖拽空白 | 平移画布 |
| 滚轮 | 缩放 |
| 双击画布 | 放置当前选中的关键点 |

## 自动保存

- 每 60 秒自动保存（有修改时）
- 切换图片时自动保存
- 关闭标签页/浏览器时自动保存
- 手动 `Ctrl+S` 保存

## 目录结构

```
├── annotation_tool/       # 标注工具前后端
│   ├── app.py             # FastAPI 后端
│   ├── templates/         # HTML 模板
│   └── static/            # JS/CSS
├── config/
│   ├── ap10k.json         # 17 关键点配置
│   └── dannce.json        # 22 关键点配置（DANNCE 骨架）
├── convert_17_to_22.py    # 17→22 关键点转换脚本
├── build_coco_dataset.py  # SAM3 分割结果 → COCO 格式
├── run.py                 # 入口文件
└── requirements.txt
```
