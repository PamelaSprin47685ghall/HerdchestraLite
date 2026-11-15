# Ticket Station Method（工单服务站方法）

## 0 摘要

本方法面向单进程事件驱动扩展（如 IDE 插件、Agent Runtime、宿主 Hook 系统），将**状态互斥**与**异步流程**彻底正交拆解：

- **服务台（Station）**：持有状态，所有方法必须为**纯同步普通函数（严禁 `async`/`await`）**。服务台只做轻量的状态跃迁与 **Promise Manipulation**（创建、组合、转交 Promise），绝不等待实际工作。
- **工单（Ticket）**：承载一次完整的异步流程，以 **协程语义（`async` 函数）** 实现，统一返回 Promise。实际的重活与全部等待都在工单中发生。
- **工单能力（Ticket Capability）**：即工单函数本身，通过参数或接线层单跳组装注入；未获得该能力的服务台不能创建工单。

系统不设中心协调者、消息总线、邮箱或事件溯源。状态归服务台，流程归工单，能力靠传递，组装靠接线。

---

## 1 问题背景

事件驱动扩展中常见三类腐化：

1. **控制流碎裂**：外部事件层层回调，异步逻辑与状态判断绞在一起，无法通读；
2. **状态幽灵化**：状态散落在闭包、全局表与事件日志中，并发到达时出现竞态与脏写；
3. **调度器膨胀**：为解决串行与协调引入锁、队列和中心调度器，最终中心调度器演化为失控的“第二套状态机”。

本方法用极简边界切断三者耦合：**服务台管状态且绝不挂起，工单管流程且不持有共享状态。**

---

## 2 第一性原理

### 2.1 服务台（Station）

服务台是一个有状态对象，其全部方法遵循一条铁律：**必须为纯同步普通函数，禁止使用 `async` 或 `await`。**

- **天然互斥**：在 JS/TS 单线程事件循环的 Run-to-Completion（运行至完成）语义下，同步函数从调用到返回不会被任何并发事件打断，天然具备原子性与串行互斥——无需额外的 CAS、锁、异步排队包装器，也不会产生 Promise 扁平化锁死或自重入死锁。
- **轻量处理**：服务台只做两件事——同步读写自身状态，以及操纵工单返回的 Promise（发起、`Promise.all` 组合、直接返回或丢弃）。
- **尾位置开单**：因为 JS 中 `async` 工单函数在遇到第一个 `await` 之前会同步执行，服务台方法**必须先完成全部自身状态变更，再于函数尾部调用工单函数**，防止工单的同步前缀观测到半更新状态。

> 注：若将本方法移植到多线程运行时，只需用普通同步互斥锁保护“状态变更 + 开单返回”这一微秒级临界区，同样绝不持锁等待工单完成。

### 2.2 工单（Ticket）

工单是一次协程调用（`async` 函数）：

- **并发且无持久态**：多张工单可并发执行；工单的局部状态保存在函数帧内，工单结束即自然消亡。
- **唯一的等待区**：工单是整个系统中唯一允许 `await` 的位置（如 `task`、shell、网络请求、磁盘或宿主异步 API）。
- **结果凭证**：工单统一返回 `Promise`，Promise 代表异步结果的凭证，而不是回调注册机制。
- **协作式取消**：工单不通过外部“工单表”强杀，而是依靠协程自检实现自我取消——当业务需要取消时，外部通过服务台方法修改领域状态（如递增 `epoch` 或置位 `aborted`），工单在各阶段恢复执行时向服务台校验状态，发现失效便自行退出。若需立刻打断正卡在慢 I/O（如子进程、长连接）上的挂起态 `await`，则由服务台在领域实体上持有领域级 `AbortController`，并将 `signal` 传入工单。

### 2.3 工单能力（Ticket Capability）

工单能力就是具体的工单函数。调用服务台方法时将其作为参数传入，服务台才能创建该工单；未传入则无权创建。

能力注入遵循**单跳可见性（管子不管孙）**：上层工单只关心自己需要触发的子工单能力，无需替下游层层透传孙工单能力。子工单所需的下游服务台与孙工单能力，由接线层在组装阶段直接绑定到子工单内部。

### 2.4 无中心协调者

系统不存在中心协调者、消息总线、邮箱或事件溯源。服务台之间互不认识、互不引用，各自管好自身状态；跨服务台的协同流程全部由短命的工单协程在运行期串联完成。

---

## 3 基本规则

