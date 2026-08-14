# 07 · TypeScript 学习路线

> 目标:用最短路径从不熟悉 TypeScript 达到"能在 `apps/pet` 里独立开发"。本路线只覆盖 pet 项目实际用到的部分,不追求语言全貌。所有结论基于本仓库当前代码。

## 1. 为什么这样学

pet 的技术栈决定学什么:

- TypeScript 6(仓库根 `package.json` 锁定 `typescript: ^6.0.3`),全仓库 `strict: true` + `noImplicitAny`;
- 全 ESM:本地相对导入必须带 `.ts` 后缀(`import { x } from './a.ts'`);
- Electron(main / preload / renderer)+ React + Zustand + XState + PixiJS;
- 复用 DSH client 包(`@deepseek-ai/dsh-client-connection/client`),接口面以类型定义为准。

本仓库本身就是教材:所有包都是 strict 模式、注释完整的小代码。按 语言核心 → 工程实践 → 项目栈 → 落地 四层推进。

## 2. 阶段 0:JS 前置检查(半天 ~ 1 周)

TS 是 JS 的超集。先确认 JS 基础:变量/函数/对象/数组、Promise / async-await、`import` / `export`。

- 已熟悉 JS:直接进入阶段 1。
- 不熟悉:通读 [MDN JavaScript Guide](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide),不用刷题。

## 3. 阶段 1:TS 核心语法(1 ~ 2 周)

按顺序读 [The TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)(有[官方中文版](https://www.typescriptlang.org/zh/docs/handbook/intro.html)),以下章节足够起步:

1. The Basics:类型标注、类型推断、`tsc` 编译
2. Everyday Types:基础类型、`interface` vs `type`、联合类型、字面量类型
3. Narrowing:类型收窄(`typeof`、`in`、判别联合)——**重点,仓库代码大量使用**
4. More on Functions:函数类型、重载
5. Object Types:可选 / 只读属性、索引签名
6. Generics:泛型与约束——**重点,DSH client 包全靠泛型**
7. Type Manipulation:`keyof`、`typeof`、索引访问、Utility Types(`Partial` / `Pick` / `Omit` / `Record` 等)

每节配合 [TypeScript Playground](https://www.typescriptlang.org/play) 练习,不要只读。

## 4. 阶段 2:工程实践(1 周)—— 本仓库当教材

语法会了之后,pet 真正需要的三样:

1. **strict 模式心智**:任何 `any` 都要解释为什么。精读小包 `packages/todo`、`packages/util`(零依赖、几百行),看 JSDoc、`assertNever`、`Branded<T>`(跨边界 id 的类型化)的用法。
2. **ESM + NodeNext 解析**:相对导入带 `.ts` 后缀,参考 `packages/client/connection/src/api-path.ts`。
3. **读类型定义**:doc 03 §6 要求"开工前先读这些类型的 .d.ts"。练法:打开 `packages/client/connection/src/` 的类型文件(构建产物在 `lib/types/`),不打开实现,只靠类型推导写出 `host.describe` 调用。

练习环境:在 `apps/pet` 下建 `scratch.ts`,运行方式见[附录 A](#附录-a练习环境)。

## 5. 阶段 3:pet 技术栈按需学(边做边学)

| 技术 | 最小学习内容 | 用在哪 |
|---|---|---|
| Node.js | `fetch` / `WebSocket` / 进程概念 | 主进程连 DSH |
| Electron | 主进程 / preload / renderer 三进程模型 + `contextBridge` | 应用骨架 |
| React + TS | 函数组件、`useState` / `useEffect`、props 类型 | renderer |
| Zustand | `create<T>()(...)` 写法 | 状态共享 |
| XState | 最小 `createMachine`(见 doc 05 §6 骨架) | 宠物状态机 |
| DSH client | `WebApiClient` + `ConnectionController` 构造参数(读类型定义) | 客户端层 |

不要提前学完整 React 生态(路由、服务端组件等),pet 用不到。

## 6. 阶段 4:落地 = doc 05 §8 的开工顺序

doc 05 §8 本身就是项目型练习:

1. 连通性 PoC:renderer 里 `WebApiClient` + `host.describe` + 订阅两条 WS,打印帧
2. 跑通一条 session 操作(如列会话)
3. 窗口 / 托盘 / preload / PixiJS
4. MCP server

每步是"查类型 → 写代码 → typecheck → 跑通"的循环。

## 7. 资源清单

| 资源 | 用途 |
|---|---|
| [TypeScript Handbook(英文)](https://www.typescriptlang.org/docs/handbook/intro.html) | 阶段 1 主线,权威 |
| [TypeScript Handbook(官方中文)](https://www.typescriptlang.org/zh/docs/handbook/intro.html) | 阶段 1 主线,中文 |
| [TypeScript for the New Programmer](https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html) | 编程新手入口([中文版](https://www.typescriptlang.org/zh/docs/handbook/typescript-from-scratch.html)) |
| [TypeScript Tooling in 5 minutes](https://www.typescriptlang.org/docs/handbook/typescript-tooling-in-5-minutes.html) | 了解 `tsc` / 编辑器集成 |
| [TypeScript Playground](https://www.typescriptlang.org/play) | 语法即时练习 |
| [阮一峰 TypeScript 教程](https://wangdoc.com/typescript/) | 免费中文通读,比官方中文更口语化 |
| [TypeScript Deep Dive](https://basarat.gitbook.io/typescript) | 进阶,阶段 2 之后 |
| 《Effective TypeScript》第 2 版(Dan Vanderkam) | 实战法则,阶段 2 之后读收获最大 |
| [MDN JavaScript Guide](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide) | 阶段 0 前置 |

## 8. 里程碑自检

- **M1**:能独立写 50 行带泛型的函数,`tsc --noEmit --strict` 一次通过
- **M2**:不打开实现、只读类型定义,能写出 `ConnectionController` 的完整装配代码
- **M3**:PoC 连通(宠物打印出 `host.describe` 的返回)

达到 M3 即具备开工能力,剩余栈边做边学。

## 9. 版本说明

仓库锁定 TypeScript 6.0(`^6.0.3`)。TS 6.0 是最后一个 JavaScript 实现的版本,7.0 将换 Go 原生编译器;不影响本路线的学习内容。

## 附录 A:练习环境

```bash
# 仓库根已装 tsx(devDependencies: tsx ^4.22.4);在 apps/pet 下运行
pnpm exec tsx ./scratch.ts                 # 直接运行单个 .ts 文件
pnpm exec tsc --noEmit --strict ./scratch.ts   # 严格模式类型检查单个文件
```

说明:Node ≥ 24 原生支持直接运行 `.ts`(默认启用类型擦除);Node 22.x 需 `--experimental-strip-types`。统一用 tsx 与仓库工具链一致(仓库引擎:node `^22.19 || >=24`)。
