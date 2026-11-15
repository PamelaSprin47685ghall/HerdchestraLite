/*
 * S4 协调模型：同步服务台 + 0-N 异步工单 + 单看板 + 取消/epoch。
 * 简化：文件 I/O 用 ticket_state 表示；不运行 Spin，只作为可读模型。
 */

mtype = { REQ, APPLY, CANCEL, DONE, FAIL };

#define N 3

byte station_busy = 0;
byte board_version = 0;
byte ticket_state[N];
byte ticket_epoch[N];
byte request_epoch[N];
byte aborted[N];

chan station_req = [0] of { byte, byte, mtype };
chan ticket_done = [0] of { byte, byte, byte };

inline enter_station() {
  atomic { station_busy == 0 -> station_busy = 1 }
}

inline leave_station() {
  atomic { station_busy = 0 }
}

proctype Station() {
  byte i;
  byte e;
  mtype op;
  do
  :: station_req ? i, e, op ->
     enter_station();
     if
     :: op == REQ ->
        board_version++;
        ticket_epoch[i] = ticket_epoch[i] + 1;
        request_epoch[i] = e;
        ticket_state[i] = 1; /* running */
        /* 尾位置开工单：只记录状态，不 await */
     :: op == CANCEL ->
        aborted[i] = 1;
        if
        :: ticket_state[i] == 0 -> ticket_state[i] = 4 /* cancelled */
        :: ticket_state[i] == 1 -> ticket_state[i] = 4
        :: else -> skip
        fi
     :: op == APPLY ->
        board_version++;
        ticket_state[i] = 2 /* applied */
     fi
     leave_station()
  od
}

proctype Ticket(byte i) {
  do
  :: ticket_state[i] == 1 && aborted[i] == 0 ->
     atomic {
       if
       :: ticket_epoch[i] == request_epoch[i] ->
          board_version++;
          ticket_state[i] = 2; /* applied */
          ticket_done ! i, ticket_epoch[i], DONE
       :: else ->
          ticket_state[i] = 3; /* failed: stale epoch */
          ticket_done ! i, ticket_epoch[i], FAIL
       fi
     }
  :: aborted[i] == 1 ->
     atomic { ticket_state[i] = 4; ticket_done ! i, ticket_epoch[i], CANCEL }
  :: else -> skip
  od
}

proctype Client(byte i) {
  byte e;
  atomic {
    request_epoch[i] = ticket_epoch[i] + 1;
    e = request_epoch[i];
    station_req ! i, e, REQ
  }
  /* 客户端可以取消；取消与完成竞争 */
  if
  :: station_req ! i, e, CANCEL
  :: skip
  fi
}

init {
  byte i;
  atomic {
    for (i : 0 .. N-1) {
      ticket_state[i] = 0;
      ticket_epoch[i] = 0;
      request_epoch[i] = 0;
      aborted[i] = 0
    }
  }
  run Station();
  for (i : 0 .. N-1) {
    run Ticket(i);
    run Client(i)
  }
}

/* 安全性质（人工观察）：
 * 1. station_busy 同时最多为 1；
 * 2. board_version 单调递增；
 * 3. 过期 epoch 的工单只能进入 failed，不能 applied；
 * 4. aborted 后不产生 applied。
 *
 * Liveness（人工观察）：
 * 1. 每个 Ticket 最终进入 applied/failed/cancelled；
 * 2. Station 不永久占用；
 * 3. Client 的请求最终被处理。
 */
