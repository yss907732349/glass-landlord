# 开源参考与第三方组件

本项目的斗地主牌型裁判为 TypeScript 独立实现。实现时阅读并参考了以下开源项目的牌型分类与规则组织方式，没有直接复制其源文件：

- **DouZero** — https://github.com/kwai/DouZero ，Apache License 2.0。参考文件：`douzero/env/move_detector.py`。原项目许可证：https://github.com/kwai/DouZero/blob/main/LICENSE 。
- **RLCard** — https://github.com/datamllab/rlcard ，MIT License。用于规则对照。原项目许可证：https://github.com/datamllab/rlcard/blob/master/LICENSE.md 。

本项目明确采用的变体：四带二单允许带一对；四带两对要求两个不同点数的对子；飞机单翼允许重复点数，但翼不能使用主干的点数；顺子、连对、飞机主干不包含2和王。普通炸弹固定四张，额外生成的重复点数不会形成五张及以上炸弹。赖子只可替代3至A，单出按3，不参与炸弹或王炸。

React、React DOM、Vite、TypeScript、Electron、ws 及开发打包工具依各自软件包内许可证使用；发布包保留所包含依赖的许可证文件。Electron 的第三方声明随其运行时分发。
