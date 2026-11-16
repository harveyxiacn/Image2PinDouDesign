import { useEffect } from "react";

export const LEAVE_MESSAGE = "有尚未保存的内容，离开后会丢失。确定要离开吗？";

/** 路由守卫的核心逻辑（与 DOM 解耦，便于单元测试）。 */
export type HashEnv = { hash: () => string; setHash: (h: string) => void; confirm: (msg: string) => boolean };

export function createHashGuard(env: HashEnv, message: string = LEAVE_MESSAGE) {
  let accepted = env.hash();
  let restoring = false;
  return {
    /** 绑定到 hashchange。返回 true 表示放行，false 表示已还原到上一个地址。 */
    onChange(): boolean {
      if (restoring) { restoring = false; return true; } // 这是我们自己还原地址触发的事件
      const now = env.hash();
      if (now === accepted) return true;
      if (env.confirm(message)) { accepted = now; return true; }
      restoring = true;
      env.setHash(accepted);
      return false;
    }
  };
}

/** 有未保存内容时：关闭 / 刷新页面、以及站内（hash 路由）跳转前都先确认。 */
export function useLeaveGuard(active: boolean, message: string = LEAVE_MESSAGE): void {
  useEffect(() => {
    if (!active) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const guard = createHashGuard({
      hash: () => window.location.hash,
      setHash: (h) => { window.location.hash = h; },
      confirm: (m) => window.confirm(m)
    }, message);
    const onHash = () => { guard.onChange(); };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("hashchange", onHash);
    };
  }, [active, message]);
}