1. **服务台严禁 `async`，且不等待工单。**
   服务台调用工单函数取得 Promise 后，在完成状态处理后立即结束：
   - **有返回值的事件**：将 Promise（或组合后的 Promise）直接交还给外部调用方；
   - **无返回值的事件**：服务台不再持有该 Promise，工单仅靠副作用产生业务结果，且外层**必须带有 catch-all 异常兜底**（确保错误在工单边界内消化记录，绝不逃逸为未捕获异常）；
   - **流程中后台开单**：将工单返回的 Promise 交还给上层调用方工单。
   - 服务台绝不记录请求台账或维护在途工单表。
2. **服务台只做轻量级处理，工单承担全部真实工作。**
   任何涉及 I/O、异步宿主 API 或耗时等待的操作，哪怕耗时极短，也一律放进工单。服务台内部绝不出现 `async`/`await`。
3. **工单不调用事件入口，服务台之间互不 `import`。**
   工单只同步调用服务台方法及异步外部能力；服务台之间仅通过工单与注入的能力发生间接协作。

### 3.1 接线（Wiring）

服务台与工单本身不直接耦合具体宿主环境与组装关系，一切连接由接线层在启动时完成。

接线层只允许做**纯机械动作**：
- 实例化各个服务台；
- 将宿主外部能力注入服务台与工单工厂；
- 按单跳依赖组装工单函数（并为无返回值工单统一包裹 catch-all 安全壳）；
- 将外部事件绑定到对应的服务台事件入口（Gatekeeper），并注入其所需的工单能力；
- 执行启动与停止。

**严禁在接线层编写任何业务逻辑**：不得根据阶段、工具名、任务状态做分支路由，不得改写请求或响应，不得持有领域状态。一旦接线里出现条件分支，它就退化成了**“影子前台”**——表面上在做装配，实际上在替服务台做决策，分层随之崩塌。

**检验标准**：把接线代码删掉，只看服务台与工单，全部业务语义应当依然完整；接线只负责让它们通电连通。

---

## 4 事件处理

外部事件是系统的唯一驱动源。每种外部事件对应某个服务台上的一个专用事件入口（Gatekeeper）方法。事件入口本身也是普通同步函数，负责将一次事件翻译为 **0 张、1 张或 N 张**工单：

- **0 张**：当前服务台凭自身状态即可直接吸收或忽略该事件（本地早退）。
- **1 张**：标准路径。**需要跨多个服务台联合判断才能决定是否继续的场景，同样直接开出 1 张工单**：由工单协程进去依次查询相关服务台状态，若条件不满足则直接早退 `return`，以极低开销换取服务台之间的零耦合。
- **N 张**：一个事件同时触发多个相互独立的并发流程，各工单之间并发执行。

返回值与异常处理策略：
- **有返回值的事件**：事件入口同步完成状态更新后，在尾部创建工单并返回组合 Promise（如 `Promise.all([...])`），由外部宿主调用方 `await`；服务台本身只做 Promise 组合，绝不等待。
- **无返回值的事件**：所有工单 fire-and-forget，依托服务台副作用或外部操作完成目标，并依赖强制的 catch-all 保护保证系统安全。

事件入口之间不相互调用；开单数量决定权与多单结果合并策略属于事件入口的翻译职责，接线层不得插手。

---

## 5 设计优势

- **规则可静态卡死**：“服务台禁止 `async`”是一条可被 ESLint/编译器直接检验的硬约束，杜绝团队协作中“什么算长时任务”的口水仗。
- **零锁、零死锁、零竞态**：依托单线程同步执行与尾位置开单，服务台天然原子互斥；既没有异步锁开销，也彻底免疫了 Promise 自动扁平化锁死与重入死锁。
- **调用顺滑**：工单调用服务台时全是直观的同步调用，没有冗余的 `await` 噪音。
- **能力边界清晰**：权限通过函数参数显式授予，单跳组装避免参数钻取；测试服务台时只需传入桩函数即可完成全路径验证。
- **拒绝第二套状态机**：没有中心调度器与事件总线，系统复杂度不会随事件数量呈指数腐化。

---

## 6 代价与边界

- **极严格的异步隔离**：一旦某个宿主 API 是异步的（哪怕只是读一次本地小配置），就不能在服务台内部直接调用，必须推入工单。
- **跨异步间隙的状态需显式检验**：工单恢复执行时，服务台状态可能已被其他事件改写；跨阶段业务必须依赖服务台的显式状态或代际（Epoch）校验实现自检，不能靠闭包记忆。
- **非持久工作流**：工单是内存中的临时协程，进程重启即丢失；需要跨进程或跨重启存活的状态必须写入服务台或领域存储。
- **轻计算假设**：在单线程 JS/TS 下，服务台同步方法内禁止执行重 CPU 死循环，否则会阻塞事件循环。

---

## 7 反模式

