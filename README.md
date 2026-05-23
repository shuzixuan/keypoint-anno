# Keypoint Annotation Tool

用于动物姿态关键点标注的 Web GUI 工具。目标格式为 22 关键点（DANNCE 骨架），支持两种输入方式：

- **有 ViTPose 预测**：17kp → 22kp 转换后人工纠正
- **纯人工标注**：从图片目录生成空数据集，从头标注

## 安装

```bash
pip install -r requirements.txt
pip install Pillow  # 纯人工标注模式下读取图片尺寸需要
```

## 使用方式

### 方式一：有 ViTPose 预测（纠正模式）

#### 1. 转换 17kp → 22kp

```bash
python convert_17_to_22.py -i viTPose_predictions.json -o dannce_22kp.json
```

ViTPose 原生输出 17 关键点（AP-10K），转换后为 22 关键点（DANNCE）。直接映射的点标记为 `predicted`，插值估算的点标记为 `interpolated`（橙色虚线外环，提醒人工确认）。

#### 2. 启动标注工具

```bash
python run.py \
  --images-dir data/images \
  --input dannce_22kp.json \
  --config config/dannce.json \
  --output corrected.json
```

浏览器打开 `http://127.0.0.1:8000`。

### 方式二：纯人工标注（无预测）

#### 1. 生成空数据集

```bash
python init_empty_dataset.py \
  --images-dir data/images \
  --config config/dannce.json \
  --output empty_22kp.json \
  --instances-per-image 2 \
  --recurse
```

| 参数 | 说明 |
|---|---|
| `--images-dir` | 图片目录 |
| `--config` | 关键点配置文件 |
| `--output` | 输出的空 COCO JSON |
| `--instances-per-image` | 每张图几个实例，默认 1 |
| `--recurse` | 递归扫描子目录 |
| `--pattern` | 文件匹配模式，默认 `*` |

#### 2. 启动标注

```bash
python run.py --images-dir data/images --input empty_22kp.json --config config/dannce.json
```

### 中断恢复

```bash
python run.py --images-dir data/images --resume corrected.json --config config/dannce.json
```

`--resume` 等价于 `--input X --output X`。所有进度持久化，重启后恢复。

### 参数速查

| 参数 | 说明 |
|---|---|
| `--images-dir` | 图片目录 |
| `--input` / `-i` | 输入的 COCO JSON |
| `--config` | 关键点配置（22kp: `config/dannce.json`，17kp: `config/ap10k.json`） |
| `--output` / `-o` | 输出路径 |
| `--resume` / `-r` | 中断恢复 |
| `--host` | 绑定 IP，默认 `127.0.0.1` |
| `--port` | 绑定端口，默认 `8000` |

## 界面说明

### 顶部工具栏
- `Save` / `Export` — 保存到文件 / 下载 JSON
- `Zoom + / - / Fit` — 缩放画布
- `Skeleton` / `Labels` — 切换骨架线和标签显示
- `Reviewed` — 标记当前图为已审核
- `Pred. / Est. / Corr.` — 关键点状态图例
- `Annotate / Review` — 模式切换

### 左侧图片列表
- 搜索框过滤文件名
- 已审核图片显示 ✓ 和绿色高亮
- 每张图显示实例数

### 右侧关键点边栏
- 标题显示进度 `Keypoints (15/22)`
- 每行：颜色圆点 + 名称 + 状态徽标 + 可见性指示 + 置信度
- **点击行** → 该关键点被选中锁定，鼠标移动不会切换
- **双击画布** → 在目标位置放置当前选中的点，然后自动跳下一个未标注点

列含义：

| 列 | 说明 |
|---|---|
| 颜色圆点 | 对应 config 中的颜色 |
| 名称 | 关键点名称 |
| P / E / C | 状态：Predicted（预测）/ Estimated（估算）/ Corrected（已修正） |
| 绿 / 橙 / 灰点 | 可见性：绿=v2 可见 / 橙=v1 遮挡 / 灰=v0 未标注 |
| 数字 | ViTPose 置信度（`~` 前缀表示仅有标注级分数） |

### 底部栏
- 翻图 + 跳转未审核
- 实例选择 / 新增 / 删除
- 置信度滑块（Review 模式下低置信度点变灰）
- 待审核计数

## 关键点状态与可见性

### 状态（P/E/C）

| 徽标 | 状态 | 含义 | 画布标记 |
|---|---|---|---|
| P（蓝） | `predicted` | ViTPose 直接预测，未动过 | 正常 |
| E（橙） | `interpolated` | 插值估算 / 未标注，需确认 | 橙色虚线外环 |
| C（绿） | `corrected` | 已手动拖拽/放置 | 绿色外环 + ✓ |

### 可见性（v 值）

| 边栏 | v 值 | 含义 | 画布显示 |
|---|---|---|---|
| 绿点 | v=2 | 可见 | 实心圆 |
| 橙点 | v=1 | 遮挡 | 虚线圆 |
| 灰点 | v=0 | 未标注 | 十字标记 |

按 `V` 键切换当前选中点的可见性（v=2 ↔ v=1）。

## 快速连续标注工作流

适用于纯人工标注或无 ViTPose 时：

1. 边栏点击第一个要标的点（或直接双击画布放置第一个 v=0 点）
2. 双击画布放置 → 自动跳到下一个未标注点
3. 继续双击 → 再跳到下一个...
4. 连续双击 22 次完成一个实例的所有关键点
5. 有偏差的点拖拽微调
6. 按 `V` 标记遮挡点
7. 按 `M` 标记已审核

有 ViTPose 预测时的工作流：

1. 观察置信度和状态，`interpolated` 点优先处理
2. 边栏选中 → 双击画布放置 / 拖拽已有位置调整
3. 确认无误后按 `M` 审核

## 快捷键

| 快捷键 | 操作 |
|---|---|
| `←` `→` | 上一张 / 下一张 |
| `0`–`9` | 选择实例 |
| `Tab` | 循环选中下一个已标注关键点 |
| `V` | 切换可见性（可见 ↔ 遮挡） |
| `Delete` | 隐藏当前关键点（重置 v=0） |
| `Ctrl+S` | 保存 |
| `Ctrl+Z` | 撤销 |
| `+` / `-` | 缩放 |
| `R` | 适应窗口 |
| `M` | 标记已审核 |
| `N` | 跳转下一张未审核 |
| 拖拽关键点 | 移动位置 |
| 拖拽空白 | 平移画布 |
| 滚轮 | 缩放 |
| 双击画布 | 放置当前选中点，自动跳下一个 |

## 自动保存

- 每 60 秒自动保存（有修改时）
- 切换图片时自动保存
- 关闭标签页/浏览器时自动保存（sendBeacon 保证不丢失）
- 手动 `Ctrl+S` 保存

## 目录结构

```
├── annotation_tool/          # 标注工具前后端
│   ├── app.py                # FastAPI 后端
│   ├── templates/            # HTML 模板
│   └── static/               # JS / CSS
├── config/
│   ├── ap10k.json            # 17 关键点配置
│   └── dannce.json           # 22 关键点配置（DANNCE 骨架）
├── convert_17_to_22.py       # 17→22 关键点转换脚本
├── init_empty_dataset.py     # 空数据集生成（纯人工标注用）
├── build_coco_dataset.py     # SAM3 分割结果 → COCO 格式
├── run.py                    # 入口文件
└── requirements.txt
```