- 在服务台方法中出现 `async` 或 `await`（或用异步队列包装服务台方法导致工单 Promise 被扁平化锁死）。
- 在服务台方法内先调用工单函数、再修改自身状态（将半更新状态暴露给工单的同步前缀）。
- 无返回值的 Fire-and-forget 工单未挂载 catch-all 异常边界。
- 服务台持有工单表、请求队列、事件日志或实现事件溯源。
- 服务台之间相互 `import`，或通过全局可变单例暗度陈仓。
- 用单一 `handle(event)` 加 `switch (event.kind)` 代替按事件划分的事件入口。
- 用回调注册代替返回或转交 Promise。
- 死板要求“一个事件只能开一张工单”，或开出多张后不定义组合/兜底语义。
- 为图省事在接线层加入业务判断与分支路由（影子前台）。
- 让上层工单接收并透传自己并不关心的孙工单能力（应由接线层在子工单处就近绑定）。
- 试图把工单实现为可恢复的持久状态机。

---

## 8 参考骨架（TypeScript）

```ts
// 1. 服务台：纯同步普通函数，禁止 async/await
export class SessionStation {
  private epoch = 0;
  private aborted = false;

  // Gatekeeper（有返回值）：同步完成状态处理后，在尾部开单并做 Promise Manipulation
  onBeforeTool(
    input: ToolInput,
    runPolicy: (snap: SessionSnapshot, input: ToolInput) => Promise<PolicyResult>,
    auditLog: (snap: SessionSnapshot, input: ToolInput) => Promise<void>,
  ): Promise<PolicyResult> {
    const snap: SessionSnapshot = { epoch: this.epoch, aborted: this.aborted };
    // 先改完自身状态，最后尾调用开单，不等待工单
    void auditLog(snap, input); // 无返回值工单已在接线层挂载 catch-all
    return runPolicy(snap, input);
  }

  // Gatekeeper（无返回值）：改变领域状态，让在途工单协程自检退出
  onCancel(notifyCancel: (epoch: number) => void): void {
    this.aborted = true;
    this.epoch += 1;
    notifyCancel(this.epoch);
  }

  // 供工单在各异步阶段之间同步自检
  isValidEpoch(epoch: number): boolean {
    return !this.aborted && this.epoch === epoch;
  }
}

// 2. 工单：async 协程，唯一允许 await 的地方，自检取消
export async function runPolicyTicket(
  station: SessionStation,
  auditStation: AuditStation,
  snap: SessionSnapshot,
  input: ToolInput,
  childNotifyTicket: () => Promise<void>, // 仅感知直接子工单
): Promise<PolicyResult> {
  // 跨台探测：若另一台状态不满足，直接早退
  if (!auditStation.isEnabled()) return { allow: true };

  // 耗时 I/O
  const decision = await fetchRemotePolicy(input);

  // 协程恢复后自检状态，失效则自我取消，不污染新状态
  if (!station.isValidEpoch(snap.epoch)) {
    return { allow: false, reason: 'stale' };
  }

  if (!decision.allow) {
    await childNotifyTicket();
  }
  return decision;
}

// 3. 接线层（Wiring）：纯机械组装，单跳绑定 + catch-all 兜底
export function wireExtension(host: HostApi, logger: Logger) {
  const session = new SessionStation();
  const audit = new AuditStation();

  // 无返回值工单统一包装安全壳
  const fireAndForget = <Args extends unknown[]>(
    fn: (...args: Args) => Promise<void>,
  ) => (...args: Args): void => {
    Promise.resolve().then(() => fn(...args)).catch((err) => logger.error(err));
  };

  // 单跳组装（子工单自带孙工单，上层无感知）
  const notifyGrandchild = () => sendTelemetryTicket(host);
  const childNotify = () => notifyUserTicket(host, notifyGrandchild);
  const runPolicy = (snap: SessionSnapshot, input: ToolInput) =>
    runPolicyTicket(session, audit, snap, input, childNotify);
  const auditLog = (snap: SessionSnapshot, input: ToolInput) =>
    writeAuditTicket(audit, snap, input);
  const safeNotifyCancel = fireAndForget((epoch: number) =>
    notifyCancelTicket(host, epoch),
  );

  // 机械绑定外部事件到 Gatekeeper
  const offBefore = host.onBeforeTool((input) =>
    session.onBeforeTool(input, runPolicy, (s, i) => {
      fireAndForget(auditLog)(s, i);
      return Promise.resolve();
    }),
  );
  const offCancel = host.onCancel(() => session.onCancel(safeNotifyCancel));

  return () => {
    offBefore();
    offCancel();
  };
}
```
```

*(注：骨架里 `onBeforeTool` 的 `auditLog` 参数你也可以在真实项目里直接用 `() => void` 类型来表达 Fire-and-forget 能力，这样连 `return Promise.resolve()` 都不需要，代码会更直观。)*